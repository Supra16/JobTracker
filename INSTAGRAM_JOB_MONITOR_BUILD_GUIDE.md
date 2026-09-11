# Instagram Story Job-Link Monitor: Complete Build Guide

This document is a handoff guide for building a personal job-link monitor. It is written so another coding agent can walk the owner through every account, installation, configuration, coding, testing, and operating step.

The monitor uses a dedicated, manually authenticated Instagram browser session controlled by Playwright. It checks one creator's public Stories, extracts outbound links when Instagram exposes them to the browser, reads the linked job pages, applies deterministic filters such as “Fall 2026 internship,” deduplicates results, and sends matching links to a private Telegram chat.

> **Current implementation note:** As of August 19, 2026, ingestion is archive-first. Every discovered external Story link and its related identifiers and page metadata are written to `data/jobs.sqlite`. A versioned two-stage classifier first separates job listings from events, forms, programs, job-search pages, resources, and unknown links. It then extracts company, role title, opportunity type, recruiting term, confidence, and supporting evidence, prioritizing JSON-LD and page titles over body text. Existing records are automatically reclassified when the classifier version changes. Telegram currently sends every newly discovered link once for testing, while its SQLite notification ledger prevents repeat alerts and retries delivery errors. Run `npm run dev`, then open `http://127.0.0.1:4317` to browse and filter the local archive.

## Important limitation and operating boundary

Instagram's Terms of Use prohibit automated collection without express permission. A browser-controlled implementation can be restricted or disabled by Instagram even when it uses a normal logged-in account. The most reliable and policy-safe design is still for the creator to mirror their links to Telegram, Discord, email, RSS, a Sheet, or a webhook.

If this Playwright version is used:

- Use it only for a small personal monitor and one creator.
- Use a dedicated Instagram account, not a primary account.
- Do not bypass CAPTCHAs, login challenges, rate limits, or access controls.
- When a login or challenge screen appears, stop automation and require the owner to resolve it manually.
- Do not use proxy rotation, fingerprint spoofing, hidden private APIs, or scraped session cookies.
- Never give an Instagram password or session file to a third-party service.
- Treat the Playwright profile as a password-equivalent secret.

This project intentionally contains no CAPTCHA solver, stealth plugin, rate-limit bypass, private Instagram API, or credential-sharing mechanism.

## Active implementation plan: pure Playwright

**Decision recorded August 18, 2026:** use pure Playwright with archive-first collection. Browser Use is deferred and will be reconsidered only if real Story testing shows that DOM-based extraction and narrowly scoped confirmation-button handling are too unreliable.

The active extraction order is:

1. Open the creator's profile using the dedicated persistent Playwright browser profile.
2. Open the active Story using semantic locators rather than screen coordinates.
3. Search the entire Story viewer for external `a[href]` elements, regardless of where the creator placed the sticker.
4. If Instagram represents the sticker as a button, handle only narrowly named link/confirmation controls and capture the resulting popup or navigation URL.
5. Save every Story ID or screenshot fingerprint, Story URL, visible text, screenshot, raw outbound URL, and canonical URL.
6. Fetch and save the linked page's final URL, title, description, body text, success state, timestamps, and occurrence count.
7. Expose the archive through a local-only dashboard at `http://127.0.0.1:4317`.
8. Do not filter or discard candidates during ingestion; filtering will be layered over the archive later.
9. Stop for manual intervention on login, checkpoint, challenge, or CAPTCHA screens.

No fixed screen coordinates, LLM provider, AI browser agent, cloud browser profile, or model API key are part of the active plan. Story sticker position does not matter when Instagram exposes the link in the DOM. If a creator types a non-clickable URL into the Story image, local OCR can be evaluated as a separate enhancement before introducing a browser agent.

The rollout remains incremental: establish the manual Instagram session, run headed tests against real Stories, verify database records and dashboard details, calibrate semantic locators if necessary, and only then schedule continuous monitoring. Telegram is optional until filtering is re-enabled.

## Deferred alternative: Browser Use adaptive extractor

The open-source `browser-use` Python package was evaluated as viable, but it is not part of the active implementation. The notes below are retained only as a fallback design if pure Playwright proves too difficult in real use.

The current Browser Use library supports local browsers, persistent profiles or Playwright-format storage state, vision-assisted page interaction, domain restrictions, maximum-step limits, custom deterministic tools, and Pydantic-validated structured output. These capabilities directly address the most fragile portion of this project: finding the Story viewer, recognizing the link sticker, and adapting when Instagram rearranges visible controls.

Browser Use does not remove Instagram's prohibition on unauthorized automated collection, guarantee that an account will not be challenged, or make every run reliable. It also adds model latency, API cost, nondeterministic decisions, and a privacy consideration because the selected model provider may receive page text and screenshots. For those reasons, use a dedicated Instagram account and never expose a primary account's feed, messages, or profile to this automation.

### Deferred architecture

