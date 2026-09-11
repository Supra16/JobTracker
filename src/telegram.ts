import { setDefaultResultOrder } from "node:dns";
import type { JobPage, MatchResult } from "./types.js";
import type { JobClassification } from "./job-classification.js";

// This Windows environment has an unusable IPv6 route to api.telegram.org.
// Prefer IPv4 so background alerts use the same route as the verified test.
setDefaultResultOrder("ipv4first");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
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
  uncertain: boolean,
  classification?: JobClassification,
  alertAllLinks = false
): string {
  const evidence = [
    ...result.evidence.seasons, ...result.evidence.internshipYears,
    ...result.evidence.employmentTypes, ...result.evidence.newGradTerms,
    ...result.evidence.newGradYears,
    ...result.evidence.roles
  ];
  return [
    `<b>${uncertain ? "Needs manual review" : alertAllLinks && !result.matched ? "New Story link found" : "Matching job found"}</b>`,
    classification ? `<b>${escapeHtml(classification.companyName)}</b>` : "",
    classification ? `Content: ${escapeHtml(classification.contentKind)}` : "",
    classification ? `Role: ${escapeHtml(classification.roleTitle)}` : "",
    classification ? `Position: ${escapeHtml(classification.opportunityType)}` : "",
    classification ? `Term: ${escapeHtml(classification.recruitingTerm)}` : "",
    classification ? `Confidence: ${escapeHtml(classification.confidence)}` : "",
    `Posting: ${escapeHtml(job.title || "Untitled job posting")}`,
    `Source: @${escapeHtml(creatorUsername)}`,
    evidence.length > 0 ? `Evidence: ${escapeHtml([...new Set(evidence)].join(", "))}` : "",
    `<a href="${escapeHtml(job.finalUrl)}">Open job posting</a>`
  ].filter(Boolean).join("\n");
}
