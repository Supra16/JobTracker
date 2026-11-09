import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { JobArchive } from "../dist/archive.js";
import { parseFeedExportSettings } from "../dist/config.js";
import { buildFeed, exportFeed, FEED_PATH, serializeFeed } from "../dist/feed-export.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

// Keep git away from the developer's global config, hooks, signing and credentials.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Feed Test",
  GIT_AUTHOR_EMAIL: "feed-test@example.invalid",
  GIT_COMMITTER_NAME: "Feed Test",
  GIT_COMMITTER_EMAIL: "feed-test@example.invalid"
});

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function story(key) {
  return {
    key,
    storyUrl: `https://www.instagram.com/stories/zero2sudo/${key}/`,
    visibleText: "",
    links: [],
    screenshotPath: ""
  };
}

function page(url, overrides = {}) {
  return {
    requestedUrl: url,
    finalUrl: url,
    title: "",
    description: "",
    bodyText: "",
    fetchSucceeded: true,
    ...overrides
  };
}

const newGradPage = page("https://jobs.example.com/role/123?utm_source=instagram", {
  title: "Software Engineer, New Graduate",
  openGraphTitle: "Software Engineer – New Grad 2027",
  structuredData: [{ type: "JobPosting", title: "Software Engineer, New Graduate", organizationName: "Example Labs" }]
});

// Story links that are not job listings, one per non-job content kind.
const nonJobLinks = [
  ["https://www.eventbrite.com/e/tech-mixer-1", { title: "Tech Networking Mixer" }],
  ["https://docs.google.com/forms/d/e/abc/viewform", { title: "Interest form" }],
  ["https://example.notion.site/Resume-Template", { title: "Resume Template" }],
  ["https://firstgen.example.org/apply", { title: "First Gen in Tech Student Program" }],
  ["https://blog.example.org/post", { title: "Thoughts on careers" }]
];

async function record(archive, storyKey, rawUrl, job) {
  return archive.recordLink(story(storyKey), "zero2sudo", rawUrl, rawUrl, job);
}

async function addInternship(archive, id) {
  const url = `https://job-boards.greenhouse.io/acme/jobs/${id}`;
  await record(archive, `story:${id}`, url, page(url, { title: "Software Engineering Intern, Fall 2026" }));
}

// Seeds a temporary archive: one new-grad job shared through two different
// shortener links, one internship, and one link of every non-job kind.
async function seedArchive(directory) {
  const archive = await JobArchive.open(path.join(directory, "jobs.sqlite"));
  await record(archive, "story:1", "https://bit.ly/ex-ng", newGradPage);
  await record(archive, "story:2", "https://tinyurl.com/ex-ng", { ...newGradPage, requestedUrl: "https://tinyurl.com/ex-ng" });
  await addInternship(archive, 456);
  for (const [url, overrides] of nonJobLinks) await record(archive, "story:3", url, page(url, overrides));
  return archive;
}

function summary(overrides) {
  return {
    canonicalUrl: "https://jobs.example.com/a",
    finalUrl: "https://jobs.example.com/a",
    firstSeenAt: "2026-11-01T12:00:00.000Z",
    contentKind: "Job Listing",
    companyName: "Example Labs",
    roleTitle: "Software Engineer",
    opportunityType: "Other",
    recruitingTerm: "Unspecified",
    ...overrides
  };
}

const feedOptions = { creatorUsername: "zero2sudo", retentionDays: 14 };

test("feed export is disabled by default and in .env.example", async () => {
  assert.deepEqual(parseFeedExportSettings({}), { enabled: false, retentionDays: 14 });
  assert.equal(parseFeedExportSettings({ FEED_EXPORT_ENABLED: "false", FEED_RETENTION_DAYS: "oops" }).enabled, false);
  const example = dotenv.parse(await readFile(new URL("../.env.example", import.meta.url)));
  assert.equal(parseFeedExportSettings(example).enabled, false);
  assert.deepEqual(parseFeedExportSettings({ ...example, FEED_EXPORT_ENABLED: "true" }), { enabled: true, retentionDays: 14 });
  assert.equal(parseFeedExportSettings({ FEED_EXPORT_ENABLED: "true", FEED_RETENTION_DAYS: "30" }).retentionDays, 30);
  assert.throws(() => parseFeedExportSettings({ FEED_EXPORT_ENABLED: "true", FEED_RETENTION_DAYS: "0" }), /FEED_RETENTION_DAYS/);
  assert.throws(() => parseFeedExportSettings({ FEED_EXPORT_ENABLED: "yes" }), /FEED_EXPORT_ENABLED/);
});