```text
Node.js scheduler
        |
        v
Python Browser Use extractor (local browser + dedicated Instagram session)
        |
        v
Validated JSON: login state, Story IDs, text, outbound URLs, confidence
        |
        v
Existing deterministic TypeScript pipeline
  URL validation -> job-page fetch -> filters -> deduplication -> Telegram
```

Browser Use owns Instagram navigation. It receives a narrowly scoped task such as: open the configured creator, determine whether an active Story exists, inspect each unseen frame, collect visible job-related text and outbound link destinations, and return structured data. It must be explicitly told never to like, reply, follow, message, post, change account settings, or resolve a CAPTCHA/login challenge.

The TypeScript application remains authoritative for all decisions and side effects. The model does not decide whether a job matches the user's filters, does not send notifications, and does not write deduplication state.

### Security constraints for the adaptive extractor

- Run the open-source agent and browser locally. Do not upload the Chrome profile to Browser Use Cloud.
- Reuse a dedicated Instagram storage-state file; do not use the owner's everyday Chrome profile.
- Restrict browser navigation to Instagram wherever possible.
- Use a custom deterministic action to capture a link-sticker destination and immediately close an external tab. Do not let the agent browse arbitrary job pages.
- Return data through a Pydantic schema rather than accepting free-form model text.
- Set `max_steps`, `max_failures`, and timeouts so a confused agent stops safely.
- Stop and report `login_required=true` for login, checkpoint, challenge, or CAPTCHA screens.
- Disable conversation-history and GIF persistence in normal operation. Diagnostic screenshots remain local and should be ignored by Git.
- Enable Browser Use cost tracking during evaluation.

### Cost-aware scheduling strategy

Do not run an unconstrained vision agent every minute. Begin with a proof of concept and measure actual cost and completion time.

1. Run 10–15 manual scans against real Stories in headed mode.
2. Record link-capture accuracy, false actions, steps, duration, and model cost.
3. If reliable, run a deterministic lightweight Story check every two minutes.
4. Invoke Browser Use when a new Story is detected or deterministic extraction fails.
5. Run a periodic Browser Use audit every 10–15 minutes so a changed Instagram layout cannot silently disable the lightweight detector.
6. Retain the current deterministic extractor behind a feature flag until the adaptive path proves more reliable.

If the lightweight detector itself proves too fragile, switch to agent-only polling at a measured interval after reviewing the observed monthly model cost.

### Migration phases

1. **Environment:** add a project-local Python virtual environment. Python 3.11 or newer is required. Pin `browser-use` and its dependencies in a lock or requirements file.
2. **Authentication bridge:** update the existing manual login command to export Playwright-format storage state to `data/instagram-storage.json`. Browser Use officially supports loading that format.
3. **Proof-of-concept extractor:** create `agent/scan_instagram.py` with a Pydantic result containing `login_required`, `has_active_story`, `stories`, `links`, `visible_text`, `confidence`, and `notes`.
4. **Safety tools:** add a narrowly scoped custom Browser Use action for capturing a sticker's destination without continuing through arbitrary sites.
5. **Node integration:** add a TypeScript adapter that runs the Python extractor, reads JSON from stdout, validates it, and passes links into the existing pipeline.
6. **Feature flag:** add `INSTAGRAM_EXTRACTOR=playwright|browser-use|hybrid`; default to `hybrid` during evaluation.
7. **Tests:** use saved local HTML/screenshot fixtures for schema and orchestration tests, then headed tests against the dedicated account.
8. **Benchmark gate:** require successful capture across at least ten real Story frames, no unintended account actions, correct challenge detection, and acceptable measured cost before scheduling it continuously.
9. **Operations:** retain local screenshots only on failures, cap agent runs, and send an operational alert when authentication or extraction fails repeatedly.

If this fallback is activated later, the next decision will be the model provider. Browser Use can use its own hosted model API, another supported hosted model, or an OpenAI-compatible/local model. A hosted vision-capable model will usually be more reliable, but page screenshots and extracted DOM context may be transmitted to that provider. The API key must be placed only in `.env` and never pasted into chat or committed.

## What will be built

```text
Dedicated Playwright Chromium profile
        |
        v
Creator profile checked every few minutes
        |
        v
New Story frames + outbound links detected
        |
        v
Linked page title and visible text extracted
        |
        v
Every candidate archived in data/jobs.sqlite
        |
        v
Searchable local dashboard at 127.0.0.1:4317
```

An AI agent is not required at runtime. This is a deterministic Node.js program. An agent is useful during initial selector calibration if Instagram has changed its page structure.

### Archive contents

The active implementation writes a real SQLite database to `data/jobs.sqlite` using the portable `sql.js` WebAssembly runtime. The monitor is the only writer. The dashboard reads the same live archive while `npm run dev` is running.

The archive has three related tables:

- `stories`: Story key, creator, Story URL, visible text, screenshot path, and first/last-seen timestamps.
- `job_links`: numeric archive ID, canonical/requested/final URLs, page title, description, body text, fetch state, and first/last-seen timestamps.
- `story_job_links`: the many-to-many source relationship, including raw URL, discovery timestamps, and observation count.

