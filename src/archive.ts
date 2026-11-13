import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { JobPage, PageStructuredData, StoryObservation } from "./types.js";
import {
  CLASSIFICATION_VERSION,
  classifyJobPresentation,
  type ContentKind,
  type JobClassification
} from "./job-classification.js";

export interface ArchivedJobSummary extends JobClassification {
  id: number;
  canonicalUrl: string;
  finalUrl: string;
  title: string;
  description: string;
  fetchSucceeded: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  storyCount: number;
  occurrenceCount: number;
  creatorUsername: string;
  locations: string[];
}

export interface ArchivedStorySource {
  storyKey: string;
  creatorUsername: string;
  storyUrl: string;
  visibleText: string;
  screenshotPath: string;
  rawUrl: string;
  discoveredAt: string;
  lastSeenAt: string;
  seenCount: number;
}

export interface ArchivedJobDetail extends ArchivedJobSummary {
  requestedUrl: string;
  bodyText: string;
  openGraphTitle: string;
  headingTitle: string;
  documentTitle: string;
  structuredData: PageStructuredData[];
  sources: ArchivedStorySource[];
}

export interface ArchiveStats {
  links: number;
  stories: number;
  fetched: number;
  fetchFailed: number;
  seenLast24Hours: number;
}

export type TelegramNotificationStatus = "baseline" | "filtered" | "sent" | "error";

export interface TelegramNotificationRecord {
  status: TelegramNotificationStatus;
  attempts: number;
  lastError: string;
  sentAt: string;
}

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

function bool(value: SqlValue): boolean {
  return Number(value) === 1;
}

function number(value: SqlValue): number {
  return Number(value ?? 0);
}

function string(value: SqlValue): string {
  return value == null ? "" : String(value);
}

