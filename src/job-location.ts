// Turns the location data job pages publish into the strings the downstream
// job tracker reads: "City, ST" in the US, "City, Country" elsewhere, and
// "Remote". A value that does not name a city is dropped.

export interface AddressParts {
  locality?: string;
  region?: string;
  country?: string;
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "puerto rico": "PR", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY"
};
const US_STATE_CODES = new Set(Object.values(US_STATES));
const US_NAMES = new Set(["us", "u.s.", "usa", "u.s.a.", "united states", "united states of america"]);
// Countries whose capital shares the country's name, so "Singapore" alone is a city.
const CITY_STATES = new Set(["Singapore", "Hong Kong", "Luxembourg", "Monaco"]);
const REMOTE = /\bremote\b/i;
// Page data is untrusted: bound the text each regex sees and the list a page yields.
const MAX_FIELD_LENGTH = 200;
const MAX_TEXT_LENGTH = 1000;
const MAX_LOCATIONS = 20;

const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
const countryByCode = new Map<string, string>();
const countryByName = new Map<string, string>([["uk", "United Kingdom"], ["hong kong", "Hong Kong"]]);
for (let first = 65; first <= 90; first++) {
  for (let second = 65; second <= 90; second++) {
    const code = String.fromCharCode(first, second);
    // Skip private-use and grouping codes (EU, UN, XA, ...), which are not countries.
    if (/^(?:AA|Q[M-Z]|X.|ZZ|EU|EZ|UN)$/.test(code)) continue;
    const name = regionNames.of(code);
    if (!name || name === code) continue;
    countryByCode.set(code, name);
    if (!countryByName.has(name.toLowerCase())) countryByName.set(name.toLowerCase(), name);
  }
}

function stateCode(value: string, anyCase = false): string | undefined {
  const candidate = anyCase ? value.toUpperCase() : value;
  if (/^[A-Z]{2}$/.test(candidate) && US_STATE_CODES.has(candidate)) return candidate;
  return US_STATES[value.toLowerCase()];
}

// "US" for the United States, otherwise the country's English name.
function countryFromText(value: string): string | undefined {
  const lower = value.toLowerCase();
  if (US_NAMES.has(lower)) return "US";
  if (stateCode(value)) return undefined;
  if (/^[A-Z]{2}$/.test(value)) return countryByCode.get(value);
  return countryByName.get(lower);
}

function countryFromField(value: string): string | undefined {
  if (!value) return undefined;
  if (/^[a-z]{2}$/i.test(value)) {
    const code = value.toUpperCase();
    return code === "US" ? "US" : countryByCode.get(code);
  }
  return US_NAMES.has(value.toLowerCase()) ? "US" : countryByName.get(value.toLowerCase()) ?? value;
}

// Drops parentheticals and internal suffixes such as "Englewood, CO - CO_RMN".
function cleanSegment(value: string): string {
  return value
    .slice(0, MAX_FIELD_LENGTH)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+[-–]\s+[^\s,]*[_\d][^\s,]*$/, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
}

export function formatLocation(address: AddressParts): string | null {
  const locality = cleanSegment(address.locality ?? "");
  const region = cleanSegment(address.region ?? "");
  if (REMOTE.test(locality) || REMOTE.test(region)) return "Remote";

  let country = countryFromField(cleanSegment(address.country ?? ""));
  let state = region ? stateCode(region, true) : undefined;
  const countryTokens: string[] = [];
  const rest: string[] = [];
  for (const token of locality.split(",").map(cleanSegment).filter(Boolean)) {
    const tokenCountry = countryFromText(token);
    if (tokenCountry) {
      countryTokens.push(tokenCountry);
      country ??= tokenCountry;
    } else {
      rest.push(token);
    }
  }

  let city: string | undefined;
  if (rest.length === 1) {
    if (!/^[A-Z]{2}$/.test(rest[0]) || !stateCode(rest[0])) city = rest[0];
  } else if (rest.length > 1) {
    // Pages write "City, ST" and, on some Workday sites, "ST, City".
    const first = rest[0];
    const last = rest[rest.length - 1];
    if (stateCode(last)) {
      state ??= stateCode(last);
      city = first;
    } else if (stateCode(first)) {
      state ??= stateCode(first);
      city = last;
    } else {
      city = first;
    }
  }
  if (!city) city = countryTokens.find((name) => CITY_STATES.has(name));
  if (!city) return null;
  if (country && country !== "US") return `${city}, ${country}`;
  return state ? `${city}, ${state}` : null;
}

// Free text that may list several places, as in "San Francisco, CA • New York, NY".
export function formatLocationText(text: string): string[] {
  return uniqueLocations(
    text.slice(0, MAX_TEXT_LENGTH).split(/\s*(?:•|;|\|)\s*|\s+or\s+/).map((segment) => formatLocation({ locality: segment }))
  );
}

export function uniqueLocations(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, MAX_LOCATIONS);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return stringValue((value as Record<string, unknown>).name);
  return "";
}

function addressLocations(address: unknown): string[] {
  if (Array.isArray(address)) return address.flatMap(addressLocations);
  if (typeof address === "string") return formatLocationText(address);
  if (!address || typeof address !== "object") return [];
  const fields = address as Record<string, unknown>;
  return uniqueLocations([formatLocation({
    locality: stringValue(fields.addressLocality),
    region: stringValue(fields.addressRegion),
    country: stringValue(fields.addressCountry)
  })]);
}

function placeLocations(place: unknown): string[] {
  if (Array.isArray(place)) return place.flatMap(placeLocations);
  if (typeof place === "string") return formatLocationText(place);
  if (!place || typeof place !== "object") return [];
  const fields = place as Record<string, unknown>;
  if (fields.address) return addressLocations(fields.address);
  return typeof fields.name === "string" ? formatLocationText(fields.name) : [];
}

// Locations of a schema.org JobPosting object: its jobLocation places, then
// "Remote" when jobLocationType says TELECOMMUTE.
export function jobPostingLocations(posting: Record<string, unknown>): string[] {
  const types = Array.isArray(posting.jobLocationType) ? posting.jobLocationType : [posting.jobLocationType];
  const remote = types.some((type) => typeof type === "string" && type.toUpperCase() === "TELECOMMUTE");
  return uniqueLocations([...placeLocations(posting.jobLocation), remote ? "Remote" : null]);
}

const GREENHOUSE_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);

// Greenhouse job boards carry no structured location, but the board's public
// job API does: https://developers.greenhouse.io/job-board.html
export function greenhouseJobApiUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!GREENHOUSE_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
    if (!match) return null;
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(match[1])}/jobs/${match[2]}`;
  } catch {
    return null;
  }
}

export function greenhouseJobLocations(job: unknown): string[] {
  if (!job || typeof job !== "object") return [];
  const location = (job as Record<string, unknown>).location;
  const name = stringValue(location);
  return name ? formatLocationText(name) : [];
}
