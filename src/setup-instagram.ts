import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const profileDirectory = path.join(process.cwd(), "data", "instagram-profile");
await mkdir(profileDirectory, { recursive: true });
const context = await chromium.launchPersistentContext(profileDirectory, {
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
