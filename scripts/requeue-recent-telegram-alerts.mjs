import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(projectRoot, "data", "jobs.sqlite");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = path.join(projectRoot, "data", `jobs-before-alert-requeue-${stamp}.sqlite`);
const temporaryPath = `${databasePath}.alert-requeue.tmp`;
const expected = new Map([
  [433, "https://careers.humana.com/us/en/job/R-424692/Humana-Technology-Internship-Summer-2027"],
  [434, "https://careers.honeywell.com/en/sites/Honeywell/job/155860/"]
]);

const SQL = await initSqlJs();
const database = new SQL.Database(await readFile(databasePath));
for (const [id, expectedUrl] of expected) {
  const statement = database.prepare(`
    SELECT j.canonical_url, n.status
    FROM job_links j
    JOIN telegram_notifications n ON n.job_id = j.id
    WHERE j.id = ?
  `);
  statement.bind([id]);
  const row = statement.step() ? statement.getAsObject() : null;
  statement.free();
  if (String(row?.canonical_url ?? "") !== expectedUrl || String(row?.status ?? "") !== "filtered") {
    database.close();
    throw new Error(`Refusing requeue: job #${id} does not match the expected filtered record`);
  }
}

await copyFile(databasePath, backupPath);
database.run("DELETE FROM telegram_notifications WHERE job_id IN (433, 434)");
const requeued = database.getRowsModified();
await writeFile(temporaryPath, database.export());
database.close();
await rename(temporaryPath, databasePath);
console.log(JSON.stringify({ backupPath, requeued }, null, 2));
