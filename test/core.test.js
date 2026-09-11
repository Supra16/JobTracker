import assert from "node:assert/strict";
import test from "node:test";
import filters from "../config/filters.json" with { type: "json" };
import { classifyJob } from "../dist/filter.js";
import { canonicalizeUrl, parseJobPageHtml } from "../dist/job-page.js";
import { classifyJobPresentation } from "../dist/job-classification.js";
import { formatJobMessage } from "../dist/telegram.js";
import {
  extractStoryDataLinkGroups,
  extractStoryDataLinks,
  isStoryUrlForUsername
} from "../dist/instagram.js";

function job(title, bodyText) {
  return {
    requestedUrl: "https://jobs.example.com/123",
    finalUrl: "https://jobs.example.com/123",
    title,
    description: "",
    bodyText,
    fetchSucceeded: true
  };
}

test("matches a Fall 2026 software engineering internship", () => {
  const result = classifyJob(
    job("Software Engineering Intern", "Join our Fall 2026 internship program."),
    "Apply now",
    filters
  );
  assert.equal(result.matched, true);
});

test("rejects a Summer 2026 internship", () => {
  const result = classifyJob(
    job("Software Engineering Intern", "Join our Summer 2026 internship program."),
    "Apply now",
    filters
  );
  assert.equal(result.matched, false);
});

test("rejects an excluded senior position", () => {
  const result = classifyJob(
    job("Senior Software Engineer", "Fall 2026 internship-adjacent hiring."),
    "",
    filters
  );
  assert.equal(result.matched, false);
});

test("matches a 2026 new-grad software role without requiring Fall", () => {
  const result = classifyJob(
    job("Software Engineer, New Graduate", "This opportunity is for the Class of 2026."),
    "Apply now",
    filters
  );
  assert.equal(result.matched, true);
  assert.ok(result.evidence.newGradTerms.length > 0);
});

test("matches a 2027 new-grad software role", () => {
  const result = classifyJob(
    job("Software Engineer, New Grad", "Seeking university graduates from the Class of 2027."),
    "Apply now",
    filters
  );
  assert.equal(result.matched, true);
  assert.deepEqual(result.evidence.newGradYears, ["2027"]);
});

test("does not expand internships to Fall 2027", () => {
  const result = classifyJob(
    job("Software Engineering Intern", "Join our Fall 2027 internship program."),
    "Apply now",
    filters
  );
  assert.equal(result.matched, false);
});

test("rejects a new-grad role for the wrong year", () => {
  const result = classifyJob(
    job("Entry-Level Software Developer", "This is a 2025 university graduate position."),
    "Apply now",
    filters
  );
  assert.equal(result.matched, false);
});

test("unwraps Instagram redirects and strips tracking parameters", () => {
  const wrapped = "https://l.instagram.com/?u=" +
    encodeURIComponent("https://jobs.example.com/123?utm_source=instagram&team=engineering");
  assert.equal(canonicalizeUrl(wrapped), "https://jobs.example.com/123?team=engineering");
});

test("rejects direct local destinations", () => {
  assert.equal(canonicalizeUrl("http://127.0.0.1/private"), null);
});

test("rejects Instagram media and platform URLs as external destinations", async () => {
  const { isExternalUrl } = await import("../dist/job-page.js");
  assert.equal(isExternalUrl("https://scontent-lga3-1.cdninstagram.com/story.heic"), false);
  assert.equal(isExternalUrl("https://static.xx.fbcdn.net/image.png"), false);
  assert.equal(isExternalUrl("https://about.meta.com/"), false);
  assert.equal(isExternalUrl("https://jobs.example.com/apply/123"), true);
});

test("extracts only external destinations from Story link-sticker data", () => {
  const payload = {
    image_versions2: {
      candidates: [{ url: "https://scontent-lga3-1.cdninstagram.com/story.heic" }]
    },
    story_link_stickers: [{
      story_link: {
        link_title: "Apply",
        url: "https://jobs.example.com/apply/123?utm_source=instagram"
      }
    }],
    unrelated: { url: "https://unrelated.example.net/not-a-sticker" }
  };
  assert.deepEqual(extractStoryDataLinks(payload), ["https://jobs.example.com/apply/123"]);
});

test("groups reel links by their Story item identifier", () => {
  const payload = {
    items: [
      {
        pk: "story-one",
        story_link_stickers: [{ story_link: { url: "https://jobs.example.com/one" } }]
      },
      {
        pk: "story-two",
        story_link_stickers: [{ story_link: { url: "https://jobs.example.com/two" } }]
      },
      {
        pk: "story-without-link",
        image_versions2: { candidates: [{ url: "https://cdninstagram.com/image.heic" }] }
      }
    ]
  };
  assert.deepEqual(extractStoryDataLinkGroups(payload), [
    { storyId: "story-one", links: ["https://jobs.example.com/one"] },
    { storyId: "story-two", links: ["https://jobs.example.com/two"] }
  ]);
});

