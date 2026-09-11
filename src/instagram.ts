import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
  type Response
} from "playwright";
import type { AppConfig, StoryObservation } from "./types.js";
import { canonicalizeUrl, isExternalUrl } from "./job-page.js";

export interface InstagramSession {
  context: BrowserContext;
  page: Page;
}

export async function openInstagram(config: AppConfig): Promise<InstagramSession> {
  await mkdir(config.profileDirectory, { recursive: true });
  await mkdir(config.artifactDirectory, { recursive: true });
  const context = await chromium.launchPersistentContext(config.profileDirectory, {
    headless: config.headless,
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(10_000);
  return { context, page };
}

function authenticationRequired(page: Page): boolean {
  return /\/accounts\/login|\/challenge|\/checkpoint/i.test(page.url());
}

async function assertAuthenticated(page: Page): Promise<void> {
  if (authenticationRequired(page)) {
    throw new Error("Instagram requires manual login or verification; monitoring paused");
  }
  const loginForm = page.locator('input[name="username"], input[name="password"]');
  if (await loginForm.first().isVisible().catch(() => false)) {
    throw new Error("Instagram session is logged out; run npm run setup:instagram");
  }
}

async function clickFirstVisible(locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    if ((await locator.count()) > 0 && (await locator.first().isVisible().catch(() => false))) {
      await locator.first().click();
      return true;
    }
  }
  return false;
}

export function isStoryUrlForUsername(rawUrl: string, username: string): boolean {
  try {
    const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
    return segments.length >= 2 &&
      segments[0].toLowerCase() === "stories" &&
      segments[1].toLowerCase() === username.toLowerCase();
  } catch {
    return false;
  }
}

async function openStory(page: Page, username: string): Promise<boolean> {
  const header = page.locator("header").first();
  const exactStoryLink = header.locator(`a[href^="/stories/${username}/"]`).first();
  const profileImage = header.locator('img[alt*="profile picture" i]').first();
  const profileImageControl = profileImage.locator(
    'xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]'
  );
  const clicked = await clickFirstVisible([exactStoryLink, profileImageControl, profileImage]);
  if (!clicked) return false;
  await page.waitForTimeout(2_000);
  await assertAuthenticated(page);

  if (isStoryUrlForUsername(page.url(), username)) return true;

  // A wrong fallback must never be treated as the creator's Story. In particular,
  // /stories/highlights/<id> is a Highlight, not a current Story.
  await page.keyboard.press("Escape").catch(() => undefined);
  return false;
}

function normalizedExternalUrl(raw: string): string | null {
  const canonical = canonicalizeUrl(raw.replaceAll("\\/", "/"));
  return canonical && isExternalUrl(canonical) ? canonical : null;
}

/**
 * Pull external destinations only from link-sticker-shaped portions of an
 * Instagram JSON response. Generic `url` fields are intentionally ignored:
 * Story responses contain many image/video CDN URLs alongside the stickers.
 */
export function extractStoryDataLinks(payload: unknown): string[] {
  const found = new Set<string>();
  const linkContextPattern = /(?:story.*link|link.*sticker|web_?link|external_?link|tappable|tap_?action|story_?cta)/i;
  const destinationKeyPattern = /(?:url|uri|href|destination|deeplink|web_?link)/i;

  function visit(value: unknown, inLinkContext = false, key = ""): void {
    if (typeof value === "string") {
      if (!inLinkContext || !destinationKeyPattern.test(key)) return;
      const external = normalizedExternalUrl(value);
      if (external) found.add(external);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inLinkContext, key);
      return;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    for (const [entryKey, entryValue] of entries) {
      visit(entryValue, inLinkContext || linkContextPattern.test(entryKey), entryKey);
    }
  }

  visit(payload);
  return [...found];
}

export interface StoryDataLinkGroup {
  storyId: string;
  links: string[];
}

/** Group the link-sticker destinations in a reel response by their Story item. */
export function extractStoryDataLinkGroups(payload: unknown): StoryDataLinkGroup[] {
  const groups = new Map<string, Set<string>>();
  const stickerContainerPattern = /^(?:story_?link_?stickers?|link_?stickers?|tappable_?objects|story_?cta|web_?link)$/i;
  const identifierKeys = ["pk", "id", "story_id", "media_id"];

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const stickerEntries = entries.filter(([key]) => stickerContainerPattern.test(key));
    const links = stickerEntries.flatMap(([, stickerData]) => extractStoryDataLinks({ story_link_stickers: stickerData }));
    if (links.length > 0) {
      const rawIdentifier = identifierKeys
        .map((key) => record[key])
        .find((candidate) => typeof candidate === "string" || typeof candidate === "number");
      const storyId = rawIdentifier == null
        ? `links-${createHash("sha256").update([...new Set(links)].sort().join("\n")).digest("hex").slice(0, 24)}`
        : String(rawIdentifier);
      const group = groups.get(storyId) ?? new Set<string>();
      for (const link of links) group.add(link);
      groups.set(storyId, group);
    }

    // Sticker branches have already been captured as part of their containing
    // Story item. Walk the other branches to find additional Story items.
    for (const [key, child] of entries) {
      if (!stickerContainerPattern.test(key)) visit(child);
    }
  }

  visit(payload);
  return [...groups].map(([storyId, links]) => ({ storyId, links: [...links] }));
}

