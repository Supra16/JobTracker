import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ArchivedJobSummary, JobArchive } from "./archive.js";
import { canonicalizeUrl } from "./job-page.js";
import type { FeedExportSettings } from "./types.js";

const execFileAsync = promisify(execFile);

// Repository-relative path, in git's forward-slash form.
export const FEED_PATH = "feed/listings.json";
const REMOTE = "origin";
const COMMIT_MESSAGE = "chore(feed): update listings.json";
const GIT_TIMEOUT_MS = 120_000;
const LIST_JOBS_CAP = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// One entry in the listings.json shape the downstream job tracker reads.
export interface FeedListing {
  company_name: string;
  title: string;
  url: string;
  locations: string[];
  date_posted: number;
  active: boolean;
  terms?: string[];
  level?: "new grad" | "intern";
  source: string;
}

export type FeedSourceJob = Pick<
  ArchivedJobSummary,
  "canonicalUrl" | "finalUrl" | "firstSeenAt" | "contentKind" | "companyName" |
  "roleTitle" | "opportunityType" | "recruitingTerm"
>;

export interface FeedBuildOptions {
  creatorUsername: string;
  retentionDays: number;
  now?: Date;
}

export interface FeedExportOptions extends FeedExportSettings {
  creatorUsername: string;
  repoDirectory: string;
  now?: Date;
}

export interface FeedExportResult {
  enabled: boolean;
  listings: number;
  fileChanged: boolean;
  committed: boolean;
  pushed: boolean;
  skipped?: string;
  warning?: string;
}

const LEVELS: Partial<Record<string, FeedListing["level"]>> = {
  "New Grad": "new grad",
  Internship: "intern",
  "Co-op": "intern"
};

function toListing(job: FeedSourceJob, url: string, datePosted: number, source: string): FeedListing {
  // The classifier has no role category (Software Engineering, Data, ...), so
  // `category` is omitted and the job tracker classifies by title instead.
  const listing: FeedListing = {
    company_name: job.companyName,
    title: job.roleTitle,
    url,
    locations: [],
    date_posted: datePosted,
    active: true,
    source
  };
  if (job.recruitingTerm && job.recruitingTerm !== "Unspecified") listing.terms = [job.recruitingTerm];
  const level = LEVELS[job.opportunityType];
  if (level) listing.level = level;
  return listing;
}

function retentionCutoff(options: { retentionDays: number; now?: Date }): number {
  return (options.now ?? new Date()).getTime() - options.retentionDays * DAY_MS;
}

// Job listings first seen inside the retention window, one per job URL, newest first.
export function buildFeed(jobs: FeedSourceJob[], options: FeedBuildOptions): FeedListing[] {
  const cutoff = retentionCutoff(options);
  const source = `instagram:${options.creatorUsername}`;
  const byUrl = new Map<string, FeedListing>();
  for (const job of jobs) {
    if (job.contentKind !== "Job Listing") continue;
    const firstSeen = Date.parse(job.firstSeenAt);
    if (!Number.isFinite(firstSeen) || firstSeen < cutoff) continue;
    // Sticker links are often shorteners; the fetched page's URL identifies the job.
    const url = canonicalizeUrl(job.finalUrl) ?? job.canonicalUrl;
    const listing = toListing(job, url, Math.floor(firstSeen / 1000), source);
    const existing = byUrl.get(url);
    if (!existing || listing.date_posted < existing.date_posted) byUrl.set(url, listing);
  }
  return [...byUrl.values()].sort((a, b) =>
    b.date_posted - a.date_posted || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
  );
}

// Byte-stable output: identical listings always serialize to identical text.
export function serializeFeed(listings: FeedListing[]): string {
  return `${JSON.stringify(listings, null, 2)}\n`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    return stdout.trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed: ${stderr || (error as Error).message}`);
  }
}

// Commits only the feed file on the default branch and pushes it. Pending feed
// commits are retried on later cycles; other unpushed work is never published.
async function publishFeed(repoDirectory: string): Promise<Pick<FeedExportResult, "committed" | "pushed" | "skipped">> {
  const run = (...args: string[]) => git(repoDirectory, args);
  const remoteHead = await run("symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`).catch(() => "");
  const defaultBranch = remoteHead.startsWith(`${REMOTE}/`) ? remoteHead.slice(REMOTE.length + 1) : "";
  if (!defaultBranch) {
    return { committed: false, pushed: false, skipped: `cannot tell ${REMOTE}'s default branch; run "git remote set-head ${REMOTE} --auto"` };
  }
  const branch = await run("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
  if (branch !== defaultBranch) {
    return { committed: false, pushed: false, skipped: `checkout is on ${branch || "a detached HEAD"}, not ${defaultBranch}; feed not committed` };
  }

  let committed = false;
  if (await run("status", "--porcelain", "--", FEED_PATH)) {
    await run("add", "--", FEED_PATH);
    await run("commit", "--quiet", "-m", COMMIT_MESSAGE, "--", FEED_PATH);
    committed = true;
  }

  const upstream = `${REMOTE}/${defaultBranch}`;
  const touched = (await run("log", "--format=", "--name-only", `${upstream}..HEAD`)).split("\n").filter(Boolean);
  if (touched.length === 0) return { committed, pushed: false };
  if (touched.some((file) => file !== FEED_PATH)) {
    return { committed, pushed: false, skipped: `${defaultBranch} has unpushed commits besides ${FEED_PATH}; push them to resume publishing` };
  }
  await run("push", "--quiet", REMOTE, `HEAD:refs/heads/${defaultBranch}`);
  return { committed, pushed: true };
}

// Runs after each poll cycle. With the export disabled it returns without
// reading the archive, writing files, or calling git.
export async function exportFeed(
  archive: Pick<JobArchive, "listJobs">,
  options: FeedExportOptions
): Promise<FeedExportResult> {
  if (!options.enabled) return { enabled: false, listings: 0, fileChanged: false, committed: false, pushed: false };

  const jobs = archive.listJobs("", "all", LIST_JOBS_CAP, "Job Listing", new Date(retentionCutoff(options)).toISOString());
  const listings = buildFeed(jobs, options);
  const warning = jobs.length >= LIST_JOBS_CAP
    ? `feed query hit the ${LIST_JOBS_CAP}-row cap; the oldest-seen listings in the window may be missing`
    : undefined;
  const content = serializeFeed(listings);
  const filePath = path.join(options.repoDirectory, ...FEED_PATH.split("/"));
  const current = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const fileChanged = current !== content;
  if (fileChanged) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  const published = await publishFeed(options.repoDirectory);
  return { enabled: true, listings: listings.length, fileChanged, ...published, ...(warning ? { warning } : {}) };
}
