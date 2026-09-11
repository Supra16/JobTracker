import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(projectRoot, "data", "jobs.sqlite");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = path.join(projectRoot, "data", `jobs-before-cleanup-${stamp}.sqlite`);
const temporaryPath = `${databasePath}.cleanup.tmp`;

const falsePositiveJobIds = [1, 2, 3, 4];
const incorrectStoryKeys = [
  "image:0bd8ba51de4adf100981d59e619197f1db2b631313815fb8cf442aeedb3380ec",
  "image:26aa2386e52b5e9ac6a649a3c8dae47af764430d2e67d33eba26fb6cf839ae48"
];
const validJobIds = Array.from({ length: 15 }, (_, index) => 89 + index);

await copyFile(databasePath, backupPath);
const SQL = await initSqlJs();
const database = new SQL.Database(await readFile(databasePath));
database.run("PRAGMA foreign_keys = ON");
database.run("BEGIN");

try {
  const placeholders = (values) => values.map(() => "?").join(", ");
  database.run(
    `DELETE FROM story_job_links
     WHERE story_key IN (${placeholders(incorrectStoryKeys)})
       AND job_id IN (${placeholders(validJobIds)})`,
    [...incorrectStoryKeys, ...validJobIds]
  );
  const removedAssociations = database.getRowsModified();

  database.run(
    `DELETE FROM job_links WHERE id IN (${placeholders(falsePositiveJobIds)})`,
    falsePositiveJobIds
  );
  const removedJobs = database.getRowsModified();

  database.run("COMMIT");
  await writeFile(temporaryPath, database.export());
  database.close();
  await rename(temporaryPath, databasePath);

  console.log(JSON.stringify({ backupPath, removedJobs, removedAssociations }, null, 2));
} catch (error) {
  database.run("ROLLBACK");
  database.close();
  throw error;
}