No candidate is rejected by the job filters during ingestion. The existing filter module and tests remain available for a later classification layer.

### Dashboard commands

During monitoring:

```powershell
npm run dev
```

Then open:

```text
http://127.0.0.1:4317
```

The dashboard provides archive statistics, text search, fetch-state filtering, canonical and raw URLs, page metadata, occurrence counts, Story identifiers, Story text, and captured screenshots. It binds only to the local loopback interface and is not exposed to the network.

When the monitor is stopped, browse the last saved snapshot with:

```powershell
npm run dashboard
```

Do not run `npm run dashboard` and `npm run dev` simultaneously because both use the same local port. The standalone dashboard opens the database read-only so it cannot overwrite monitor data.

## Accounts required

### 1. Dedicated Instagram account

The owner should perform these steps personally:

1. Create or choose a secondary Instagram account.
2. Follow the target creator if necessary.
3. Confirm that the account can manually view the creator's Stories.
4. Enable two-factor authentication and retain recovery codes safely.
5. Do not enter the Instagram password into this project. Login will happen manually in the Playwright browser.

If Instagram refuses the new account or presents verification, resolve that only through Instagram's normal user interface. Do not automate the verification process.

### 2. Telegram notification bot

The owner should perform these steps in the official Telegram app:

1. Open a chat with `@BotFather`.
2. Send `/newbot`.
3. Choose a display name such as `Job Link Monitor`.
4. Choose a unique username ending in `bot`, such as `my_private_job_monitor_bot`.
5. Copy the bot token BotFather returns. Treat it as a secret.
6. Open the newly created bot and press **Start**, or send `/start`.
7. In a browser, replace `<TOKEN>` below and open:

   ```text
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

8. Find the most recent `message.chat.id` number in the JSON response. That is `TELEGRAM_CHAT_ID`.
9. If the result is empty, send another message to the bot and refresh `getUpdates`.

The bot cannot initiate a private conversation until the owner has contacted it once.

## Local prerequisites

Install:

- Node.js 22 or newer from the official Node.js website.
- Git, if the folder will be version controlled.
- A code editor such as Visual Studio Code.

Verify in PowerShell:

```powershell
node --version
npm --version
```

The remainder of this guide assumes the project directory is:

```text
C:\Users\supra\Desktop\JobTracker
```

## Project structure

Create this structure:

```text
JobTracker/
  config/
    filters.json
  data/
    .gitkeep
    jobs.sqlite                 # Created at runtime; never commit
  src/
    archive.ts
    config.ts
    dashboard.ts
    dashboard-only.ts
    filter.ts
    index.ts
    instagram.ts
    job-page.ts
    setup-instagram.ts
    state.ts
    telegram.ts
    types.ts
  test/
    archive.test.js
    core.test.js
  .env.example
  .gitignore
  package.json
  tsconfig.json
```

The `data/instagram-profile` folder will be created later. Never commit it.

## Install the project

From PowerShell in the project directory:

```powershell
npm install
npx playwright install chromium
```

`npm install` will create `package-lock.json`. Commit the lockfile if this becomes a Git repository so future installs use the tested dependency versions.

## Complete project files

Create every file below exactly as shown.

### `package.json`

```json
{
  "name": "instagram-story-job-monitor",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Personal Playwright archive for job links shared in Instagram Stories",
  "scripts": {
    "setup:instagram": "npm run build --silent && node dist/setup-instagram.js",
    "test:telegram": "npm run build --silent && node dist/test-telegram.js",
    "dashboard": "npm run build --silent && node dist/dashboard-only.js",
    "dev": "npm run build --silent && node dist/index.js",
    "test": "npm run build --silent && node --test test/*.test.js",
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "cheerio": "latest",
    "dotenv": "latest",
    "playwright": "latest",
    "sql.js": "^1.14.2"
  },
  "devDependencies": {
    "@types/node": "latest",
    "@types/sql.js": "^1.4.11",
    "typescript": "latest"
  }
}
```

The first successful `npm install` pins concrete versions in `package-lock.json`; that lockfile, rather than the `latest` labels, should be used for subsequent reproducible installs.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

### `.gitignore`

```gitignore
node_modules/
dist/
.env

# Contains Instagram cookies and local browser authentication.
data/instagram-profile/

# Runtime state and diagnostic screenshots can contain private information.
data/state.json
data/jobs.sqlite
data/jobs.sqlite.tmp
data/artifacts/

# Playwright output
playwright-report/
test-results/
```

### `.env.example`

```dotenv
# Instagram username without the @ symbol.
INSTAGRAM_CREATOR_USERNAME=creator_username_here

# Start conservatively. Five minutes is recommended during development.
POLL_INTERVAL_SECONDS=300

# Keep false while developing so browser behavior is visible.
HEADLESS=false

# Telegram secrets from BotFather and getUpdates.
TELEGRAM_BOT_TOKEN=123456789:replace_me
TELEGRAM_CHAT_ID=123456789