function json<T>(value: SqlValue, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

export class JobArchive {
  private constructor(
    private readonly database: Database,
    private readonly filePath: string,
    private readonly readOnly: boolean
  ) {}

  static async open(filePath: string, options: { readOnly?: boolean } = {}): Promise<JobArchive> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const SQL: SqlJsStatic = await initSqlJs();
    let database: Database;

    try {
      database = new SQL.Database(await readFile(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      database = new SQL.Database();
    }

    const archive = new JobArchive(database, filePath, options.readOnly ?? false);
    archive.initialize();
    await archive.persist();
    return archive;
  }

  private initialize(): void {
    this.database.run("PRAGMA foreign_keys = ON");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS stories (
        story_key TEXT PRIMARY KEY,
        creator_username TEXT NOT NULL,
        story_url TEXT NOT NULL,
        visible_text TEXT NOT NULL DEFAULT '',
        screenshot_path TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_url TEXT NOT NULL UNIQUE,
        requested_url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        page_metadata_json TEXT NOT NULL DEFAULT '{}',
        fetch_succeeded INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS story_job_links (
        story_key TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        raw_url TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (story_key, job_id, raw_url),
        FOREIGN KEY (story_key) REFERENCES stories(story_key) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES job_links(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_job_links_last_seen ON job_links(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_story_links_job ON story_job_links(job_id);

      CREATE TABLE IF NOT EXISTS archive_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_notifications (
        job_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('baseline', 'filtered', 'sent', 'error')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (job_id) REFERENCES job_links(id) ON DELETE CASCADE
      );
    `);

    this.ensureColumn("job_links", "page_metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS job_classifications (
        job_id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL,
        content_kind TEXT NOT NULL,
        company_name TEXT NOT NULL,
        role_title TEXT NOT NULL,
        opportunity_type TEXT NOT NULL,
        recruiting_term TEXT NOT NULL,
        confidence TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        classified_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES job_links(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_classifications_kind ON job_classifications(content_kind);
    `);
    this.reclassifyOutdated();

    // On the first alert-enabled build, treat everything already archived as
    // history. Links inserted after this marker remain eligible for alerts.
    const baseline = this.one("SELECT value FROM archive_metadata WHERE key = 'telegram_baseline_initialized'");
    if (!baseline && !this.readOnly) {
      const now = new Date().toISOString();
      this.database.run(
        `INSERT INTO telegram_notifications (job_id, status, attempts, last_error, created_at, updated_at, sent_at)
         SELECT id, 'baseline', 0, '', ?, ?, '' FROM job_links`,
        [now, now]
      );
      this.database.run(
        "INSERT INTO archive_metadata (key, value) VALUES ('telegram_baseline_initialized', ?)",
        [now]
      );
    }
  }

  async upsertStory(story: StoryObservation, creatorUsername: string): Promise<void> {
    this.ensureWritable();
    const now = new Date().toISOString();
    this.database.run(
      `INSERT INTO stories (
        story_key, creator_username, story_url, visible_text, screenshot_path,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(story_key) DO UPDATE SET
        creator_username = excluded.creator_username,
        story_url = excluded.story_url,
        visible_text = excluded.visible_text,
        screenshot_path = excluded.screenshot_path,
        last_seen_at = excluded.last_seen_at`,
      [story.key, creatorUsername, story.storyUrl, story.visibleText, story.screenshotPath, now, now]
    );
    await this.persist();
  }

  needsFetch(canonicalUrl: string): boolean {
    const row = this.one(
      "SELECT fetch_succeeded FROM job_links WHERE canonical_url = ?",
      [canonicalUrl]
    );
    return !row || !bool(row.fetch_succeeded);
  }

  getTelegramNotification(jobId: number): TelegramNotificationRecord | null {
    const row = this.one(
      `SELECT status, attempts, last_error, sent_at
       FROM telegram_notifications WHERE job_id = ?`,
      [jobId]
    );
    if (!row) return null;
    return {
      status: string(row.status) as TelegramNotificationStatus,
      attempts: number(row.attempts),
      lastError: string(row.last_error),
      sentAt: string(row.sent_at)
    };
  }

  async recordTelegramNotification(
    jobId: number,
    status: Exclude<TelegramNotificationStatus, "baseline">,
    error = ""
  ): Promise<void> {
    this.ensureWritable();
    const now = new Date().toISOString();
    this.database.run(
      `INSERT INTO telegram_notifications (
        job_id, status, attempts, last_error, created_at, updated_at, sent_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        attempts = telegram_notifications.attempts + 1,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at,
        sent_at = CASE WHEN excluded.status = 'sent' THEN excluded.sent_at ELSE telegram_notifications.sent_at END`,
      [jobId, status, error.slice(0, 2000), now, now, status === "sent" ? now : ""]
    );
    await this.persist();
  }

  async recordLink(
    story: StoryObservation,
    creatorUsername: string,
    rawUrl: string,
    canonicalUrl: string,
    job?: JobPage
  ): Promise<number> {
    this.ensureWritable();
    const now = new Date().toISOString();
    this.database.run("BEGIN");
    try {
      this.database.run(
        `INSERT INTO stories (
          story_key, creator_username, story_url, visible_text, screenshot_path,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(story_key) DO UPDATE SET
          visible_text = excluded.visible_text,
          screenshot_path = excluded.screenshot_path,
          last_seen_at = excluded.last_seen_at`,
        [story.key, creatorUsername, story.storyUrl, story.visibleText, story.screenshotPath, now, now]
      );

      this.database.run(
        `INSERT INTO job_links (
          canonical_url, requested_url, final_url, title, description, body_text,
          page_metadata_json, fetch_succeeded, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_url) DO UPDATE SET
          requested_url = CASE WHEN excluded.requested_url <> '' THEN excluded.requested_url ELSE job_links.requested_url END,
          final_url = CASE WHEN excluded.final_url <> '' THEN excluded.final_url ELSE job_links.final_url END,
          title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE job_links.title END,
          description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE job_links.description END,
          body_text = CASE WHEN excluded.body_text <> '' THEN excluded.body_text ELSE job_links.body_text END,
          page_metadata_json = CASE WHEN excluded.page_metadata_json <> '{}' THEN excluded.page_metadata_json ELSE job_links.page_metadata_json END,
          fetch_succeeded = MAX(job_links.fetch_succeeded, excluded.fetch_succeeded),
          last_seen_at = excluded.last_seen_at`,
        [
          canonicalUrl,
          job?.requestedUrl ?? canonicalUrl,
          job?.finalUrl ?? canonicalUrl,
          job?.title ?? "",
          job?.description ?? "",
          job?.bodyText ?? "",
          job ? JSON.stringify({
            openGraphTitle: job.openGraphTitle ?? "",
            headingTitle: job.headingTitle ?? "",
            documentTitle: job.documentTitle ?? "",
            structuredData: job.structuredData ?? [],
            locations: job.locations ?? []
          }) : "{}",
          job?.fetchSucceeded ? 1 : 0,
          now,
          now
        ]
      );

      const id = number(this.one("SELECT id FROM job_links WHERE canonical_url = ?", [canonicalUrl])?.id ?? 0);
      this.classifyJobId(id);
      this.database.run(
        `INSERT INTO story_job_links (
          story_key, job_id, raw_url, discovered_at, last_seen_at, seen_count
        ) VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(story_key, job_id, raw_url) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          seen_count = story_job_links.seen_count + 1`,
        [story.key, id, rawUrl, now, now]
      );
      this.database.run("COMMIT");
    } catch (error) {
      try {
        this.database.run("ROLLBACK");
      } catch {
        // The original database error is more useful than a secondary rollback error.
      }
      throw error;
    }
    await this.persist();
    return number(this.one("SELECT id FROM job_links WHERE canonical_url = ?", [canonicalUrl])?.id ?? 0);
  }

  listJobs(search = "", fetchStatus = "all", limit = 250, contentKind = "all"): ArchivedJobSummary[] {
    const clauses: string[] = [];
    const parameters: SqlValue[] = [];
    const cleanedSearch = search.trim();
    if (cleanedSearch) {
      clauses.push(`(
        j.title LIKE ? OR j.description LIKE ? OR j.body_text LIKE ? OR
        j.canonical_url LIKE ? OR s.visible_text LIKE ? OR s.creator_username LIKE ? OR
        c.company_name LIKE ? OR c.role_title LIKE ? OR c.content_kind LIKE ?
      )`);
      const like = `%${cleanedSearch}%`;
      parameters.push(like, like, like, like, like, like, like, like, like);
    }
    if (fetchStatus === "fetched") clauses.push("j.fetch_succeeded = 1");
    if (fetchStatus === "failed") clauses.push("j.fetch_succeeded = 0");
    if (contentKind !== "all") {
      clauses.push("c.content_kind = ?");
      parameters.push(contentKind);
    }
    parameters.push(Math.min(Math.max(limit, 1), 1000));

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.all(
      `SELECT
        j.id, j.canonical_url, j.final_url, j.title, j.description, j.body_text,
        j.page_metadata_json,
        j.fetch_succeeded, j.first_seen_at, j.last_seen_at,
        c.version AS classification_version, c.content_kind, c.company_name,
        c.role_title, c.opportunity_type, c.recruiting_term, c.confidence,
        c.evidence_json,
        COUNT(DISTINCT sj.story_key) AS story_count,
        SUM(sj.seen_count) AS occurrence_count,
        COALESCE(MAX(s.creator_username), '') AS creator_username
      FROM job_links j
      LEFT JOIN story_job_links sj ON sj.job_id = j.id
      LEFT JOIN stories s ON s.story_key = sj.story_key
      LEFT JOIN job_classifications c ON c.job_id = j.id
      ${where}
      GROUP BY j.id
      ORDER BY j.last_seen_at DESC
      LIMIT ?`,
      parameters
    );
    return rows.map((row) => this.summary(row));
  }

  getJob(id: number): ArchivedJobDetail | null {
    const row = this.one(
      `SELECT
        j.id, j.canonical_url, j.requested_url, j.final_url, j.title,
        j.description, j.body_text, j.page_metadata_json, j.fetch_succeeded, j.first_seen_at,
        j.last_seen_at, COUNT(DISTINCT sj.story_key) AS story_count,
        c.version AS classification_version, c.content_kind, c.company_name,
        c.role_title, c.opportunity_type, c.recruiting_term, c.confidence,
        c.evidence_json,
        SUM(sj.seen_count) AS occurrence_count,
        COALESCE(MAX(s.creator_username), '') AS creator_username
      FROM job_links j
      LEFT JOIN story_job_links sj ON sj.job_id = j.id
      LEFT JOIN stories s ON s.story_key = sj.story_key
      LEFT JOIN job_classifications c ON c.job_id = j.id
      WHERE j.id = ?
      GROUP BY j.id`,
      [id]
    );
    if (!row) return null;
    const metadata = this.metadata(row);
    const sources = this.all(
      `SELECT
        s.story_key, s.creator_username, s.story_url, s.visible_text,
        s.screenshot_path, sj.raw_url, sj.discovered_at, sj.last_seen_at,
        sj.seen_count
      FROM story_job_links sj
      JOIN stories s ON s.story_key = sj.story_key
      WHERE sj.job_id = ?
      ORDER BY sj.last_seen_at DESC`,
      [id]
    ).map((source) => ({
      storyKey: string(source.story_key),
      creatorUsername: string(source.creator_username),
      storyUrl: string(source.story_url),
      visibleText: string(source.visible_text),
      screenshotPath: string(source.screenshot_path),
      rawUrl: string(source.raw_url),
      discoveredAt: string(source.discovered_at),
      lastSeenAt: string(source.last_seen_at),
      seenCount: number(source.seen_count)
    }));
    return {
      ...this.summary(row),
      requestedUrl: string(row.requested_url),
      bodyText: string(row.body_text),
      ...metadata,
      sources
    };
  }

  getStory(storyKey: string): ArchivedStorySource | null {
    const row = this.one(
      `SELECT
        s.story_key, s.creator_username, s.story_url, s.visible_text,
        s.screenshot_path, '' AS raw_url, s.first_seen_at AS discovered_at,
        s.last_seen_at, 1 AS seen_count
      FROM stories s WHERE s.story_key = ?`,
      [storyKey]
    );
    if (!row) return null;
    return {
      storyKey: string(row.story_key),
      creatorUsername: string(row.creator_username),
      storyUrl: string(row.story_url),
      visibleText: string(row.visible_text),
      screenshotPath: string(row.screenshot_path),
      rawUrl: string(row.raw_url),
      discoveredAt: string(row.discovered_at),
      lastSeenAt: string(row.last_seen_at),
      seenCount: number(row.seen_count)
    };
  }

  getStats(): ArchiveStats {
    const row = this.one(`SELECT
      (SELECT COUNT(*) FROM job_links) AS links,
      (SELECT COUNT(*) FROM stories) AS stories,
      (SELECT COUNT(*) FROM job_links WHERE fetch_succeeded = 1) AS fetched,
      (SELECT COUNT(*) FROM job_links WHERE fetch_succeeded = 0) AS fetch_failed,
      (SELECT COUNT(*) FROM job_links WHERE julianday(last_seen_at) >= julianday('now', '-1 day')) AS seen_last_24_hours`)!;
    return {
      links: number(row.links),
      stories: number(row.stories),
      fetched: number(row.fetched),
      fetchFailed: number(row.fetch_failed),
      seenLast24Hours: number(row.seen_last_24_hours)
    };
  }

  async close(): Promise<void> {
    await this.persist();
    this.database.close();
  }

  private summary(row: SqlRow): ArchivedJobSummary {
    const title = string(row.title) || "Untitled link";
    const description = string(row.description);
    const classification = this.classification(row);
    return {
      id: number(row.id),
      canonicalUrl: string(row.canonical_url),
      finalUrl: string(row.final_url),
      title,
      description,
      fetchSucceeded: bool(row.fetch_succeeded),
      firstSeenAt: string(row.first_seen_at),
      lastSeenAt: string(row.last_seen_at),
      storyCount: number(row.story_count),
      occurrenceCount: number(row.occurrence_count),
      creatorUsername: string(row.creator_username),
      locations: this.locations(row),
      ...classification
    };
  }

  // Kept apart from metadata(), which feeds the classifier.
  private locations(row: SqlRow): string[] {
    const locations = json<{ locations?: unknown }>(row.page_metadata_json, {}).locations;
    return Array.isArray(locations) ? locations.filter((item): item is string => typeof item === "string") : [];
  }

  private metadata(row: SqlRow): {
    openGraphTitle: string;
    headingTitle: string;
    documentTitle: string;
    structuredData: PageStructuredData[];
  } {
    const metadata = json<{
      openGraphTitle?: string;
      headingTitle?: string;
      documentTitle?: string;
      structuredData?: PageStructuredData[];
    }>(row.page_metadata_json, {});
    return {
      openGraphTitle: metadata.openGraphTitle ?? "",
      headingTitle: metadata.headingTitle ?? "",
      documentTitle: metadata.documentTitle ?? "",
      structuredData: metadata.structuredData ?? []
    };
  }

  private classification(row: SqlRow): JobClassification {
    if (number(row.classification_version) === CLASSIFICATION_VERSION && string(row.content_kind)) {
      return {
        classificationVersion: number(row.classification_version),
        contentKind: string(row.content_kind) as ContentKind,
        companyName: string(row.company_name),
        roleTitle: string(row.role_title),
        opportunityType: string(row.opportunity_type),
        recruitingTerm: string(row.recruiting_term),
        confidence: string(row.confidence) as JobClassification["confidence"],
        evidence: json<string[]>(row.evidence_json, [])
      };
    }
    const metadata = this.metadata(row);
    return classifyJobPresentation({
      title: string(row.title) || "Untitled link",
      description: string(row.description),
      bodyText: string(row.body_text),
      url: string(row.final_url) || string(row.canonical_url),
      ...metadata
    });
  }

  private classifyJobId(jobId: number): void {
    const row = this.one("SELECT * FROM job_links WHERE id = ?", [jobId]);
    if (!row) return;
    const result = this.classification({ ...row, classification_version: 0 });
    const now = new Date().toISOString();
    this.database.run(
      `INSERT INTO job_classifications (
        job_id, version, content_kind, company_name, role_title,
        opportunity_type, recruiting_term, confidence, evidence_json, classified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        version = excluded.version,
        content_kind = excluded.content_kind,
        company_name = excluded.company_name,
        role_title = excluded.role_title,
        opportunity_type = excluded.opportunity_type,
        recruiting_term = excluded.recruiting_term,
        confidence = excluded.confidence,
        evidence_json = excluded.evidence_json,
        classified_at = excluded.classified_at`,
      [
        jobId, result.classificationVersion, result.contentKind, result.companyName,
        result.roleTitle, result.opportunityType, result.recruitingTerm,
        result.confidence, JSON.stringify(result.evidence), now
      ]
    );
  }

  private reclassifyOutdated(): void {
    const rows = this.all(
      `SELECT j.id FROM job_links j
       LEFT JOIN job_classifications c ON c.job_id = j.id
       WHERE c.job_id IS NULL OR c.version <> ?`,
      [CLASSIFICATION_VERSION]
    );
    for (const row of rows) this.classifyJobId(number(row.id));
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.all(`PRAGMA table_info(${table})`).map((row) => string(row.name));
    if (!columns.includes(column)) this.database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private one(sql: string, parameters: SqlValue[] = []): SqlRow | null {
    return this.all(sql, parameters)[0] ?? null;
  }

  private all(sql: string, parameters: SqlValue[] = []): SqlRow[] {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(parameters);
      const rows: SqlRow[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as SqlRow);
      return rows;
    } finally {
      statement.free();
    }
  }

  private async persist(): Promise<void> {
    if (this.readOnly) return;
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, this.database.export());
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporaryPath, this.filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 5) throw error;
        await delay(50 * (2 ** attempt));
      }
    }
  }

  private ensureWritable(): void {
    if (this.readOnly) throw new Error("This archive was opened read-only");
  }
}
