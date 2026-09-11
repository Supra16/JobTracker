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