class StoryResponseLinkCollector {
  private readonly groups = new Map<string, Set<string>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly page: Page,
    private readonly creatorUsername: string
  ) {}

  start(): void {
    this.page.on("response", this.onResponse);
  }

  stop(): void {
    this.page.off("response", this.onResponse);
  }

  async drain(): Promise<StoryDataLinkGroup[]> {
    await Promise.allSettled([...this.pending]);
    const groups = [...this.groups].map(([storyId, links]) => ({ storyId, links: [...links] }));
    this.groups.clear();
    return groups;
  }

  private readonly onResponse = (response: Response): void => {
    if (!isStoryUrlForUsername(this.page.url(), this.creatorUsername)) return;
    let host = "";
    try {
      host = new URL(response.url()).hostname.toLowerCase();
    } catch {
      return;
    }
    if (!(host === "instagram.com" || host.endsWith(".instagram.com"))) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!/json|javascript/i.test(contentType)) return;

    const task = response.json()
      .then((payload: unknown) => {
        if (!isStoryUrlForUsername(this.page.url(), this.creatorUsername)) return;
        for (const incoming of extractStoryDataLinkGroups(payload)) {
          const group = this.groups.get(incoming.storyId) ?? new Set<string>();
          for (const link of incoming.links) group.add(link);
          this.groups.set(incoming.storyId, group);
        }
      })
      .catch(() => undefined)
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  };
}

async function inspectFrame(
  page: Page,
  artifactDirectory: string
): Promise<StoryObservation> {
  const screenshot = await page.screenshot({ fullPage: false });
  const imageHash = createHash("sha256").update(screenshot).digest("hex");
  const storyUrl = page.url();
  const urlId = storyUrl.match(/\/stories\/[^/]+\/(\d+)/)?.[1];
  const key = urlId ? `story:${urlId}` : `image:${imageHash}`;
  const screenshotPath = path.join(artifactDirectory, `${key.replace(":", "-")}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const visibleText = (await page.locator("body").innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .slice(0, 20_000);
  // Link extraction comes exclusively from the authenticated Story JSON
  // responses. DOM scanning can see the profile beneath the final Story and
  // can accidentally click Highlights, so this visual observation has no links.
  const links: string[] = [];
  return {
    key,
    storyUrl,
    visibleText,
    links,
    screenshotPath
  };
}

export async function collectCurrentStories(
  session: InstagramSession,
  config: AppConfig
): Promise<StoryObservation[]> {
  const { page } = session;
  const profileUrl = `https://www.instagram.com/${encodeURIComponent(config.creatorUsername)}/`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  await assertAuthenticated(page);

  const responseCollector = new StoryResponseLinkCollector(page, config.creatorUsername);
  responseCollector.start();
  if (!(await openStory(page, config.creatorUsername))) {
    responseCollector.stop();
    console.log("No active Story was found, or the profile selector needs calibration.");
    return [];
  }

  // Freeze automatic playback so inspection cannot race the Story progress timer.
  const pause = page.getByRole("button", { name: /^pause$/i }).first();
  if (await pause.isVisible().catch(() => false)) {
    await pause.click().catch(() => undefined);
    await page.waitForTimeout(250);
  }

  const observations: StoryObservation[] = [];
  const cycleKeys = new Set<string>();
  const addObservation = (incoming: StoryObservation): void => {
    const existing = observations.find((observation) => observation.key === incoming.key);
    if (!existing) {
      observations.push(incoming);
      return;
    }
    existing.links = [...new Set([...existing.links, ...incoming.links])];
    if (incoming.visibleText.length > existing.visibleText.length) existing.visibleText = incoming.visibleText;
    if (incoming.screenshotPath) existing.screenshotPath = incoming.screenshotPath;
    if (incoming.storyUrl) existing.storyUrl = incoming.storyUrl;
  };
  const addResponseGroups = (groups: StoryDataLinkGroup[]): void => {
    if (groups.length === 0) return;
    const linkCount = groups.reduce((total, group) => total + group.links.length, 0);
    console.log(`Instagram returned ${linkCount} external link(s) across ${groups.length} active Story item(s).`);
    for (const group of groups) {
      console.log(`story:${group.storyId}: ${group.links.join(" | ")}`);
      addObservation({
        key: `story:${group.storyId}`,
        storyUrl: `https://www.instagram.com/stories/${encodeURIComponent(config.creatorUsername)}/${encodeURIComponent(group.storyId)}/`,
        visibleText: "Link extracted from Instagram Story data",
        links: group.links,
        screenshotPath: ""
      });
    }
  };
  try {
    for (let frame = 0; frame < 30; frame += 1) {
      await assertAuthenticated(page);
      if (!isStoryUrlForUsername(page.url(), config.creatorUsername)) break;
      addResponseGroups(await responseCollector.drain());
      const observation = await inspectFrame(page, config.artifactDirectory);
      if (cycleKeys.has(observation.key)) break;
      cycleKeys.add(observation.key);
      addObservation(observation);
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1_500);
      if (!isStoryUrlForUsername(page.url(), config.creatorUsername)) break;
    }
    const finalGroups = await responseCollector.drain();
    if (isStoryUrlForUsername(page.url(), config.creatorUsername)) {
      addResponseGroups(finalGroups);
    } else if (finalGroups.length > 0) {
      console.log(`Discarded ${finalGroups.length} late Story-data group(s) after leaving @${config.creatorUsername}'s current Story viewer.`);
    }
  } finally {
    responseCollector.stop();
  }
  return observations;
}
