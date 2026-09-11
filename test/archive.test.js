import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JobArchive } from "../dist/archive.js";
import { startDashboard } from "../dist/dashboard.js";

function fixtureStory(screenshotPath) {
  return {
    key: "story:987654321",
    storyUrl: "https://www.instagram.com/stories/example/987654321/",
    visibleText: "Software Engineer New Grad Class of 2027",
    links: ["https://jobs.example.com/role/123"],
    screenshotPath
  };
}

function fixtureJob() {
  return {
    requestedUrl: "https://jobs.example.com/role/123",
    finalUrl: "https://jobs.example.com/role/123",
    title: "Software Engineer, New Graduate",
    description: "A role for 2027 graduates.",
    bodyText: "Full job description and qualifications.",
    fetchSucceeded: true,
    openGraphTitle: "Software Engineer – New Grad 2027",
    headingTitle: "Software Engineer, New Graduate",
    documentTitle: "Example Careers",
    structuredData: [{
      type: "JobPosting",
      title: "Software Engineer, New Graduate",
      organizationName: "Example Labs",
      employmentType: ["FULL_TIME"]
    }]
  };
}

test("archives links, source Story context, occurrences, and survives reopening", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "job-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "jobs.sqlite");
  const screenshot = path.join(directory, "story.png");
  const story = fixtureStory(screenshot);
  const archive = await JobArchive.open(file);

  await archive.upsertStory(story, "example");
  const id = await archive.recordLink(
    story,
    "example",
    "https://jobs.example.com/role/123?utm_source=instagram",
    "https://jobs.example.com/role/123",
    fixtureJob()
  );
  await archive.recordLink(
    story,
    "example",
    "https://jobs.example.com/role/123?utm_source=instagram",
    "https://jobs.example.com/role/123"
  );

  assert.equal(archive.getStats().links, 1);
  assert.equal(archive.getStats().stories, 1);
  assert.equal(archive.getStats().fetched, 1);
  assert.equal(archive.listJobs()[0].occurrenceCount, 2);
  assert.equal(archive.getJob(id)?.sources[0].visibleText, story.visibleText);
  assert.equal(archive.getJob(id)?.contentKind, "Job Listing");
  assert.equal(archive.getJob(id)?.companyName, "Example Labs");
  assert.equal(archive.getJob(id)?.roleTitle, "Software Engineer, New Graduate");
  assert.equal(archive.getJob(id)?.classificationVersion, 3);
  assert.match(archive.getJob(id)?.evidence.join(" ") ?? "", /JobPosting/);
  assert.equal(archive.getTelegramNotification(id), null);
  await archive.recordTelegramNotification(id, "sent");
  assert.equal(archive.getTelegramNotification(id)?.status, "sent");
  await archive.close();

  const reopened = await JobArchive.open(file);
  assert.equal(reopened.listJobs("2027").length, 1);
  assert.equal(reopened.getJob(id)?.title, "Software Engineer, New Graduate");
  assert.equal(reopened.getJob(id)?.openGraphTitle, "Software Engineer – New Grad 2027");
  assert.equal(reopened.getJob(id)?.contentKind, "Job Listing");
  assert.equal(reopened.getTelegramNotification(id)?.status, "sent");
  await reopened.close();
});

test("serves the local dashboard and archive JSON API", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "job-dashboard-"));
  const artifacts = path.join(directory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const archive = await JobArchive.open(path.join(directory, "jobs.sqlite"));
  const server = await startDashboard(archive, 0, artifacts);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(origin, { headers: { Connection: "close" } }).then((response) => response.text());
  const stats = await fetch(`${origin}/api/stats`, { headers: { Connection: "close" } }).then((response) => response.json());
  assert.match(page, /Job Link Archive/);
  assert.match(page, /All content types/);
  assert.match(page, /Role \/ opportunity/);
  assert.equal(stats.links, 0);
});
