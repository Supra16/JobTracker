import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(projectRoot, "data", "jobs.sqlite");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = path.join(projectRoot, "data", `jobs-before-highlight-cleanup-${stamp}.sqlite`);
const temporaryPath = `${databasePath}.highlight-cleanup.tmp`;

const unwanted = new Map([
  [224, "https://directconsideration.beehiiv.com/?utm_id=97760_v0_s00_e0_tv3"],
  [225, "https://zero2sudo.bcns.link/brickfest-app"],
  [226, "https://app.brazenconnect.com/events/MpOZJ"],
  [227, "http://quantable.io/"],
  [228, "https://docs.google.com/forms/d/e/1FAIpQLSevOP9aoj6Tk15JCyLzj-oaiFlGMKKT931yxjzJa1nq-sVEDQ/viewform"],
  [229, "http://quantable.io/questions"],
  [230, "https://www.imc.com/us/careers/jobs/4780585101"],
  [231, "https://www.langchain.com/"],
  [232, "http://resume.lol/templates/zero2sudo"],
  [233, "https://zero2sudo.notion.site/zero2sudo-readme"]
]);
const highlightStoryKeys = [...unwanted.keys()]
  .filter((id) => id !== 224)
  .map((id) => ({
    225: "story:3926756137664980882",
    226: "story:3941413439226521296",
    227: "story:3584798733059750985",
    228: "story:3744983141116264104",
    229: "story:3744991238908016441",
    230: "story:3857496473840487631",
    231: "story:3819423512906764535",
    232: "story:3856713190999058312",
    233: "story:3871897922372002839"
  })[id]);

await copyFile(databasePath, backupPath);
const SQL = await initSqlJs();
const database = new SQL.Database(await readFile(databasePath));
database.run("PRAGMA foreign_keys = ON");

for (const [id, expectedUrl] of unwanted) {
  const statement = database.prepare("SELECT canonical_url FROM job_links WHERE id = ?");
  statement.bind([id]);
  const actualUrl = statement.step() ? String(statement.getAsObject().canonical_url ?? "") : "";
  statement.free();
  if (actualUrl !== expectedUrl) {
    database.close();
    throw new Error(`Refusing cleanup: job #${id} was expected to be ${expectedUrl}, found ${actualUrl || "nothing"}`);
  }
}

database.run("BEGIN");
try {
  const jobIds = [...unwanted.keys()];
  database.run(`DELETE FROM job_links WHERE id IN (${jobIds.map(() => "?").join(", ")})`, jobIds);
  const removedJobs = database.getRowsModified();
  database.run(
    `DELETE FROM stories
     WHERE story_key IN (${highlightStoryKeys.map(() => "?").join(", ")})
       AND NOT EXISTS (SELECT 1 FROM story_job_links WHERE story_job_links.story_key = stories.story_key)`,
    highlightStoryKeys
  );
  const removedHighlightStories = database.getRowsModified();
  database.run("COMMIT");
  await writeFile(temporaryPath, database.export());
  database.close();
  await rename(temporaryPath, databasePath);
  console.log(JSON.stringify({ backupPath, removedJobs, removedHighlightStories }, null, 2));
} catch (error) {
  database.run("ROLLBACK");
  database.close();
  throw error;
}