test("maps archived job listings to the feed contract and skips other content", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "feed-map-"));
  const archive = await seedArchive(directory);
  t.after(async () => {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  });

  const jobs = archive.listJobs();
  assert.deepEqual(
    [...new Set(jobs.map((job) => job.contentKind))].sort(),
    ["Event", "Form", "Job Listing", "Program", "Resource", "Unknown"]
  );
  const bitly = jobs.find((job) => job.canonicalUrl === "https://bit.ly/ex-ng");
  const internship = jobs.find((job) => job.canonicalUrl === "https://job-boards.greenhouse.io/acme/jobs/456");
  const feed = buildFeed(jobs, feedOptions);

  assert.deepEqual(feed, [
    {
      company_name: "Acme",
      title: "Software Engineering Intern, Fall 2026",
      url: "https://job-boards.greenhouse.io/acme/jobs/456",
      locations: [],
      date_posted: Math.floor(Date.parse(internship.firstSeenAt) / 1000),
      active: true,
      terms: ["Fall 2026"],
      level: "intern",
      source: "instagram:zero2sudo"
    },
    {
      company_name: "Example Labs",
      title: "Software Engineer, New Graduate",
      url: "https://jobs.example.com/role/123",
      locations: [],
      date_posted: Math.floor(Date.parse(bitly.firstSeenAt) / 1000),
      active: true,
      terms: ["2027"],
      level: "new grad",
      source: "instagram:zero2sudo"
    }
  ]);
  assert.ok(feed.every((listing) => !("category" in listing)));
});

test("deduplicates by job URL and keeps the first sighting", () => {
  const feed = buildFeed([
    summary({ canonicalUrl: "https://tinyurl.com/b", finalUrl: "https://jobs.example.com/a?utm_source=ig", firstSeenAt: "2026-11-03T00:00:00.000Z", roleTitle: "Later copy" }),
    summary({ canonicalUrl: "https://bit.ly/a", finalUrl: "https://jobs.example.com/a#apply", firstSeenAt: "2026-11-02T00:00:00.000Z", roleTitle: "First copy" }),
    summary({ canonicalUrl: "https://jobs.example.com/a" })
  ], { ...feedOptions, now: new Date("2026-11-04T00:00:00.000Z") });
  assert.equal(feed.length, 1);
  assert.equal(feed[0].url, "https://jobs.example.com/a");
  assert.equal(feed[0].title, "Software Engineer");
  assert.equal(feed[0].date_posted, Date.parse("2026-11-01T12:00:00.000Z") / 1000);
});

test("keeps only job listings inside the retention window, newest first", () => {
  const now = new Date("2026-11-20T00:00:00.000Z");
  const feed = buildFeed([
    summary({ finalUrl: "https://jobs.example.com/old", firstSeenAt: "2026-11-05T23:59:59.000Z" }),
    summary({ finalUrl: "https://jobs.example.com/edge", firstSeenAt: "2026-11-06T00:00:00.000Z" }),
    summary({ finalUrl: "https://jobs.example.com/new", firstSeenAt: "2026-11-19T00:00:00.000Z" }),
    summary({ finalUrl: "https://jobs.example.com/b-tie", firstSeenAt: "2026-11-10T00:00:00.000Z" }),
    summary({ finalUrl: "https://jobs.example.com/a-tie", firstSeenAt: "2026-11-10T00:00:00.400Z" }),
    summary({ finalUrl: "https://lu.ma/event", firstSeenAt: "2026-11-19T00:00:00.000Z", contentKind: "Event" }),
    summary({ finalUrl: "https://forms.gle/x", firstSeenAt: "2026-11-19T00:00:00.000Z", contentKind: "Form" }),
    summary({ finalUrl: "https://example.org/u", firstSeenAt: "2026-11-19T00:00:00.000Z", contentKind: "Unknown" })
  ], { ...feedOptions, now });
  assert.deepEqual(feed.map((listing) => listing.url.replace("https://jobs.example.com/", "")), ["new", "a-tie", "b-tie", "edge"]);
});

test("archived listings age out of the feed after the retention window", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "feed-retention-"));
  const archive = await seedArchive(directory);
  t.after(async () => {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  });
  const jobs = archive.listJobs();
  assert.equal(buildFeed(jobs, { ...feedOptions, now: new Date(Date.now() + 13 * DAY_MS) }).length, 2);
  assert.equal(buildFeed(jobs, { ...feedOptions, now: new Date(Date.now() + 15 * DAY_MS) }).length, 0);
  assert.equal(buildFeed(jobs, { ...feedOptions, retentionDays: 30, now: new Date(Date.now() + 15 * DAY_MS) }).length, 2);
});