# If true, send links that could not be classified for manual review.
NOTIFY_UNCERTAIN=true

# Local-only archive dashboard.
DASHBOARD_PORT=4317
```

Copy this to `.env`, fill in the real values, and never commit `.env`:

```powershell
Copy-Item .env.example .env
```

### `config/filters.json`

This configuration supports two acceptance paths: a Fall 2026 internship path and a 2026/2027 new-grad path. Both require a configured role and honor exclusions. Edit it without changing application code.

```json
{
  "seasons": ["fall", "autumn"],
  "internshipYears": ["2026"],
  "employmentTypes": ["intern", "internship", "co-op", "coop"],
  "newGradTerms": [
    "new grad",
    "new graduate",
    "new college grad",
    "university graduate",
    "recent graduate",
    "graduate software engineer",
    "entry level",
    "entry-level",
    "early career",
    "campus hire",
    "class of 2026",
    "class of 2027"
  ],
  "newGradYears": ["2026", "2027"],
  "roles": [
    "software engineer",
    "software engineering",
    "software developer",
    "technology intern",
    "machine learning",
    "data engineer",
    "product manager",
    "cybersecurity"
  ],
  "exclude": [
    "senior software engineer",
    "staff software engineer",
    "principal software engineer"
  ]
}
```

If `roles` is set to `[]`, role matching is disabled. The same rule applies to the other positive groups. Exclusions always apply.

### `src/types.ts`

```ts
export interface FilterConfig {
  seasons: string[];
  internshipYears: string[];
  employmentTypes: string[];
  newGradTerms: string[];
  newGradYears: string[];
  roles: string[];
  exclude: string[];
}

export interface AppConfig {
  creatorUsername: string;
  pollIntervalMs: number;
  headless: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  notifyUncertain: boolean;
  profileDirectory: string;
  stateFile: string;
  artifactDirectory: string;
  filters: FilterConfig;
}

export interface StoryObservation {
  key: string;
  storyUrl: string;
  visibleText: string;
  links: string[];
  screenshotPath: string;
}

export interface JobPage {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description: string;
  bodyText: string;
  fetchSucceeded: boolean;
}

export interface MatchResult {
  matched: boolean;
  uncertain: boolean;
  evidence: {
    seasons: string[];
    internshipYears: string[];
    employmentTypes: string[];
    newGradTerms: string[];
    newGradYears: string[];
    roles: string[];
    excluded: string[];
  };
}

export interface StoryState {
  firstSeen: string;
  lastSeen: string;
  attempts: number;
  completed: boolean;
}

export interface UrlState {
  firstSeen: string;
  status: "matched" | "rejected" | "uncertain" | "error";
}

export interface MonitorState {
  stories: Record<string, StoryState>;
  urls: Record<string, UrlState>;
}
```

### `src/config.ts`

```ts
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, FilterConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
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
  const filterText = await readFile(filtersPath, "utf8");
  const filters = JSON.parse(filterText) as FilterConfig;

  const seconds = Number(process.env.POLL_INTERVAL_SECONDS ?? "300");
  if (!Number.isFinite(seconds) || seconds < 60) {
    throw new Error("POLL_INTERVAL_SECONDS must be a number of at least 60");
  }

  return {
    creatorUsername: required("INSTAGRAM_CREATOR_USERNAME").replace(/^@/, ""),
    pollIntervalMs: seconds * 1000,
    headless: booleanValue("HEADLESS", false),
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
    notifyUncertain: booleanValue("NOTIFY_UNCERTAIN", true),
    profileDirectory: path.join(projectRoot, "data", "instagram-profile"),
    stateFile: path.join(projectRoot, "data", "state.json"),
    artifactDirectory: path.join(projectRoot, "data", "artifacts"),
    filters
  };
}
```

### `src/state.ts`

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MonitorState, UrlState } from "./types.js";

const emptyState = (): MonitorState => ({ stories: {}, urls: {} });

export class StateStore {
  private state: MonitorState = emptyState();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.filePath, "utf8")) as MonitorState;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await this.save();
    }
  }

  shouldInspectStory(key: string): boolean {
    const record = this.state.stories[key];
    return !record || (!record.completed && record.attempts < 3);
  }

  async recordStoryAttempt(key: string, completed: boolean): Promise<void> {
    const now = new Date().toISOString();
    const old = this.state.stories[key];
    this.state.stories[key] = {
      firstSeen: old?.firstSeen ?? now,
      lastSeen: now,
      attempts: (old?.attempts ?? 0) + 1,
      completed: old?.completed === true || completed
    };
    this.prune();
    await this.save();
  }

  hasUrl(url: string): boolean {
    return Boolean(this.state.urls[url]);
  }

  async recordUrl(url: string, status: UrlState["status"]): Promise<void> {
    this.state.urls[url] = {
      firstSeen: this.state.urls[url]?.firstSeen ?? new Date().toISOString(),
      status
    };
    this.prune();
    await this.save();
  }

  private prune(): void {
    const keepNewest = <T extends { firstSeen: string }>(records: Record<string, T>) =>
      Object.fromEntries(
        Object.entries(records)
          .sort((a, b) => b[1].firstSeen.localeCompare(a[1].firstSeen))
          .slice(0, 5000)
      );

    this.state.stories = keepNewest(this.state.stories);
    this.state.urls = keepNewest(this.state.urls);
  }

  private async save(): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
```