test("recognizes only the configured creator's current Story URL", () => {
  assert.equal(
    isStoryUrlForUsername("https://www.instagram.com/stories/zero2sudo/123456789/", "zero2sudo"),
    true
  );
  assert.equal(
    isStoryUrlForUsername("https://www.instagram.com/stories/highlights/123456789/", "zero2sudo"),
    false
  );
  assert.equal(
    isStoryUrlForUsername("https://www.instagram.com/stories/another_creator/123456789/", "zero2sudo"),
    false
  );
});

test("classifies title-first job details without incidental body matches", () => {
  const sentry = classifyJobPresentation({
    title: "Software Engineer, New Grad (2027)",
    description: "",
    bodyText: "",
    url: "https://jobs.ashbyhq.com/sentry/role-id"
  });
  assert.equal(sentry.contentKind, "Job Listing");
  assert.equal(sentry.companyName, "Sentry");
  assert.equal(sentry.roleTitle, "Software Engineer, New Grad (2027)");
  assert.equal(sentry.opportunityType, "New Grad");
  assert.equal(sentry.recruitingTerm, "2027");

  const l3harris = classifyJobPresentation({
    title: "Intern, Software Engineer Spring 2027 at L3Harris Technologies",
    description: "",
    bodyText: "",
    url: "https://careers.l3harris.com/en/job/123"
  });
  assert.equal(l3harris.contentKind, "Job Listing");
  assert.equal(l3harris.opportunityType, "Internship");
  assert.equal(l3harris.recruitingTerm, "Spring 2027");

  const intuit = classifyJobPresentation({
    title: "Intern, Software Engineering",
    description: "Build products with our engineering team.",
    bodyText: "A former co-op program ran in Spring 2025.",
    url: "https://jobs.intuit.com/job/123"
  });
  assert.equal(intuit.opportunityType, "Internship");
  assert.equal(intuit.recruitingTerm, "Unspecified");
});

test("uses JSON-LD JobPosting data and preserves every title source", () => {
  const page = parseJobPageHtml(`<!doctype html><html><head>
    <title>Generic Careers Page</title>
    <meta property="og:title" content="Engineering Opportunities">
    <script type="application/ld+json">{
      "@context":"https://schema.org", "@type":"JobPosting",
      "title":"Software Engineer Intern - Summer 2027",
      "hiringOrganization":{"@type":"Organization","name":"Example Labs"},
      "employmentType":"INTERN"
    }</script></head><body><h1>Software Engineering Internship</h1></body></html>`,
    "https://careers.example.com/job/42"
  );
  assert.equal(page.openGraphTitle, "Engineering Opportunities");
  assert.equal(page.headingTitle, "Software Engineering Internship");
  assert.equal(page.documentTitle, "Generic Careers Page");
  const result = classifyJobPresentation({ ...page, url: page.finalUrl });
  assert.equal(result.contentKind, "Job Listing");
  assert.equal(result.companyName, "Example Labs");
  assert.equal(result.roleTitle, "Software Engineer Intern - Summer 2027");
  assert.equal(result.opportunityType, "Internship");
  assert.equal(result.recruitingTerm, "Summer 2027");
  assert.equal(result.confidence, "High");
});

test("separates events, forms, programs, searches, and resources from jobs", () => {
  const fixtures = [
    [{ title: "Engineering Recruiting Webinar", description: "Register for this event", bodyText: "", url: "https://app.brazenconnect.com/events/abc" }, "Event"],
    [{ title: "Registration", description: "", bodyText: "", url: "https://docs.google.com/forms/d/e/abc/viewform" }, "Form"],
    [{ title: "First-Gens in Tech", description: "Workshops and networking", bodyText: "", url: "https://hubspot.com/first-gens-in-tech" }, "Program"],
    [{ title: "Job Search Results", description: "Browse openings", bodyText: "", url: "https://vanguardjobs.com/job-search-results/" }, "Job Search"],
    [{ title: "Resume Templates", description: "Free guide", bodyText: "", url: "https://resume.lol/templates/zero2sudo" }, "Resource"]
  ];
  for (const [input, expected] of fixtures) {
    assert.equal(classifyJobPresentation(input).contentKind, expected);
  }
});

test("formats a classified Telegram alert", () => {
  const classification = classifyJobPresentation({
    title: "Software Engineer, New Grad (2027)",
    description: "",
    bodyText: "",
    url: "https://jobs.example.com/job/123"
  });
  const message = formatJobMessage(
    job("Software Engineer, New Grad", "Class of 2027"),
    classifyJob(job("Software Engineer, New Grad", "Class of 2027"), "", filters),
    "zero2sudo",
    false,
    { ...classification, companyName: "Example & Co" }
  );
  assert.match(message, /<b>Example &amp; Co<\/b>/);
  assert.match(message, /Content: Job Listing/);
  assert.match(message, /Role: Software Engineer/);
  assert.match(message, /Position: New Grad/);
  assert.match(message, /Term: 2027/);
});
