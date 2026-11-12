import * as cheerio from "cheerio";
import {
  formatLocation,
  formatLocationText,
  greenhouseJobApiUrl,
  greenhouseJobLocations,
  jobPostingLocations,
  uniqueLocations
} from "./job-location.js";
import type { JobPage, PageStructuredData } from "./types.js";

const TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "igshid", "ref", "source", "utm_campaign",
  "utm_content", "utm_medium", "utm_source", "utm_term"
]);

export function canonicalizeUrl(raw: string): string | null {
  try {
    let url = new URL(raw);
    if (url.hostname === "l.instagram.com") {
      const wrapped = url.searchParams.get("u");
      if (wrapped) url = new URL(wrapped);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    const privateHost =
      host === "localhost" || host === "::1" || host.startsWith("127.") ||
      host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.");
    if (privateHost) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isExternalUrl(raw: string): boolean {
  const canonical = canonicalizeUrl(raw);
  if (!canonical) return false;
  const host = new URL(canonical).hostname.toLowerCase();
  const platformDomains = [
    "instagram.com",
    "cdninstagram.com",
    "facebook.com",
    "fbcdn.net",
    "meta.com",
    "threads.com",
    "threads.net"
  ];
  return !platformDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Collects JobPosting locations into `locations` while it walks the JSON-LD.
function structuredRecords(value: unknown, locations: string[] = []): PageStructuredData[] {
  const records: PageStructuredData[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    const types = Array.isArray(object["@type"])
      ? object["@type"].filter((type): type is string => typeof type === "string")
      : typeof object["@type"] === "string" ? [object["@type"]] : [];
    const organization = object.hiringOrganization;
    const organizationName = typeof organization === "string"
      ? organization
      : organization && typeof organization === "object"
        ? textValue((organization as Record<string, unknown>).name)
        : undefined;
    const employment = object.employmentType;
    const employmentType = Array.isArray(employment)
      ? employment.filter((item): item is string => typeof item === "string")
      : typeof employment === "string" ? [employment] : undefined;
    if (types.some((type) => type.toLowerCase() === "jobposting")) locations.push(...jobPostingLocations(object));
    for (const type of types) {
      records.push({
        type,
        title: textValue(object.title) ?? textValue(object.name),
        organizationName,
        employmentType,
        datePosted: textValue(object.datePosted),
        validThrough: textValue(object.validThrough),
        startDate: textValue(object.startDate),
        endDate: textValue(object.endDate)
      });
    }
    if (object["@graph"]) visit(object["@graph"]);
  };
  visit(value);
  return records.slice(0, 100);
}

// schema.org microdata: itemprop="jobLocation" elements and their address fields.
function microdataLocations($: cheerio.CheerioAPI): string[] {
  return uniqueLocations($('[itemprop="jobLocation"]').toArray().flatMap((element) => {
    const place = $(element);
    const field = (name: string): string => {
      const node = place.find(`[itemprop="${name}"]`).first();
      return (node.attr("content") ?? node.text()).replace(/\s+/g, " ").trim();
    };
    const fromFields = formatLocation({
      locality: field("addressLocality"),
      region: field("addressRegion"),
      country: field("addressCountry")
    });
    if (fromFields) return [fromFields];
    const formatted = place.find("[formattedaddress]").first().attr("formattedaddress");
    return formatLocationText(formatted ?? place.text().replace(/\s+/g, " ").trim());
  }));
}

export function parseJobPageHtml(html: string, requestedUrl: string, finalUrl = requestedUrl): JobPage {
  const $ = cheerio.load(html.slice(0, 3_000_000));
  const jsonLdLocations: string[] = [];
  const structuredData = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((script) => {
      try {
        return structuredRecords(JSON.parse($(script).text()), jsonLdLocations);
      } catch {
        return [];
      }
    });
  const locations = jsonLdLocations.length ? uniqueLocations(jsonLdLocations) : microdataLocations($);
  const openGraphTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";
  const headingTitle = $("h1").first().text().replace(/\s+/g, " ").trim();
  const documentTitle = $("title").first().text().replace(/\s+/g, " ").trim();
  const structuredJobTitle = structuredData.find((item) => item.type.toLowerCase() === "jobposting")?.title ?? "";
  const description = $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() || "";
  $("script, style, noscript, svg").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 100_000);
  return {
    requestedUrl,
    finalUrl,
    title: structuredJobTitle || headingTitle || openGraphTitle || documentTitle,
    description,
    bodyText,
    fetchSucceeded: true,
    openGraphTitle,
    headingTitle,
    documentTitle,
    structuredData,
    locations
  };
}

// Greenhouse boards publish no structured location, so ask the board's job API.
// Any failure leaves the page as it was.
async function withGreenhouseLocations(page: JobPage): Promise<JobPage> {
  if (page.locations?.length) return page;
  const apiUrl = greenhouseJobApiUrl(page.finalUrl) ?? greenhouseJobApiUrl(page.requestedUrl);
  if (!apiUrl) return page;
  try {
    const response = await fetch(apiUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PersonalJobLinkMonitor/1.0)",
        Accept: "application/json"
      }
    });
    if (!response.ok) return page;
    const locations = greenhouseJobLocations(await response.json());
    return locations.length ? { ...page, locations } : page;
  } catch {
    return page;
  }
}

export async function fetchJobPage(rawUrl: string): Promise<JobPage> {
  const canonical = canonicalizeUrl(rawUrl);
  if (!canonical) throw new Error(`Unsafe or invalid URL: ${rawUrl}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(canonical, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PersonalJobLinkMonitor/1.0)",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!response.ok) throw new Error(`Job page returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    const page = parseJobPageHtml(
      await response.text(),
      canonical,
      canonicalizeUrl(response.url) ?? canonical
    );
    return await withGreenhouseLocations(page);
  } catch (error) {
    return {
      requestedUrl: canonical,
      finalUrl: canonical,
      title: "Unclassified job link",
      description: error instanceof Error ? error.message : String(error),
      bodyText: "",
      fetchSucceeded: false
    };
  } finally {
    clearTimeout(timeout);
  }
}