### `src/filter.ts`

```ts
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

  return {
    matched,
    uncertain: !job.fetchSucceeded,
    evidence
  };
}
```

### `src/job-page.ts`

```ts
import * as cheerio from "cheerio";
import type { JobPage } from "./types.js";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "ref",
  "source",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term"
]);

export function canonicalizeUrl(raw: string): string | null {
  try {
    let url = new URL(raw);

    // Instagram commonly wraps external links in a u= query parameter.
    if (url.hostname === "l.instagram.com") {
      const wrapped = url.searchParams.get("u");
      if (wrapped) url = new URL(wrapped);
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const host = url.hostname.toLowerCase();
    const privateHost =
      host === "localhost" ||
      host === "::1" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.");
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
  return !(
    host === "instagram.com" ||
    host.endsWith(".instagram.com") ||
    host === "facebook.com" ||
    host.endsWith(".facebook.com")
  );
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

    const html = (await response.text()).slice(0, 3_000_000);
    const $ = cheerio.load(html);
    $("script, style, noscript, svg").remove();

    const title =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("h1").first().text().trim() ||
      $("title").text().trim();
    const description =
      $('meta[name="description"]').attr("content")?.trim() ||
      $('meta[property="og:description"]').attr("content")?.trim() ||
      "";
    const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 100_000);

    return {
      requestedUrl: canonical,
      finalUrl: canonicalizeUrl(response.url) ?? canonical,
      title,
      description,
      bodyText,
      fetchSucceeded: true
    };
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
```

### `src/telegram.ts`

```ts
import type { JobPage, MatchResult } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram returned HTTP ${response.status}: ${await response.text()}`);
  }
}

export function formatJobMessage(
  job: JobPage,
  result: MatchResult,
  creatorUsername: string,
  uncertain: boolean
): string {
  const evidence = [
    ...result.evidence.seasons,
    ...result.evidence.internshipYears,
    ...result.evidence.employmentTypes,
    ...result.evidence.newGradTerms,
    ...result.evidence.newGradYears,
    ...result.evidence.roles
  ];

  const heading = uncertain ? "Needs manual review" : "Matching job found";
  return [
    `<b>${heading}</b>`,
    `<b>${escapeHtml(job.title || "Untitled job posting")}</b>`,
    `Source: @${escapeHtml(creatorUsername)}`,
    evidence.length > 0 ? `Evidence: ${escapeHtml([...new Set(evidence)].join(", "))}` : "",
    `<a href="${escapeHtml(job.finalUrl)}">Open job posting</a>`
  ]
    .filter(Boolean)
    .join("\n");
}
```

### `src/setup-instagram.ts`

This script opens the dedicated browser profile and lets the owner log in manually. It never receives the password.

```ts
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { loadConfig } from "./config.js";

const config = await loadConfig();
await mkdir(config.profileDirectory, { recursive: true });

const context = await chromium.launchPersistentContext(config.profileDirectory, {
  headless: false,
  viewport: { width: 1440, height: 1000 }
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });

console.log("\nLog into the dedicated Instagram account in the browser.");
console.log("Resolve two-factor authentication normally if Instagram asks for it.");
console.log("Confirm that the home feed is visible, then return to this terminal.\n");

const prompt = createInterface({ input, output });
await prompt.question("Press Enter after login is complete...");
prompt.close();

await context.close();
console.log("Browser profile saved. Never commit or share data/instagram-profile.");
```

### `src/instagram.ts`

Instagram changes its user interface regularly. This module deliberately uses visible browser elements and conservative selectors. The selector calibration section later explains what to do if the current interface differs.

```ts
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
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

async function openStory(page: Page, username: string): Promise<boolean> {
  const exactStoryLink = page.locator(`a[href^="/stories/${username}/"]`);
  const headerImageLink = page.locator("header a:has(img)");
  const profileImage = page.locator("header img").first();

  const clicked = await clickFirstVisible([exactStoryLink, headerImageLink, profileImage]);
  if (!clicked) return false;

  await page.waitForTimeout(2_000);
  await assertAuthenticated(page);
  return /\/stories\//i.test(page.url()) || (await page.locator('[role="dialog"]').count()) > 0;
}

async function externalAnchors(page: Page): Promise<string[]> {
  const values = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => (anchor as HTMLAnchorElement).href).filter(Boolean)
  );

  return [...new Set(values)]
    .filter(isExternalUrl)
    .map(canonicalizeUrl)
    .filter((value): value is string => Boolean(value));
}

