import assert from "node:assert/strict";
import test from "node:test";
import { fetchJobPage, parseJobPageHtml } from "../dist/job-page.js";
import { formatLocation, formatLocationText, greenhouseJobApiUrl, greenhouseJobLocations } from "../dist/job-location.js";

function jsonLdPage(...postings) {
  const scripts = postings
    .map((posting) => `<script type="application/ld+json">${JSON.stringify(posting)}</script>`)
    .join("");
  return `<!doctype html><html><head><title>Job</title>${scripts}</head><body><h1>Software Engineer</h1></body></html>`;
}

function posting(fields) {
  return { "@context": "https://schema.org", "@type": "JobPosting", title: "Software Engineer", ...fields };
}

const place = (address) => ({ "@type": "Place", address });
const postal = (fields) => ({ "@type": "PostalAddress", ...fields });
const locationsOf = (html) => parseJobPageHtml(html, "https://careers.example.com/job/1").locations;

test("reads a single JSON-LD Place with a PostalAddress", () => {
  assert.deepEqual(locationsOf(jsonLdPage(posting({
    jobLocation: place(postal({ addressLocality: "New York City", addressRegion: "NY", addressCountry: "USA" }))
  }))), ["New York City, NY"]);
  assert.deepEqual(locationsOf(jsonLdPage(posting({
    jobLocation: place(postal({ addressLocality: "Chicago", addressRegion: "Illinois", addressCountry: { "@type": "Country", name: "United States" } }))
  }))), ["Chicago, IL"]);
  assert.deepEqual(locationsOf(jsonLdPage(posting({
    jobLocation: place(postal({ addressLocality: "Montreal", addressRegion: "QC", addressCountry: "CA" }))
  }))), ["Montreal, Canada"]);
});

test("reads an array of Places in order without duplicates", () => {
  assert.deepEqual(locationsOf(jsonLdPage(posting({
    jobLocation: [
      place(postal({ addressLocality: "Seattle", addressRegion: "WA", addressCountry: "US" })),
      place(postal({ addressLocality: "London", addressCountry: "GB" })),
      place(postal({ addressLocality: "Seattle", addressRegion: "Washington", addressCountry: "US" }))
    ]
  }))), ["Seattle, WA", "London, United Kingdom"]);
});

test("reads an address written as a plain string", () => {
  assert.deepEqual(locationsOf(jsonLdPage(posting({ jobLocation: place("Austin, TX") }))), ["Austin, TX"]);
  assert.deepEqual(locationsOf(jsonLdPage(posting({ jobLocation: "Barcelona, Spain" }))), ["Barcelona, Spain"]);
  assert.deepEqual(locationsOf(jsonLdPage(posting({ jobLocation: { "@type": "Place", name: "Denver, Colorado" } }))), ["Denver, CO"]);
});

test("TELECOMMUTE adds Remote after any listed place", () => {
  assert.deepEqual(locationsOf(jsonLdPage(posting({ jobLocationType: "TELECOMMUTE" }))), ["Remote"]);
  assert.deepEqual(locationsOf(jsonLdPage(posting({
    jobLocationType: ["TELECOMMUTE"],
    jobLocation: place(postal({ addressLocality: "New York City", addressRegion: "NY", addressCountry: "USA" })),
    applicantLocationRequirements: [{ "@type": "Country", name: "United States" }]
  }))), ["New York City, NY", "Remote"]);
});

test("finds a JobPosting nested in @graph", () => {
  assert.deepEqual(locationsOf(jsonLdPage({
    "@context": "https://schema.org",
    "@graph": [{ "@type": "WebPage", name: "Careers" }, posting({ jobLocation: place(postal({ addressLocality: "Boston", addressRegion: "MA" })) })]
  })), ["Boston, MA"]);
});

test("cleans Workday-style locality noise", () => {
  const workday = (addressLocality) => locationsOf(jsonLdPage(posting({
    jobLocation: place(postal({ addressLocality, addressCountry: "United States of America" }))
  })));
  assert.deepEqual(workday("Englewood, CO - CO_RMN"), ["Englewood, CO"]);
  assert.deepEqual(workday("Remote-LA"), ["Remote"]);
  assert.deepEqual(workday("US, CA, Santa Clara"), ["Santa Clara, CA"]);
});

test("drops a location that names only a country or no city", () => {
  // Lever has written the country into addressLocality.
  assert.deepEqual(locationsOf(jsonLdPage(posting({
    jobLocation: place(postal({ addressLocality: "United States", addressCountry: "United States" }))
  }))), []);
  assert.deepEqual(locationsOf(jsonLdPage(posting({ jobLocation: place(postal({ addressCountry: "Poland" })) }))), []);
  assert.deepEqual(formatLocationText("Poland"), []);
  assert.deepEqual(formatLocationText("San Francisco Bay Area"), []);
  assert.equal(formatLocation({ locality: "CA", country: "US" }), null);
  // A city-state names its own city.
  assert.deepEqual(locationsOf(jsonLdPage(posting({ jobLocation: place(postal({ addressLocality: "Singapore, Singapore" })) }))), ["Singapore, Singapore"]);
});

test("a page with no location yields none", () => {
  assert.deepEqual(locationsOf(jsonLdPage(posting({}))), []);
  assert.deepEqual(locationsOf("<!doctype html><html><head><title>Careers</title></head><body><h1>Join us</h1></body></html>"), []);
});

const smartRecruitersMarkup = `<!doctype html><html><head><title>Counsel</title></head><body>
  <main itemscope itemtype="http://schema.org/JobPosting"><h1 itemprop="title">Counsel</h1>
  <ul><li itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
    <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
      <spl-job-location formattedAddress="New York, NY, USA" workplaceType="on_site"></spl-job-location>
      %FIELDS%
    </span></li></ul></main></body></html>`;

