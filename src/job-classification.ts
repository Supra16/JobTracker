import type { PageStructuredData } from "./types.js";

export const CLASSIFICATION_VERSION = 3;

export type ContentKind =
  | "Job Listing"
  | "Event"
  | "Form"
  | "Program"
  | "Job Search"
  | "Resource"
  | "Unknown";

export type ClassificationConfidence = "High" | "Medium" | "Low";

export interface JobClassificationInput {
  title: string;
  openGraphTitle?: string;
  headingTitle?: string;
  documentTitle?: string;
  description: string;
  bodyText: string;
  url: string;
  structuredData?: PageStructuredData[];
}

export interface JobClassification {
  classificationVersion: number;
  contentKind: ContentKind;
  companyName: string;
  roleTitle: string;
  opportunityType: string;
  recruitingTerm: string;
  confidence: ClassificationConfidence;
  evidence: string[];
}

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function structuredType(input: JobClassificationInput, type: string): PageStructuredData | undefined {
  return input.structuredData?.find((item) => item.type.toLowerCase() === type.toLowerCase());
}

function titles(input: JobClassificationInput): string[] {
  const structuredJob = structuredType(input, "JobPosting")?.title;
  const structuredEvent = structuredType(input, "Event")?.title;
  return unique([
    structuredJob,
    structuredEvent,
    input.headingTitle,
    input.openGraphTitle,
    input.title,
    input.documentTitle
  ]);
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function inferContentKind(input: JobClassificationInput): {
  contentKind: ContentKind;
  confidence: ClassificationConfidence;
  evidence: string[];
} {
  const url = parseUrl(input.url);
  const host = url?.hostname.toLowerCase() ?? "";
  const pathname = url?.pathname.toLowerCase() ?? "";
  const primary = `${titles(input).join(" ")} ${input.url}`.toLowerCase();
  const concise = `${primary} ${input.description}`.toLowerCase();
  const evidence: string[] = [];

  if (structuredType(input, "JobPosting")) {
    return { contentKind: "Job Listing", confidence: "High", evidence: ["JSON-LD identifies a JobPosting"] };
  }
  if (structuredType(input, "Event")) {
    return { contentKind: "Event", confidence: "High", evidence: ["JSON-LD identifies an Event"] };
  }

  const formHost = /(?:forms\.gle|docs\.google\.com|typeform\.com|airtable\.com|formstack\.com|larkoffice\.com)$/i.test(host);
  const formPath = /(?:\/forms?\/|\/to\/|\/viewform\b|\/base\/form\/)/i.test(pathname);
  if (formHost && formPath) {
    return { contentKind: "Form", confidence: "High", evidence: ["URL is hosted by a form service"] };
  }

  const eventHost = /(?:eventbrite\.|brazenconnect\.com$|lu\.ma$|luma\.com$|meetup\.com$|events?\.zoom\.us$)/i.test(host);
  const eventWords = /\b(?:seminar|webinar|workshop|conference|info(?:rmation)? session|career fair|networking event|rsvp|register for (?:the|this) event)\b/i;
  if (eventHost || eventWords.test(primary)) {
    evidence.push(eventHost ? "URL is hosted by an event platform" : "Title or URL contains event language");
    return { contentKind: "Event", confidence: eventHost ? "High" : "Medium", evidence };
  }

  const jobSearchWords = /\b(?:job search results?|search jobs?|open positions?|all jobs|career opportunities)\b/i;
  const jobSearchPath = /(?:job-search|search-jobs|jobs\/search|careers\/search)/i.test(pathname);
  if (jobSearchWords.test(primary) || jobSearchPath) {
    return { contentKind: "Job Search", confidence: "High", evidence: ["Page is a collection or search result, not one position"] };
  }

  const programWords = /\b(?:first[ -]?gens? in tech|student program|career program|boot ?camp|accelerator program|mentorship program|scholarship program)\b/i;
  if (programWords.test(primary)) {
    return { contentKind: "Program", confidence: "High", evidence: ["Title or URL identifies a program"] };
  }

  const resourceHost = /(?:beehiiv\.com$|notion\.site$|resume\.lol$|substack\.com$)/i.test(host);
  const resourceWords = /\b(?:newsletter|template|guide|readme|cheat ?sheet|resource hub)\b/i;
  if (resourceHost || resourceWords.test(primary)) {
    return {
      contentKind: "Resource",
      confidence: resourceHost && resourceWords.test(primary) ? "High" : "Medium",
      evidence: [resourceHost ? "URL is hosted by a resource or publishing platform" : "Title identifies a resource"]
    };
  }

  const atsHost = /(?:ashbyhq\.com$|greenhouse\.io$|lever\.co$|smartrecruiters\.com$|myworkdayjobs\.com$|oraclecloud\.com$)/i.test(host);
  const jobDetailPath = /(?:\/job\/[^/]+|\/jobs\/\d+|\/jobdetail\b|candidateexperience.*\/job\/|\/position\/\d+)/i.test(pathname);
  const atsDetailPath = atsHost && pathPartsForClassification(url).length >= 2;
  const roleWords = /\b(?:software|developer|engineer|analyst|consultant|designer|product manager|researcher|intern|internship|co[ -]?op|new grad(?:uate)?|entry[ -]?level)\b/i;
  if (atsDetailPath || jobDetailPath) {
    evidence.push(atsHost ? "ATS job-detail URL" : "Company career job-detail URL");
    if (roleWords.test(primary)) evidence.push("Title contains a role or employment-type term");
    return { contentKind: "Job Listing", confidence: roleWords.test(primary) ? "High" : "Medium", evidence };
  }

  if (roleWords.test(primary) && /\b(?:apply|job|career|position|role)\b/i.test(concise)) {
    return {
      contentKind: "Job Listing",
      confidence: "Medium",
      evidence: ["Title contains a role and the page contains job-application language"]
    };
  }

  if (/\b(?:application form|apply here|submit (?:an|your) application)\b/i.test(concise) && /form/i.test(pathname)) {
    return { contentKind: "Form", confidence: "Medium", evidence: ["Page appears to be an application form without a job listing"] };
  }

  return { contentKind: "Unknown", confidence: "Low", evidence: ["No reliable job, event, form, program, search, or resource signal"] };
}

function inferCompany(input: JobClassificationInput): string {
  const structuredCompany = structuredType(input, "JobPosting")?.organizationName;
  if (structuredCompany) return clean(structuredCompany);

  const url = parseUrl(input.url);
  const host = url?.hostname.toLowerCase() ?? "";
  const pathParts = url?.pathname.split("/").filter(Boolean) ?? [];
  const searchable = `${titles(input).join(" ")} ${input.description} ${input.bodyText.slice(0, 20_000)}`;
  const knownBrands: Array<[RegExp, string]> = [
    [/capitalonecareers\.com$/, "Capital One"], [/hubspot\.com$/, "HubSpot"],
    [/vanguardjobs\.com$/, "Vanguard"], [/l3harris\.com$/, "L3Harris"],
    [/jobs\.sap\.com$/, "SAP"], [/geaerospace\.com$/, "GE Aerospace"],
    [/truist\.com$/, "Truist"], [/careers\.ibm\.com$/, "IBM"],
    [/jobs\.intuit\.com$/, "Intuit"], [/careers\.humana\.com$/, "Humana"],
    [/careers\.honeywell\.com$/, "Honeywell"], [/careers\.microsoft\.com$/, "Microsoft"]
  ];
  for (const [pattern, company] of knownBrands) if (pattern.test(host)) return company;
  if (/oraclecloud\.com$/.test(host) && /\bAmerican Express\b/i.test(searchable)) return "American Express";
  if (/jobs\.ashbyhq\.com$/.test(host) && pathParts[0]) return titleCase(pathParts[0]);
  if (/jobs\.smartrecruiters\.com$/.test(host) && pathParts[0]) return titleCase(pathParts[0]);
  if (/job-boards\.greenhouse\.io$/.test(host) && pathParts[0]) return titleCase(pathParts[0]);
  if (/myworkdayjobs\.com$/.test(host)) {
    const tenant = host.split(".")[0];
    if (tenant && !/^wd\d+$/i.test(tenant)) return titleCase(tenant);
  }
  const titleCompany = titles(input).join(" | ").match(/\bat\s+([^|]+?)(?:\s*\|.*)?$/i)?.[1]?.trim();
  if (titleCompany && titleCompany.length <= 60) return titleCompany;
  const meaningfulHost = host.replace(/^www\./, "").split(".")
    .filter((part) => !["jobs", "job", "careers", "career", "com", "org", "net", "io", "co", "app"].includes(part))[0];
  return meaningfulHost ? titleCase(meaningfulHost) : "Unknown company";
}

function bestTitle(input: JobClassificationInput): string {
  return titles(input)[0] ?? "Untitled link";
}

function pathPartsForClassification(url: URL | null): string[] {
  return url?.pathname.split("/").filter(Boolean) ?? [];
}

function inferRoleTitle(input: JobClassificationInput, kind: ContentKind, companyName: string): string {
  let value = bestTitle(input).split(/\s+\|\s+/)[0].trim();
  if (kind === "Job Listing") {
    value = value.replace(new RegExp(`\\s+at\\s+${companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "i"), "").trim();
  }
  return value || (kind === "Job Listing" ? "Untitled position" : "Untitled link");
}

function inferOpportunityType(input: JobClassificationInput, kind: ContentKind): string {
  if (kind !== "Job Listing") {
    return ({ Event: "Event", Form: "Form", Program: "Program", "Job Search": "Job Search", Resource: "Resource", Unknown: "Other" } as const)[kind];
  }
  const structuredEmployment = structuredType(input, "JobPosting")?.employmentType?.join(" ") ?? "";
  const primary = `${titles(input).join(" ")} ${input.url} ${structuredEmployment}`.toLowerCase();
  const classify = (text: string): string | null => {
    if (/\b(new grad(?:uate)?|new college grad|university grad(?:uate)?|graduate software|class of 20\d{2})\b/.test(text)) return "New Grad";
    if (/\b(co[ -]?op|cooperative education)\b/.test(text)) return "Co-op";
    if (/\b(intern|internship)\b/.test(text)) return "Internship";
    if (/\b(apprentice|apprenticeship)\b/.test(text)) return "Apprenticeship";
    if (/\b(entry[ -]?level|early career|campus hire|recent graduate)\b/.test(text)) return "Entry Level";
    if (/\b(full[ -]?time|permanent)\b/.test(text)) return "Full-Time";
    return null;
  };
  return classify(primary) ?? classify(`${input.description} ${input.bodyText.slice(0, 20_000)}`.toLowerCase()) ?? "Other";
}

function termFromText(source: string): string | null {
  const seasonFirst = source.match(/\b(spring|summer|fall|autumn|winter)\s*(?:[-–—/]|program|internship|co[ -]?op|class)?\s*(20\d{2})\b/i);
  if (seasonFirst) {
    const season = seasonFirst[1].toLowerCase() === "autumn" ? "Fall" : titleCase(seasonFirst[1]);
    return `${season} ${seasonFirst[2]}`;
  }
  const yearFirst = source.match(/\b(20\d{2})\s*(?:[-–—/]|program|internship|co[ -]?op|class)?\s*(spring|summer|fall|autumn|winter)\b/i);
  if (yearFirst) {
    const season = yearFirst[2].toLowerCase() === "autumn" ? "Fall" : titleCase(yearFirst[2]);
    return `${season} ${yearFirst[1]}`;
  }
  const season = source.match(/\b(spring|summer|fall|autumn|winter)\b/i)?.[1];
  const year = source.match(/\b(20\d{2})\b/)?.[1];
  if (season && year) return `${season.toLowerCase() === "autumn" ? "Fall" : titleCase(season)} ${year}`;
  return year ?? null;
}

function relevantBodyWindows(body: string): string[] {
  const windows: string[] = [];
  const pattern = /\b(?:intern(?:ship)?|co[ -]?op|new grad(?:uate)?|entry[ -]?level|software engineer|developer|analyst|researcher)\b/gi;
  for (const match of body.matchAll(pattern)) {
    const index = match.index ?? 0;
    windows.push(body.slice(Math.max(0, index - 120), Math.min(body.length, index + 180)));
    if (windows.length >= 12) break;
  }
  return windows;
}

function inferTerm(input: JobClassificationInput, kind: ContentKind): string {
  const structured = kind === "Event" ? structuredType(input, "Event")?.startDate : undefined;
  if (structured) {
    const date = new Date(structured);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  const reliableSources = [
    ...titles(input),
    input.url,
    ...(kind === "Job Listing" || kind === "Program" ? [input.description] : [])
  ];
  for (const source of reliableSources) {
    const term = termFromText(source);
    if (term) return term;
  }
  if (kind === "Job Listing") {
    for (const window of relevantBodyWindows(input.bodyText)) {
      if (/\b(?:former|previous|past|formerly|ran|ended|expired|copyright)\b/i.test(window)) continue;
      if (!/\b(?:hiring|seeking|apply|application|starts?|begins?|available|join|position|role|class of|graduat(?:e|ing))\b/i.test(window)) continue;
      const term = termFromText(window);
      if (term) return term;
    }
  }
  return "Unspecified";
}

export function classifyJobPresentation(input: JobClassificationInput): JobClassification {
  const kind = inferContentKind(input);
  const companyName = inferCompany(input);
  const opportunityType = inferOpportunityType(input, kind.contentKind);
  const recruitingTerm = inferTerm(input, kind.contentKind);
  const evidence = [...kind.evidence];
  if (opportunityType !== "Other" && opportunityType !== kind.contentKind) evidence.push(`Title or metadata indicates ${opportunityType}`);
  if (recruitingTerm !== "Unspecified") evidence.push(`Title, URL, metadata, or nearby role text indicates ${recruitingTerm}`);
  return {
    classificationVersion: CLASSIFICATION_VERSION,
    contentKind: kind.contentKind,
    companyName,
    roleTitle: inferRoleTitle(input, kind.contentKind, companyName),
    opportunityType,
    recruitingTerm,
    confidence: kind.confidence,
    evidence: [...new Set(evidence)]
  };
}