async function tryLinkButtons(
  context: BrowserContext,
  page: Page
): Promise<string[]> {
  const found: string[] = [];
  const button = page
    .getByRole("button", { name: /visit|open|apply|learn more|see more|view link/i })
    .first();

  if (!(await button.isVisible().catch(() => false))) return found;

  const beforeUrl = page.url();
  const popupPromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
  await button.click().catch(() => undefined);
  const popup = await popupPromise;

  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    const external = canonicalizeUrl(popup.url());
    if (external && isExternalUrl(external)) found.push(external);
    await popup.close().catch(() => undefined);
  } else {
    await page.waitForTimeout(1_500);
    const current = canonicalizeUrl(page.url());
    if (current && isExternalUrl(current)) {
      found.push(current);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForTimeout(1_000);
    } else if (page.url() !== beforeUrl && !/\/stories\//i.test(page.url())) {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
  }

  return found;
}

async function inspectFrame(
  context: BrowserContext,
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

  const links = [...(await externalAnchors(page)), ...(await tryLinkButtons(context, page))];

  return {
    key,
    storyUrl,
    visibleText,
    links: [...new Set(links)],
    screenshotPath
  };
}

export async function collectCurrentStories(
  session: InstagramSession,
  config: AppConfig
): Promise<StoryObservation[]> {
  const { context, page } = session;
  const profileUrl = `https://www.instagram.com/${encodeURIComponent(config.creatorUsername)}/`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  await assertAuthenticated(page);

  if (!(await openStory(page, config.creatorUsername))) {
    console.log("No active Story was found, or the profile selector needs calibration.");
    return [];
  }

  const observations: StoryObservation[] = [];
  const cycleKeys = new Set<string>();

  // A safety ceiling prevents accidental endless navigation.
  for (let frame = 0; frame < 30; frame += 1) {
    await assertAuthenticated(page);
    const observation = await inspectFrame(context, page, config.artifactDirectory);

    if (cycleKeys.has(observation.key)) break;
    cycleKeys.add(observation.key);
    observations.push(observation);

    const before = observation.key;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1_500);

    if (!/\/stories\//i.test(page.url()) && (await page.locator('[role="dialog"]').count()) === 0) {
      break;
    }

    // The next loop hashes the frame. If ArrowRight did nothing, its key equals `before` and ends the loop.
    if (frame === 29) console.warn(`Stopped at Story safety limit after ${before}`);
  }

  return observations;
}
```

### `src/index.ts`

```ts
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { classifyJob } from "./filter.js";
import { collectCurrentStories, openInstagram } from "./instagram.js";
import { canonicalizeUrl, fetchJobPage } from "./job-page.js";
import { StateStore } from "./state.js";
import { formatJobMessage, sendTelegramMessage } from "./telegram.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const config = await loadConfig();
await mkdir(config.artifactDirectory, { recursive: true });

const state = new StateStore(config.stateFile);
await state.load();

const session = await openInstagram(config);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; closing browser...`);
  await session.context.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function runCycle(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Checking @${config.creatorUsername}`);
  const stories = await collectCurrentStories(session, config);

  for (const story of stories) {
    if (!state.shouldInspectStory(story.key)) continue;

    let completed = story.links.length > 0;

    for (const rawLink of story.links) {
      const canonical = canonicalizeUrl(rawLink);
      if (!canonical || state.hasUrl(canonical)) continue;

      try {
        const job = await fetchJobPage(canonical);
        const result = classifyJob(job, story.visibleText, config.filters);

        if (result.matched) {
          await sendTelegramMessage(
            config.telegramBotToken,
            config.telegramChatId,
            formatJobMessage(job, result, config.creatorUsername, false)
          );
          await state.recordUrl(canonical, "matched");
          console.log(`Notified: ${job.title} - ${job.finalUrl}`);
        } else if (result.uncertain && config.notifyUncertain) {
          await sendTelegramMessage(
            config.telegramBotToken,
            config.telegramChatId,
            formatJobMessage(job, result, config.creatorUsername, true)
          );
          await state.recordUrl(canonical, "uncertain");
          console.log(`Sent for manual review: ${job.finalUrl}`);
        } else {
          await state.recordUrl(canonical, "rejected");
          console.log(`Filtered out: ${job.finalUrl}`);
        }
      } catch (error) {
        completed = false;
        console.error(`Failed to process ${canonical}:`, error);
        // Do not record the URL here; a later cycle may retry it.
      }
    }

    await state.recordStoryAttempt(story.key, completed);
  }
}

console.log("Monitor started. Press Ctrl+C for a clean shutdown.");

