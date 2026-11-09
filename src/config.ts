import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, FeedExportSettings, FilterConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function booleanValue(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const DEFAULT_FEED_RETENTION_DAYS = 14;

// Off unless FEED_EXPORT_ENABLED=true. FEED_RETENTION_DAYS is validated only when the export is on.
export function parseFeedExportSettings(env: NodeJS.ProcessEnv): FeedExportSettings {
  const enabled = booleanValue("FEED_EXPORT_ENABLED", false, env);
  if (!enabled) return { enabled, retentionDays: DEFAULT_FEED_RETENTION_DAYS };
  const retentionDays = Number(env.FEED_RETENTION_DAYS?.trim() || DEFAULT_FEED_RETENTION_DAYS);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("FEED_RETENTION_DAYS must be a whole number of at least 1");
  }
  return { enabled, retentionDays };
}

export async function loadConfig(): Promise<AppConfig> {
  const projectRoot = process.cwd();
  const filtersPath = path.join(projectRoot, "config", "filters.json");
  const filters = JSON.parse(await readFile(filtersPath, "utf8")) as FilterConfig;
  const seconds = Number(process.env.POLL_INTERVAL_SECONDS ?? "300");
  const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "4317");

  if (!Number.isFinite(seconds) || seconds < 60) {
    throw new Error("POLL_INTERVAL_SECONDS must be a number of at least 60");
  }
  if (!Number.isInteger(dashboardPort) || dashboardPort < 1024 || dashboardPort > 65535) {
    throw new Error("DASHBOARD_PORT must be an integer from 1024 through 65535");
  }

  return {
    creatorUsername: required("INSTAGRAM_CREATOR_USERNAME").replace(/^@/, ""),
    pollIntervalMs: seconds * 1000,
    headless: booleanValue("HEADLESS", false),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
    alertAllNewLinks: booleanValue("ALERT_ALL_NEW_LINKS", false),
    notifyUncertain: booleanValue("NOTIFY_UNCERTAIN", true),
    profileDirectory: path.join(projectRoot, "data", "instagram-profile"),
    stateFile: path.join(projectRoot, "data", "state.json"),
    artifactDirectory: path.join(projectRoot, "data", "artifacts"),
    databaseFile: path.join(projectRoot, "data", "jobs.sqlite"),
    dashboardPort,
    filters,
    feedExport: parseFeedExportSettings(process.env)
  };
}
