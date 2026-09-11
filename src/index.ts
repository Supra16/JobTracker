import { mkdir } from "node:fs/promises";
import { JobArchive } from "./archive.js";
import { loadConfig } from "./config.js";
import { startDashboard } from "./dashboard.js";
import { classifyJob } from "./filter.js";
import { collectCurrentStories, openInstagram } from "./instagram.js";
import { classifyJobPresentation } from "./job-classification.js";
import { canonicalizeUrl, fetchJobPage } from "./job-page.js";
import { formatJobMessage, sendTelegramMessage } from "./telegram.js";
import type { JobPage, StoryObservation } from "./types.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const config = await loadConfig();
await mkdir(config.artifactDirectory, { recursive: true });
const archive = await JobArchive.open(config.databaseFile);
const session = await openInstagram(config);
const dashboard = await startDashboard(archive, config.dashboardPort, config.artifactDirectory);
console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);
const telegramEnabled = Boolean(config.telegramBotToken && config.telegramChatId);
console.log(`Telegram alerts: ${telegramEnabled ? "enabled" : "disabled (token or chat ID missing)"}`);
if (telegramEnabled) {
  console.log(`Telegram alert mode: ${config.alertAllNewLinks ? "all new Story links" : "matching filters only"}`);
}
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; closing browser...`);
  await session.context.close().catch(() => undefined);
  await new Promise<void>((resolve) => dashboard.close(() => resolve()));
  await archive.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function notifyIfEligible(jobId: number, story: StoryObservation, fetchedJob?: JobPage): Promise<void> {
  if (!telegramEnabled) return;
  const previous = archive.getTelegramNotification(jobId);
  if (previous && previous.status !== "error") return;

  const detail = archive.getJob(jobId);
  if (!detail) return;
  const job: JobPage = fetchedJob ?? {
    requestedUrl: detail.requestedUrl,
    finalUrl: detail.finalUrl,
    title: detail.title,
    description: detail.description,
    bodyText: detail.bodyText,
    fetchSucceeded: detail.fetchSucceeded,
    openGraphTitle: detail.openGraphTitle,
    headingTitle: detail.headingTitle,
    documentTitle: detail.documentTitle,
    structuredData: detail.structuredData
  };
  const result = classifyJob(job, story.visibleText, config.filters);
  const uncertain = result.uncertain;
  const classification = classifyJobPresentation({
    title: job.title,
    openGraphTitle: job.openGraphTitle,
    headingTitle: job.headingTitle,
    documentTitle: job.documentTitle,
    description: job.description,
    bodyText: job.bodyText,
    url: job.finalUrl,
    structuredData: job.structuredData
  });
  const contentEligible = classification.contentKind === "Job Listing";
  if (!config.alertAllNewLinks && (!contentEligible || (!result.matched && !(uncertain && config.notifyUncertain)))) {
    await archive.recordTelegramNotification(jobId, "filtered");
    console.log(`Telegram filtered link #${jobId}: ${classification.contentKind} · ${classification.companyName} · ${classification.opportunityType} · ${classification.recruitingTerm}`);
    return;
  }
  try {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      formatJobMessage(
        job,
        result,
        config.creatorUsername,
        uncertain,
        classification,
        config.alertAllNewLinks
      )
    );
    await archive.recordTelegramNotification(jobId, "sent");
    console.log(`Telegram alert sent for link #${jobId}: ${classification.contentKind} · ${classification.companyName} · ${classification.opportunityType} · ${classification.recruitingTerm}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await archive.recordTelegramNotification(jobId, "error", message);
    console.error(`Telegram alert failed for link #${jobId}; it will retry next cycle: ${message}`);
  }
}

async function runCycle(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Checking @${config.creatorUsername}`);
  const stories = await collectCurrentStories(session, config);
  for (const story of stories) {
    await archive.upsertStory(story, config.creatorUsername);
    for (const rawLink of story.links) {
      const canonical = canonicalizeUrl(rawLink);
      if (!canonical) continue;
      try {
        const job = archive.needsFetch(canonical) ? await fetchJobPage(canonical) : undefined;
        const id = await archive.recordLink(story, config.creatorUsername, rawLink, canonical, job);
        console.log(`Archived link #${id}: ${job?.title || canonical}`);
        await notifyIfEligible(id, story, job);
      } catch (error) {
        console.error(`Failed to archive ${canonical}:`, error);
      }
    }
  }
}

console.log("Archive monitor started. Press Ctrl+C for a clean shutdown.");
while (!shuttingDown) {
  try {
    await runCycle();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${new Date().toISOString()}] Cycle stopped: ${message}`);
    if (/manual login|verification|logged out/i.test(message)) {
      console.error("Resolve login manually with npm run setup:instagram, then restart the monitor.");
      await session.context.close().catch(() => undefined);
      await new Promise<void>((resolve) => dashboard.close(() => resolve()));
      await archive.close().catch(() => undefined);
      process.exitCode = 2;
      break;
    }
  }
  if (!shuttingDown) await sleep(config.pollIntervalMs);
}