while (!shuttingDown) {
  try {
    await runCycle();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${new Date().toISOString()}] Cycle stopped: ${message}`);

    if (/manual login|verification|logged out/i.test(message)) {
      console.error("Resolve login manually with npm run setup:instagram, then restart the monitor.");
      await session.context.close().catch(() => undefined);
      process.exitCode = 2;
      break;
    }
  }

  if (!shuttingDown) await sleep(config.pollIntervalMs);
}
```

## First-time setup procedure

An agent walking the owner through setup should use this order.

### Step 1: Install dependencies

```powershell
Set-Location C:\Users\supra\Desktop\JobTracker
npm install
npx playwright install chromium
npm run typecheck
```

Do not continue past a TypeScript error. Fix the code or dependency compatibility first.

### Step 2: Create `.env`

```powershell
Copy-Item .env.example .env
```

Ask the owner to edit `.env` personally. Do not ask them to paste the Instagram password. Avoid printing the Telegram token in terminal logs or chat.

### Step 3: Test Telegram separately

With `.env` loaded manually or using the values without printing the token, test the official endpoint from a small temporary Node command or proceed to the monitor after login. If Telegram returns `chat not found`, the owner must open the bot and send `/start`, then obtain the correct chat ID through `getUpdates`.

### Step 4: Establish the Instagram browser session

```powershell
npm run setup:instagram
```

The owner logs in inside the opened Chromium window. They then confirm the home feed is visible and press Enter in PowerShell. This creates `data/instagram-profile`.

If the setup window closes before login is complete, run the command again. If Instagram asks for verification, the owner completes it manually in the browser.

### Step 5: Manually verify the target creator

Before running the monitor:

1. Run `npm run setup:instagram` again.
2. Navigate manually to the target creator.
3. Confirm a current Story opens.
4. Confirm a job link sticker is visible and works when manually clicked.
5. Close through the terminal prompt.

This distinguishes “there is no current Story” from “the automation selector is wrong.”

### Step 6: Run in visible development mode

Keep `HEADLESS=false` and use a five-minute interval initially:

```powershell
npm run dev
```

Watch what the controlled browser does. After one check, inspect:

```text
data/artifacts/
data/state.json
```

Success means:

- The creator profile opened.
- The current Story opened.
- Each frame advanced at most once.
- An outbound link appeared in the logs or Telegram.
- A matching link produced one Telegram message.
- The same link did not notify again on the next cycle.

Stop with `Ctrl+C`.

## Selector calibration when Instagram changes

This is the part most likely to require an agent's help. It is normal for UI selectors to need adjustment over time.

Do not begin by adding stealth or bypass software. Calibrate only visible elements available to the logged-in owner.

### Diagnose the profile-to-Story click

If the log says no active Story was found even though one exists:

1. Run with `HEADLESS=false`.
2. Pause execution temporarily by adding `await page.pause()` immediately before `openStory(...)` in `collectCurrentStories`.
3. Start with `npm run dev`.
4. Use Playwright Inspector's element picker on the creator's Story ring/profile image.
5. Prefer selectors in this order:
   - A stable accessible role and name.
   - A link whose `href` starts with `/stories/<username>/`.
   - A relationship such as a link containing the profile image.
   - A CSS class only as a last resort because generated classes change frequently.
6. Update only the locator list in `openStory`.
7. Remove `page.pause()` when finished.

### Diagnose link-sticker extraction

If screenshots show a link sticker but `story.links` is empty:

1. Add `await page.pause()` at the beginning of `inspectFrame`.
2. Inspect the link sticker's role, accessible name, and nearest anchor.
3. If it is an `a[href]`, determine why `externalAnchors` excluded it.
4. If it is a button, add its actual accessible name to the regex in `tryLinkButtons`.
5. If clicking first opens an Instagram confirmation panel, add a narrowly scoped second locator for the panel's visible “Visit link” control.
6. Keep the locator specific to the Story dialog. Never add a generic rule that clicks every button.
7. Retest against a real Story and verify that it does not click Reply, Like, Share, Follow, or navigation controls.

Do not inspect or depend upon undocumented private network APIs. They are less stable, may expose more account data than needed, and expand the policy risk.

### Typed URLs and OCR

The included implementation extracts clickable destinations. It does not OCR arbitrary text from images. If the creator types URLs instead of using link stickers, add OCR only after confirming it is necessary.

A safe extension is to run local OCR over the existing `data/artifacts/*.png` screenshots, look for strings beginning with `https://`, and send uncertain results for manual review. Never automatically visit an OCR-derived URL without validating the scheme and hostname because OCR can misread characters.

## Filter behavior and tuning

The default configuration accepts either:

- A Fall/Autumn 2026 internship or co-op in a configured role; or
- A 2026 or 2027 new-grad, university-graduate, entry-level, early-career, or campus-hire position in a configured role.

The internship path requires `2026`; the new-grad path accepts `2026` or `2027`. Both require one desired role term and reject configured senior-title exclusions.

Terms may be found in the Story text, page title, description, visible page text, or URL. Because naive substring matching can produce occasional false positives, inspect early notifications and tune `filters.json`.

Recommended testing fixtures:

1. Fall 2026 software engineering internship — should match.
2. Summer 2026 software internship — should not match because no Fall term.
3. Fall 2026 senior software engineer — should be excluded.
4. Fall 2026 finance internship — should not match unless finance is added to roles.
5. Job page blocked by anti-bot controls — should be sent as “Needs manual review” when `NOTIFY_UNCERTAIN=true`.

For high recall, keep `NOTIFY_UNCERTAIN=true`. Missing a fast-moving job is usually worse than receiving a small number of manual-review notifications.

## Build and production run

After development succeeds:

```powershell
npm run typecheck
npm run build
npm start
```

Keep `HEADLESS=false` at first. Headless mode may render a different interface or cause additional login checks. There is no requirement to use headless mode; a minimized visible browser is acceptable.

The browser does not need to have Instagram open before the program starts. The program launches Chromium using the saved profile and navigates to the creator. The laptop does need to remain awake, connected, and logged into Windows.

Only one Chromium process can safely use `data/instagram-profile` at a time. Close any setup session before starting the monitor, and do not launch two monitor instances.

## Optional Windows Task Scheduler setup

The simplest operating model is one continuously running process. To start it automatically at Windows login:

1. Build successfully with `npm run build`.
2. Open **Task Scheduler**.
3. Choose **Create Task**.
4. Name it `Instagram Job Monitor`.
5. Choose **Run only when user is logged on** while using a visible browser.
6. Add trigger **At log on**.
7. Add action **Start a program**.
8. Program/script: the full path returned by `Get-Command node`.
9. Arguments: `dist/index.js`.
10. Start in: `C:\Users\supra\Desktop\JobTracker`.
11. Configure restart after failure with a conservative delay.
12. Do not configure overlapping instances.

If a terminal window is undesirable, use a small service wrapper only after the visible development version is stable. Never hide failures that require manual login.

## Operational checklist

Daily or after a missed link:

- Confirm the monitor process is running.
- Check console errors.
- Confirm Instagram is still logged in.
- Check whether `data/artifacts` contains the expected Story screenshot.
- Confirm the job sticker is clickable manually.
- Confirm Telegram bot access has not been revoked.

After an Instagram login challenge:

1. Stop the monitor.
2. Run `npm run setup:instagram`.
3. Let the owner resolve the challenge manually.
4. Close the setup browser through its terminal prompt.
5. Restart with `npm run dev` or `npm start`.

After changing filters, restart the process. Existing URLs in `data/state.json` will not be re-notified. For controlled retesting, back up `state.json` and remove only the specific URL entry being tested. Do not delete the Instagram profile.

## Security checklist

- `.env` is ignored by Git.
- `data/instagram-profile` is ignored by Git.
- `data/state.json` and screenshots are ignored by Git.
- The Telegram bot token is never printed or pasted into issue trackers.
- The Instagram password is never stored in source or environment variables.
- The monitor runs under a normal Windows user, not Administrator.
- Only HTTP and HTTPS external links are accepted.
- Direct local/private-network destinations are rejected before fetching; do not run this against untrusted links without also validating every redirect target.
- Job-page downloads have a timeout, and only the first three million characters are parsed.
- Login challenges stop automation.
- No automatic likes, replies, follows, direct messages, or posting are performed.

If the Telegram token is exposed, revoke it through BotFather and create a new one. If the Instagram profile directory is exposed, log out other sessions/change the password through Instagram, remove the local profile after verifying its exact path, and establish a new one.

## Known limitations

- Instagram may change its DOM and break selectors without notice.
- Some Story stickers require a confirmation step that must be calibrated.
- Some job sites render descriptions only with JavaScript, so a plain `fetch` may not see them.
- Some job sites block automated HTTP requests; these become manual-review notifications.
- Story overlay text gathered from `body.innerText()` can include unrelated Instagram controls.
- The included matcher uses transparent substring rules, not semantic reasoning.
- A laptop that sleeps will miss checks until it wakes.
- Stories expire, so prolonged downtime can permanently miss links.
- No solution based on unauthorized Instagram browser automation can be guaranteed against account restriction.

## Sensible future improvements

Implement only after the basic monitor is stable:

1. Add unit tests for URL normalization and filter behavior.
2. Replace JSON state with SQLite if multiple processes or richer history are needed.
3. Use Playwright to render job pages only when plain `fetch` fails.
4. Add local OCR for typed URLs.
5. Add a small local dashboard showing observed, matched, rejected, and uncertain links.
6. Add quiet hours or digest notifications.
7. Add employer, location, remote-status, and sponsorship filters.
8. Support a creator-provided Telegram/Discord/RSS source and disable Instagram automation when available.

## Definition of done

Another agent should consider the project successfully set up only when all of the following are demonstrated:

- `npm run typecheck` succeeds.
- The owner completed manual Instagram login in the dedicated Playwright profile.
- The target creator's active Story opens in visible mode.
- At least one real outbound link is captured, or the agent documents that the current Story has no link.
- A known matching test produces a Telegram notification.
- A known non-matching test is rejected.
- The same canonical URL does not notify twice.
- A forced logout stops the monitor and requests manual login rather than retrying credentials.
- Secrets and browser state are excluded from Git.

At that point the owner can leave `npm start` running on an awake laptop and adjust `config/filters.json` as their job search changes.