test("reads microdata jobLocation when the page has no JSON-LD location", () => {
  const fields = `<meta itemprop="addressCountry" content="United States">
    <meta itemprop="addressLocality" content="New York"><meta itemprop="addressRegion" content="New York">`;
  assert.deepEqual(locationsOf(smartRecruitersMarkup.replace("%FIELDS%", fields)), ["New York, NY"]);
  assert.deepEqual(locationsOf(smartRecruitersMarkup.replace("%FIELDS%", "")), ["New York, NY"]);

  const withJsonLd = smartRecruitersMarkup
    .replace("%FIELDS%", fields)
    .replace("</head>", `${jsonLdPage(posting({ jobLocation: place("Austin, TX") })).match(/<script.*<\/script>/)[0]}</head>`);
  assert.deepEqual(locationsOf(withJsonLd), ["Austin, TX"]);
});

test("microdata without address fields never reads element text", () => {
  const label = `<!doctype html><html><body><div itemprop="jobLocation"><span>Location: San Francisco, CA</span></div></body></html>`;
  assert.deepEqual(locationsOf(label), []);
});

test("a bare city without region or country is kept", () => {
  assert.equal(formatLocation({ locality: "Berlin" }), "Berlin");
  assert.deepEqual(locationsOf(jsonLdPage(posting({ jobLocation: place(postal({ addressLocality: "Berlin" })) }))), ["Berlin"]);
});

const greenhouseHtml = `<!doctype html><html><head><title>Job Application for Associate Counsel at Discord</title></head>
  <body><h1>Associate Counsel</h1><div class="job__location">San Francisco Bay Area or Remote (U.S.)</div></body></html>`;
// Trimmed from https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>.
const greenhouseApiJob = {
  id: 8917177002,
  title: "Associate Commercial Counsel",
  absolute_url: "https://job-boards.greenhouse.io/discord/jobs/8917177002",
  location: { name: "San Francisco, CA • New York, NY • United States" }
};

test("builds the Greenhouse job API URL only for board job pages", () => {
  assert.equal(greenhouseJobApiUrl("https://job-boards.greenhouse.io/discord/jobs/8917177002"),
    "https://boards-api.greenhouse.io/v1/boards/discord/jobs/8917177002");
  assert.equal(greenhouseJobApiUrl("https://boards.greenhouse.io/figma/jobs/5426468004?gh_jid=5426468004"),
    "https://boards-api.greenhouse.io/v1/boards/figma/jobs/5426468004");
  assert.equal(greenhouseJobApiUrl("https://stripe.com/jobs/search?gh_jid=8172487"), null);
  assert.equal(greenhouseJobApiUrl("https://boards.greenhouse.io/embed/job_app?for=acme&token=1"), null);
  assert.deepEqual(greenhouseJobLocations(greenhouseApiJob), ["San Francisco, CA", "New York, NY"]);
  assert.deepEqual(greenhouseJobLocations({ location: { name: "Remote - US" } }), ["Remote"]);
  assert.deepEqual(greenhouseJobLocations({}), []);
});

function stubFetch(t, responses) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  t.after(() => { globalThis.fetch = original; });
  return requested;
}

const htmlResponse = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("fetchJobPage asks the Greenhouse API for a board page's location", async (t) => {
  const requested = stubFetch(t, [htmlResponse(greenhouseHtml), jsonResponse(greenhouseApiJob)]);
  const page = await fetchJobPage("https://job-boards.greenhouse.io/discord/jobs/8917177002?utm_source=ig");
  assert.deepEqual(requested, [
    "https://job-boards.greenhouse.io/discord/jobs/8917177002",
    "https://boards-api.greenhouse.io/v1/boards/discord/jobs/8917177002"
  ]);
  assert.equal(page.fetchSucceeded, true);
  assert.equal(page.headingTitle, "Associate Counsel");
  assert.deepEqual(page.locations, ["San Francisco, CA", "New York, NY"]);
});

test("a failed Greenhouse API call leaves the fetched page unchanged", async (t) => {
  const failures = [jsonResponse({ status: 404 }, 404), new Error("network down")];
  stubFetch(t, failures.flatMap((failure) => [htmlResponse(greenhouseHtml), failure]));
  for (let attempt = 0; attempt < failures.length; attempt++) {
    const page = await fetchJobPage("https://job-boards.greenhouse.io/discord/jobs/8917177002");
    assert.equal(page.fetchSucceeded, true);
    assert.equal(page.title, "Associate Counsel");
    assert.deepEqual(page.locations, []);
  }
});

test("fetchJobPage makes no extra request for other sites or pages with a location", async (t) => {
  const requested = stubFetch(t, [
    htmlResponse(jsonLdPage(posting({ jobLocation: place("Austin, TX") }))),
    htmlResponse(greenhouseHtml)
  ]);
  assert.deepEqual((await fetchJobPage("https://jobs.lever.co/acme/123")).locations, ["Austin, TX"]);
  assert.deepEqual((await fetchJobPage("https://jobs.ashbyhq.com/acme/456")).locations, []);
  assert.equal(requested.length, 2);
});

test("bounds oversized location data from a page", () => {
  const started = Date.now();
  assert.deepEqual(formatLocationText(`${" ".repeat(50_000)}x`), []);
  assert.equal(formatLocation({ locality: `Austin${",".repeat(50_000)}`, region: "TX" }), "Austin, TX");
  assert.ok(Date.now() - started < 1000);
  const places = Array.from({ length: 50 }, (_, index) => place(postal({ addressLocality: `Town ${index}`, addressRegion: "TX" })));
  assert.equal(locationsOf(jsonLdPage(posting({ jobLocation: places }))).length, 20);
});