test("retention uses the earliest sighting across all rows for one job URL", () => {
  const now = new Date("2026-11-20T00:00:00.000Z");
  const old = summary({ canonicalUrl: "https://bit.ly/a", finalUrl: "https://jobs.example.com/a", firstSeenAt: "2026-11-01T00:00:00.000Z" });
  const recent = summary({ canonicalUrl: "https://tinyurl.com/a", finalUrl: "https://jobs.example.com/a", firstSeenAt: "2026-11-18T00:00:00.000Z" });
  assert.deepEqual(buildFeed([recent, old], { ...feedOptions, now }), []);
  assert.deepEqual(buildFeed([old, recent], { ...feedOptions, now }), []);

  const both = buildFeed([recent, summary({ ...old, firstSeenAt: "2026-11-10T00:00:00.000Z" })], { ...feedOptions, now });
  assert.equal(both.length, 1);
  assert.equal(both[0].date_posted, Date.parse("2026-11-10T00:00:00.000Z") / 1000);
});

test("maps opportunity types to levels and omits unknown levels and terms", () => {
  const levels = ["New Grad", "Internship", "Co-op", "Entry Level", "Full-Time", "Other"].map((opportunityType, index) =>
    buildFeed([summary({ finalUrl: `https://jobs.example.com/${index}`, opportunityType })], { ...feedOptions, now: new Date("2026-11-02T00:00:00.000Z") })[0].level
  );
  assert.deepEqual(levels, ["new grad", "intern", "intern", undefined, undefined, undefined]);
  const [listing] = buildFeed([summary({})], { ...feedOptions, now: new Date("2026-11-02T00:00:00.000Z") });
  assert.ok(!("terms" in listing) && !("level" in listing));
  assert.equal(serializeFeed([listing]), serializeFeed([{ ...listing }]));
  assert.ok(serializeFeed([]).endsWith("]\n"));
});

async function setupRepository(directory) {
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const work = path.join(directory, "work");
  await git(directory, "init", "--quiet", "--bare", "-b", "main", remote);
  await git(directory, "init", "--quiet", "-b", "main", seed);
  await writeFile(path.join(seed, "README.md"), "seed\n");
  await git(seed, "add", "README.md");
  await git(seed, "commit", "--quiet", "-m", "init");
  await git(seed, "push", "--quiet", remote, "main");
  await git(directory, "clone", "--quiet", remote, work);
  return { remote, seed, work };
}

