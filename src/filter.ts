import type { FilterConfig, JobPage, MatchResult } from "./types.js";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9+.#/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matches(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(normalize(term)));
}

export function classifyJob(
  job: JobPage,
  storyText: string,
  filters: FilterConfig
): MatchResult {
  const combined = normalize(
    [job.title, job.description, job.bodyText, job.finalUrl, storyText].join(" ")
  );
  const evidence = {
    seasons: matches(combined, filters.seasons),
    internshipYears: matches(combined, filters.internshipYears),
    employmentTypes: matches(combined, filters.employmentTypes),
    newGradTerms: matches(combined, filters.newGradTerms),
    newGradYears: matches(combined, filters.newGradYears),
    roles: matches(combined, filters.roles),
    excluded: matches(combined, filters.exclude)
  };
  const groupPassed = (configured: string[], found: string[]) =>
    configured.length === 0 || found.length > 0;
  const internshipMatched =
    filters.employmentTypes.length > 0 &&
    evidence.employmentTypes.length > 0 &&
    groupPassed(filters.internshipYears, evidence.internshipYears) &&
    groupPassed(filters.seasons, evidence.seasons);

  const newGradMatched =
    filters.newGradTerms.length > 0 &&
    evidence.newGradTerms.length > 0 &&
    groupPassed(filters.newGradYears, evidence.newGradYears);

  const matched =
    groupPassed(filters.roles, evidence.roles) &&
    (internshipMatched || newGradMatched) &&
    evidence.excluded.length === 0;

  return { matched, uncertain: !job.fetchSucceeded, evidence };
}
