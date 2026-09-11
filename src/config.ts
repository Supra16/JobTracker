import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, FilterConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
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
    filters
  };
}