async function gitFixture(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const archive = await seedArchive(directory);
  const repository = await setupRepository(directory);
  t.after(async () => {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options = { enabled: true, retentionDays: 14, creatorUsername: "zero2sudo", repoDirectory: repository.work };
  return { archive, options, ...repository };
}

const commitCount = (repository) => git(repository, "rev-list", "--count", "main");

test("publishes the feed only when its content changes", async (t) => {
  const { archive, options, remote, work } = await gitFixture(t, "feed-git-");

  const first = await exportFeed(archive, options);
  assert.deepEqual(first, { enabled: true, listings: 2, fileChanged: true, committed: true, pushed: true });
  assert.equal(await commitCount(remote), "2");
  assert.equal(await git(remote, "show", "--name-only", "--format=", "main"), FEED_PATH);
  const published = JSON.parse(await git(remote, "show", `main:${FEED_PATH}`));
  assert.deepEqual(published.map((listing) => listing.url), [
    "https://job-boards.greenhouse.io/acme/jobs/456",
    "https://jobs.example.com/role/123"
  ]);

  const second = await exportFeed(archive, options);
  assert.deepEqual(second, { enabled: true, listings: 2, fileChanged: false, committed: false, pushed: false });
  assert.equal(await commitCount(remote), "2");

  await addInternship(archive, 789);
  const third = await exportFeed(archive, options);
  assert.deepEqual(third, { enabled: true, listings: 3, fileChanged: true, committed: true, pushed: true });
  assert.equal(await commitCount(remote), "3");

  assert.equal(await commitCount(work), "1");
  assert.equal(await git(work, "status", "--porcelain"), "");
  await assert.rejects(stat(path.join(work, "feed")), { code: "ENOENT" });
});

test("publishes on top of an origin that is ahead of the local clone", async (t) => {
  const { archive, options, remote, seed, work } = await gitFixture(t, "feed-ahead-");
  await writeFile(path.join(seed, "other.txt"), "upstream work\n");
  await git(seed, "add", "other.txt");
  await git(seed, "commit", "--quiet", "-m", "upstream");
  await git(seed, "push", "--quiet", remote, "main");
  const upstream = await git(remote, "rev-parse", "main");
  const localHead = await git(work, "rev-parse", "HEAD");

  const result = await exportFeed(archive, options);
  assert.equal(result.pushed, true);
  assert.equal(await commitCount(remote), "3");
  assert.equal(await git(remote, "rev-parse", "main~1"), upstream);
  assert.equal(await git(remote, "show", "main:other.txt"), "upstream work");
  assert.equal(await git(remote, "show", "--name-only", "--format=", "main"), FEED_PATH);
  assert.equal(await git(work, "rev-parse", "HEAD"), localHead);
  assert.equal(await git(work, "status", "--porcelain"), "");
});

test("leaves the checkout alone on any branch, with staged and unpushed work", async (t) => {
  const { archive, options, remote, work } = await gitFixture(t, "feed-checkout-");
  await git(work, "checkout", "--quiet", "-b", "feature");
  await writeFile(path.join(work, "local.txt"), "not ready\n");
  await git(work, "add", "local.txt");
  await git(work, "commit", "--quiet", "-m", "local change");
  await writeFile(path.join(work, "staged.txt"), "staged\n");
  await git(work, "add", "staged.txt");
  const head = await git(work, "rev-parse", "HEAD");

  const result = await exportFeed(archive, options);
  assert.equal(result.pushed, true);
  assert.equal(await git(work, "rev-parse", "HEAD"), head);
  assert.equal(await git(work, "branch", "--show-current"), "feature");
  assert.equal(await git(work, "status", "--porcelain"), "A  staged.txt");
  assert.equal(await git(remote, "show", "--name-only", "--format=", "main"), FEED_PATH);
  assert.equal(await commitCount(remote), "2");
});

test("a push race is logged as skipped and the next cycle publishes from a fresh fetch", async (t) => {
  const { archive, options, remote, seed } = await gitFixture(t, "feed-race-");
  await writeFile(path.join(seed, "raced.txt"), "landed mid-publish\n");
  await git(seed, "add", "raced.txt");
  await git(seed, "commit", "--quiet", "-m", "raced");
  await git(seed, "push", "--quiet", remote, "HEAD:refs/heads/raced");
  const raced = await git(remote, "rev-parse", "raced");
  const hook = path.join(remote, "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\nunset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit update-ref refs/heads/main ${raced}\n`, { mode: 0o755 });

  const first = await exportFeed(archive, options);
  assert.equal(first.pushed, false);
  assert.equal(first.committed, true);
  assert.match(first.skipped, /retrying next cycle/);
  assert.equal(await git(remote, "rev-parse", "main"), raced);

  await rm(hook);
  const second = await exportFeed(archive, options);
  assert.equal(second.pushed, true);
  assert.equal(await git(remote, "rev-parse", "main~1"), raced);
  assert.equal(await git(remote, "show", "--name-only", "--format=", "main"), FEED_PATH);
});

test("a failed fetch throws and the next cycle publishes", async (t) => {
  const { archive, options, remote } = await gitFixture(t, "feed-retry-");
  const offline = `${remote}-offline`;
  await rename(remote, offline);
  await assert.rejects(exportFeed(archive, options), /git fetch failed/);
  await rename(offline, remote);

  const retry = await exportFeed(archive, options);
  assert.deepEqual(retry, { enabled: true, listings: 2, fileChanged: true, committed: true, pushed: true });
  assert.equal(await commitCount(remote), "2");
});

test("warns when the archive query returns the 1000-row cap", async (t) => {
  const { options } = await gitFixture(t, "feed-cap-");
  const rows = Array.from({ length: 1000 }, (_, index) => summary({ finalUrl: `https://jobs.example.com/${index}`, firstSeenAt: new Date().toISOString() }));
  const result = await exportFeed({ listJobs: () => rows }, options);
  assert.equal(result.listings, 1000);
  assert.match(result.warning, /1000-row cap/);
});

test("disabled export leaves the archive and git untouched", async (t) => {
  const { options, work } = await gitFixture(t, "feed-disabled-");
  const untouchedArchive = { listJobs: () => assert.fail("disabled export must not read the archive") };

  const result = await exportFeed(untouchedArchive, { ...options, enabled: false });
  assert.deepEqual(result, { enabled: false, listings: 0, fileChanged: false, committed: false, pushed: false });
  assert.equal(await git(work, "status", "--porcelain"), "");
  assert.equal(await commitCount(work), "1");
});
