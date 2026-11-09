import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// Job listings whose earliest sighting is inside the retention window, one per
// job URL, newest first.
export function buildFeed(jobs: FeedSourceJob[], options: FeedBuildOptions): FeedListing[] {
  const cutoff = retentionCutoff(options);
  const source = `instagram:${options.creatorUsername}`;
  const byUrl = new Map<string, { listing: FeedListing; firstSeen: number }>();
  for (const job of jobs) {
    if (job.contentKind !== "Job Listing") continue;
    const firstSeen = Date.parse(job.firstSeenAt);
    if (!Number.isFinite(firstSeen)) continue;
    // Sticker links are often shorteners; the fetched page's URL identifies the job.
    const url = canonicalizeUrl(job.finalUrl) ?? job.canonicalUrl;
    const existing = byUrl.get(url);
    if (!existing || firstSeen < existing.firstSeen) {
      byUrl.set(url, { listing: toListing(job, url, Math.floor(firstSeen / 1000), source), firstSeen });
    }
  }
  return [...byUrl.values()]
    .filter((entry) => entry.firstSeen >= cutoff)
    .map((entry) => entry.listing)
    .sort((a, b) => b.date_posted - a.date_posted || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

// Byte-stable output: identical listings always serialize to identical text.
export function serializeFeed(listings: FeedListing[]): string {
  return `${JSON.stringify(listings, null, 2)}\n`;
}

async function git(cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  try {
    const pending = execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env }
    });
    if (options.input !== undefined) pending.child.stdin?.end(options.input);
    return (await pending).stdout.trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed: ${stderr || (error as Error).message}`);
  }
}

const PUSH_RACE = /non-fast-forward|fetch first|cannot lock ref/;

// Publishes the feed as a new commit on top of the freshly fetched default
// branch, built with git plumbing. The working checkout, its HEAD, index and
// files are never touched.
async function publishFeed(
  repoDirectory: string,
  content: string
): Promise<Pick<FeedExportResult, "fileChanged" | "committed" | "pushed" | "skipped">> {
  const run = (...args: string[]) => git(repoDirectory, args);
  const remoteHead = await run("symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`).catch(() => "");
  const defaultBranch = remoteHead.startsWith(`${REMOTE}/`) ? remoteHead.slice(REMOTE.length + 1) : "";
  if (!defaultBranch) {
    return { fileChanged: false, committed: false, pushed: false, skipped: `cannot tell ${REMOTE}'s default branch; run "git remote set-head ${REMOTE} --auto"` };
  }

  await run("fetch", "--quiet", REMOTE, `refs/heads/${defaultBranch}`);
  const parent = await run("rev-parse", "--verify", "FETCH_HEAD^{commit}");
  const blob = await git(repoDirectory, ["hash-object", "-w", "--stdin"], { input: content });
  const published = await run("rev-parse", "--verify", "--quiet", `${parent}:${FEED_PATH}`).catch(() => "");
  if (published === blob) return { fileChanged: false, committed: false, pushed: false };

  const scratch = await mkdtemp(path.join(tmpdir(), "feed-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    await git(repoDirectory, ["read-tree", parent], { env });
    await git(repoDirectory, ["update-index", "--add", "--cacheinfo", `100644,${blob},${FEED_PATH}`], { env });
    const tree = await git(repoDirectory, ["write-tree"], { env });
    const commit = await run("commit-tree", tree, "-p", parent, "-m", COMMIT_MESSAGE);
    try {
      await run("push", "--quiet", REMOTE, `${commit}:refs/heads/${defaultBranch}`);
    } catch (error) {
      if (!PUSH_RACE.test((error as Error).message)) throw error;
      return { fileChanged: true, committed: true, pushed: false, skipped: `push to ${defaultBranch} was rejected because it moved; retrying next cycle` };
    }
    return { fileChanged: true, committed: true, pushed: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Runs after each poll cycle. With the export disabled it returns without
// reading the archive or calling git.
export async function exportFeed(
  archive: Pick<JobArchive, "listJobs">,
  options: FeedExportOptions
): Promise<FeedExportResult> {
  if (!options.enabled) return { enabled: false, listings: 0, fileChanged: false, committed: false, pushed: false };

  // No date filter in the query: retention depends on each URL's earliest sighting
  // across every link row, so older rows must stay visible to buildFeed.
  const jobs = archive.listJobs("", "all", LIST_JOBS_CAP, "Job Listing");
  const listings = buildFeed(jobs, options);
  const warning = jobs.length >= LIST_JOBS_CAP
    ? `feed query hit the ${LIST_JOBS_CAP}-row cap; the least recently seen listings may be missing`
    : undefined;
  const published = await publishFeed(options.repoDirectory, serializeFeed(listings));
  return { enabled: true, listings: listings.length, ...published, ...(warning ? { warning } : {}) };
}
