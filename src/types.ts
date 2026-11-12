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
  alertAllNewLinks: boolean;
  notifyUncertain: boolean;
  profileDirectory: string;
  stateFile: string;
  artifactDirectory: string;
  databaseFile: string;
  dashboardPort: number;
  filters: FilterConfig;
  feedExport: FeedExportSettings;
}

export interface FeedExportSettings {
  enabled: boolean;
  retentionDays: number;
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
  openGraphTitle?: string;
  headingTitle?: string;
  documentTitle?: string;
  structuredData?: PageStructuredData[];
  // Where the job is, as "City, ST", "City, Country" or "Remote".
  locations?: string[];
}

export interface PageStructuredData {
  type: string;
  title?: string;
  organizationName?: string;
  employmentType?: string[];
  datePosted?: string;
  validThrough?: string;
  startDate?: string;
  endDate?: string;
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
