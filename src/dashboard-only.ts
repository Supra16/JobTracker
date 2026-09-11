import { loadConfig } from "./config.js";
import { JobArchive } from "./archive.js";
import { startDashboard } from "./dashboard.js";

const config = await loadConfig();
const archive = await JobArchive.open(config.databaseFile, { readOnly: true });
const server = await startDashboard(archive, config.dashboardPort, config.artifactDirectory);
console.log(`Read-only dashboard: http://127.0.0.1:${config.dashboardPort}`);
console.log("Press Ctrl+C to stop it. Do not run this command while npm run dev is active.");

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await archive.close();
  process.exit(0);
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
