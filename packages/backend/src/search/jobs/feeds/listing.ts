/**
 * Building blocks every provider uses to turn its payload into Clarity's
 * normalized listing.
 *
 * Every helper obeys the rule the JSON-LD extractor does: a field the source
 * did not state is ABSENT, never inferred. A value that does not map onto a
 * closed vocabulary (currency, interval, employment type, seniority, workplace)
 * is dropped rather than guessed.
 *
 * Providers deliver descriptions as HTML, Markdown or plain text. Every one is
 * handed to the one Markdown converter (`toJobMarkdown`) rather than stripped
 * here, so a feed listing keeps the headings, lists and links its board showed.
 */
import type {
  JobEmploymentType, JobFeedKind, JobLocation, JobSalary, JobSeniority, JobWorkplaceType,
} from '@clarity/shared-types';

import { extractJobPostings, plainText, type ExtractedJobPosting } from '../extract.js';
import { decodeHtmlEntities, toJobMarkdown } from '../markdown.js';
import {
  descriptionFingerprint, employerKey, normalizeCountry, normalizeCurrency, normalizeEmploymentType,
  normalizeJobTitle, normalizeSalaryInterval, normalizeSeniority, urlDomain,
} from '../taxonomy.js';
import type { JobFeedContext, JobFeedPage, JobFeedRequest } from './provider.js';

export type Node = Record<string, unknown>;

export const JSON_ACCEPT = 'application/json';
export const XML_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8';

/** A plain GET of a public endpoint. */
export function get(requestUrl: string, accept = JSON_ACCEPT): JobFeedRequest {
  return { url: requestUrl, method: 'GET', accept };
}

/** A JSON POST, for the few public job searches that only answer POST. */
export function post(requestUrl: string, body: unknown): JobFeedRequest {
  return { url: requestUrl, method: 'POST', body: JSON.stringify(body), accept: JSON_ACCEPT };
}

/** A URL with query parameters; undefined values are left out. */
export function withQuery(base: string, params: Record<string, string | number | boolean | undefined>): string {
  const target = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) target.searchParams.set(key, String(value));
  return target.toString();
}

/** The value as an object, or an empty one. */
export function node(value: unknown): Node {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {};
}

/** The value as an array of objects, or an empty array. */
export function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.filter((item): item is Node => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

/** Parses a JSON body, failing loudly when the source answered with something else. */
export function json(body: string, kind: JobFeedKind): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${kind} returned a body that is not JSON`);
  }
}

/** A short field as plain text. */
export function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const stripped = plainText(value);
    return stripped.length > 0 ? stripped : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The first of several candidate fields that states a short text value. */
export function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const resolved = text(value);
    if (resolved) return resolved;
  }
  return undefined;
}

/** A long-text field (HTML, Markdown or plain) as Markdown; several are joined in order. */
export function markdown(...values: unknown[]): string | undefined {
  const parts = values
    .filter((value): value is string => typeof value === 'string')
    .map(toJobMarkdown)
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** A titled section, as the board shows it: `### Title` then the body. */
export function section(title: string, body: unknown): string | undefined {
  const converted = markdown(body);
  return converted ? `### ${title}\n\n${converted}` : undefined;
}

/**
 * Some board APIs return HTML entity-escaped (`&lt;p&gt;…`). Decoding once
 * recovers the markup the posting page shows.
 */
export function unescapedHtml(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /&lt;\/?[a-zA-Z][a-zA-Z0-9]*(?:\s|&gt;|\/)/.test(value) ? decodeHtmlEntities(value) : value;
}

/** A finite number from a number or a plain numeric string. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\s,]/g, '');
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A date from an ISO string or epoch milliseconds. */
export function date(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** A date from epoch seconds, the unit several board APIs use. */
export function epochSeconds(value: unknown): Date | undefined {
  const seconds = num(value);
  return seconds === undefined || seconds <= 0 ? undefined : new Date(seconds * 1000);
}

/** An absolute http(s) URL, resolved against the request when relative. */
export function url(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const resolved = new URL(value.trim(), base);
    return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Strings from an array, or from one comma-separated string. */
export function strings(value: unknown, limit = 50): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const output: string[] = [];
  for (const item of raw) {
    const resolved = text(typeof item === 'object' && item ? (item as Node)['name'] ?? (item as Node)['label'] : item);
    if (resolved && resolved.length <= 80 && !output.includes(resolved)) output.push(resolved);
    if (output.length >= limit) break;
  }
  return output;
}

/**
 * US state codes. "San Jose, CA" and "Wilmington, DE" end in a state, not in
 * Canada or Germany, so a bare two-letter segment that is also a state code is
 * read as a region and no country is assumed.
 */
const US_STATE_CODES: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
  'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

/**
 * A location from "City, Region, Country" text. Only the last segment is read
 * as a country, and only when it names one unambiguously; the text is always
 * kept as `raw`.
 */
export function locationText(raw: string | undefined): JobLocation[] {
  const value = raw?.trim();
  if (!value) return [];
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  const countryName = parts.length > 1 ? parts[parts.length - 1] : value;
  if (parts.length > 1 && US_STATE_CODES.has(countryName)) {
    return [{ raw: value, locality: parts[0], region: countryName }];
  }
  const country = normalizeCountry(countryName);
  return [{
    raw: value,
    ...(country ? { countryCode: country, country: countryName } : {}),
    ...(parts.length > 1 ? { locality: parts[0] } : {}),
    ...(parts.length > 2 ? { region: parts[1] } : {}),
  }];
}

/** A location from the separate parts a structured source states. */
export function place(parts: {
  locality?: unknown; region?: unknown; country?: unknown; countryCode?: unknown; postalCode?: unknown; raw?: unknown;
}): JobLocation | undefined {
  const locality = text(parts.locality);
  const region = text(parts.region);
  const country = text(parts.country);
  const postalCode = text(parts.postalCode);
  const raw = text(parts.raw) ?? [locality, region, country ?? text(parts.countryCode)].filter(Boolean).join(', ');
  if (!raw) return undefined;
  // A display text that ends in a country ("London Office, London, United
  // Kingdom") states it even when the structured fields do not.
  const code = normalizeCountry(text(parts.countryCode) ?? '') ?? (country ? normalizeCountry(country) : undefined)
    ?? (raw.includes(',') ? locationText(raw)[0]?.countryCode : undefined);
  return {
    raw,
    ...(code ? { countryCode: code } : {}),
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
    ...(locality ? { locality } : {}),
    ...(postalCode ? { postalCode } : {}),
  };
}

/** A location label that names no place ("Remote", "Anywhere") — a workplace signal, not a location. */
const PLACELESS = /^(?:fully\s+)?(?:remote|anywhere|worldwide|global|various|multiple locations|n\/?a)$/i;

/**
 * Distinct locations, first occurrence wins; labels that name no place are
 * dropped. Two spellings of one place ("Troy, MI, US" and "Troy, MI, United
 * States") are one location when both state the same locality and country.
 */
export function places(values: Array<JobLocation | undefined>): JobLocation[] {
  const seen = new Set<string>();
  const output: JobLocation[] = [];
  for (const value of values) {
    if (!value || PLACELESS.test(value.raw.trim())) continue;
    const keys = [value.raw, ...(value.locality && value.countryCode ? [`${value.locality.toLowerCase()}|${value.countryCode}`] : [])];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    output.push(value);
  }
  return output;
}

export function employmentTypes(...values: unknown[]): JobEmploymentType[] {
  const raw = values.flatMap((value) => Array.isArray(value) ? value : [value]);
  return [...new Set(raw
    .map((item) => typeof item === 'object' && item ? (item as Node)['name'] ?? (item as Node)['label'] ?? (item as Node)['id'] : item)
    .filter((item): item is string => typeof item === 'string')
    .map(normalizeEmploymentType)
    .filter((item): item is JobEmploymentType => Boolean(item)))];
}

/**
 * Employment types named inside a composite label ("Regular - Full-Time",
 * "Salaried, full-time", "Fixed term contract"). Each match is a type the label
 * states in words; nothing is read from the absence of one.
 */
export function employmentTypesIn(...values: unknown[]): JobEmploymentType[] {
  const found = new Set<JobEmploymentType>();
  for (const value of values) {
    // `fulltime_permanent` and `part-time` are words too.
    const label = text(value)?.toLowerCase().replace(/_/g, ' ');
    if (!label) continue;
    if (/\bfull[\s_-]?time\b|\bfulltime\b/.test(label)) found.add('full_time');
    if (/\bpart[\s_-]?time\b|\bparttime\b/.test(label)) found.add('part_time');
    if (/\bcontract(?:or)?\b|\bfreelance\b/.test(label)) found.add('contract');
    if (/\btemporary\b|\bfixed[\s_-]?term\b/.test(label)) found.add('temporary');
    if (/\bintern(?:ship)?\b|\bapprentice(?:ship)?\b/.test(label)) found.add('internship');
    if (/\bvolunteer\b/.test(label)) found.add('volunteer');
  }
  return [...found];
}

/** A snake_case or kebab-case code as words: `brand_and_product_marketing` → "Brand and product marketing". */
export function humanize(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const words = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : undefined;
}

const WORKPLACE_BY_TOKEN: Readonly<Record<string, JobWorkplaceType>> = Object.freeze({
  remote: 'remote', fullyremote: 'remote', remoteonly: 'remote', telecommute: 'remote', anywhere: 'remote',
  hybrid: 'hybrid', flexible: 'hybrid', partiallyremote: 'hybrid',
  onsite: 'onsite', office: 'onsite', inoffice: 'onsite', inperson: 'onsite', notremote: 'onsite',
});

/** A workplace label the source states, or undefined. */
export function workplace(value: unknown): JobWorkplaceType | undefined {
  const raw = text(value);
  return raw ? WORKPLACE_BY_TOKEN[raw.toLowerCase().replace(/[^a-z]/g, '')] : undefined;
}

/** The first label among several that maps onto exactly one career level. */
export function seniority(...values: unknown[]): JobSeniority | undefined {
  for (const value of values.flatMap((item) => Array.isArray(item) ? item : [item])) {
    const raw = text(typeof value === 'object' && value ? (value as Node)['name'] ?? (value as Node)['label'] ?? (value as Node)['id'] : value);
    const level = raw ? normalizeSeniority(raw) : undefined;
    if (level) return level;
  }
  return undefined;
}

/**
 * A salary from structured parts. Both the currency and the interval must be
 * stated and known; a zero or negative bound is "not stated", and an inverted
 * range is dropped rather than reordered.
 */
export function salary(parts: { min?: unknown; max?: unknown; currency?: unknown; interval?: unknown }): JobSalary | undefined {
  const currency = normalizeCurrency(text(parts.currency) ?? '');
  const interval = normalizeSalaryInterval(text(parts.interval) ?? '');
  if (!currency || !interval) return undefined;
  const min = positive(num(parts.min));
  const max = positive(num(parts.max));
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) return undefined;
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), currency, interval };
}

const CURRENCY_BY_SYMBOL: Readonly<Record<string, string>> = Object.freeze({ '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' });

/** The dollar a stated country uses; anywhere else a bare `$` is ambiguous. */
export const DOLLAR_BY_COUNTRY: Readonly<Record<string, string>> = Object.freeze({
  US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD',
});

const SALARY_INTERVAL_TEXT: ReadonlyArray<[RegExp, string]> = [
  [/^(?:per|\/|a|an)\s*(?:year|yr|annum)|^annual(?:ly)?$|^p\.?a\.?$/i, 'year'],
  [/^(?:per|\/|a|an)\s*(?:month|mo)|^monthly$/i, 'month'],
  [/^(?:per|\/|a|an)\s*(?:week|wk)|^weekly$/i, 'week'],
  [/^(?:per|\/|a|an)\s*day|^daily$/i, 'day'],
  [/^(?:per|\/|an?)\s*(?:hour|hr)|^hourly$/i, 'hour'],
];

/** "75,132.24", "60.520", "125'000" and "126.4K" as numbers. */
function amount(raw: string, thousands: boolean): number | undefined {
  let digits = raw.replace(/['\s]/g, '');
  if (thousands) {
    digits = digits.replace(/,/g, '');
  } else if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(digits)) {
    digits = digits.replace(/\./g, '').replace(',', '.'); // 50.000 / 60.520,50
  } else {
    digits = digits.replace(/,/g, '');
  }
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return thousands ? value * 1_000 : value;
}

/**
 * A salary from free text, read only when it is a complete statement: an
 * amount or range, a currency the text names, and an interval the text names
 * ("£40,000 - 50,000 per year", "$40 – $45 per hour", "CHF 125'000 / year").
 * A bare `$` counts only with `dollar`, the currency of a country the listing
 * states. Anything less — "competitive", "$230K" with no interval, "£? - ?" —
 * is left absent rather than completed by guesswork. Trailing notes after `•`
 * or `+` are not part of the salary.
 */
export function salaryText(value: unknown, options: { dollar?: string } = {}): JobSalary | undefined {
  const raw = text(value)?.split(/\s[•+|(]\s?/)[0]?.trim();
  if (!raw) return undefined;
  const match = /^(?<pre>[A-Z]{3}|[$€£¥₹])?\s?(?<min>\d[\d,.'\s]*?)(?<mink>[kK])?\s*(?:(?:-|–|—|to)\s*(?<pre2>[A-Z]{3}|[$€£¥₹])?\s?(?<max>\d[\d,.'\s]*?)(?<maxk>[kK])?)?\s*(?<post>[A-Z]{3}|[$€£¥₹])?\s*(?<interval>(?:per|\/|a|an)\s*[a-z]+|annual(?:ly)?|monthly|weekly|daily|hourly|p\.?a\.?)?$/i
    .exec(raw.replace(/\s+/g, ' '));
  if (!match?.groups) return undefined;
  const { pre, min, mink, pre2, max, maxk, post, interval: intervalText } = match.groups;
  const symbols = [pre, pre2, post].filter(Boolean).map((item) => item.toUpperCase());
  if (symbols.length === 0 || new Set(symbols).size > 1) return undefined;
  const symbol = symbols[0];
  const currency = symbol === '$' ? options.dollar : CURRENCY_BY_SYMBOL[symbol] ?? symbol;
  const interval = intervalText
    ? SALARY_INTERVAL_TEXT.find(([pattern]) => pattern.test(intervalText.trim()))?.[1]
    : undefined;
  if (!currency || !interval) return undefined;
  // "126.4K – 189.6K": one K applies to both bounds when only the second carries it.
  const both = Boolean(maxk) && !mink && max !== undefined;
  const low = amount(min, Boolean(mink) || both);
  // A single figure is the salary itself, not a floor.
  const high = max === undefined ? low : amount(max, Boolean(maxk));
  return salary({ min: low, max: high, currency, interval });
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

export interface ListingInput {
  title?: string;
  employerName?: string;
  /** The listing's own page at the source we read it from. */
  canonicalUrl?: string;
  /** Where the source sends applicants, when it differs from the listing page. */
  applyUrl?: string;
  context: JobFeedContext;
  description?: string;
  employerUrl?: string;
  employerLogoUrl?: string;
  locations?: JobLocation[];
  applicantLocationRequirements?: string[];
  workplaceType?: JobWorkplaceType;
  employmentTypes?: JobEmploymentType[];
  seniority?: JobSeniority;
  salary?: JobSalary;
  skills?: string[];
  qualifications?: string;
  responsibilities?: string;
  educationRequirements?: string;
  experienceRequirements?: string;
  benefits?: string;
  industry?: string;
  occupationalCategory?: string;
  department?: string;
  identifier?: string;
  directApply?: boolean;
  publishedAt?: Date;
  validThrough?: Date;
}

/**
 * Builds a listing from already-normalized parts. Returns undefined unless the
 * source gave a title, an employer and a URL — the same floor the JSON-LD
 * extractor applies, so a half-listing never enters the corpus. Evidence is
 * recorded for exactly the fields that are present.
 */
export function listing(input: ListingInput): ExtractedJobPosting | undefined {
  const { title, employerName, context } = input;
  const canonicalUrl = url(input.canonicalUrl, context.requestUrl);
  if (!title || !employerName || !canonicalUrl) return undefined;
  const applyUrl = url(input.applyUrl, context.requestUrl) ?? canonicalUrl;
  const employerUrl = url(input.employerUrl, context.requestUrl);
  const employerLogoUrl = url(input.employerLogoUrl, context.requestUrl);
  const domain = urlDomain(employerUrl);
  const key = employerKey(employerName, employerUrl);
  const fingerprint = descriptionFingerprint(input.description);
  const posting: ExtractedJobPosting = {
    sourceKey: (input.identifier ?? canonicalUrl).slice(0, 200),
    canonicalUrl,
    applyUrl,
    title,
    ...(input.description ? { description: input.description } : {}),
    employerName,
    ...(employerUrl ? { employerUrl } : {}),
    ...(domain ? { employerDomain: domain } : {}),
    ...(employerLogoUrl ? { employerLogoUrl } : {}),
    ...(key ? { employerKey: key } : {}),
    locations: input.locations ?? [],
    applicantLocationRequirements: input.applicantLocationRequirements ?? [],
    ...(input.workplaceType ? { workplaceType: input.workplaceType } : {}),
    employmentTypes: input.employmentTypes ?? [],
    ...(input.seniority ? { seniority: input.seniority } : {}),
    ...(input.salary ? { salary: input.salary } : {}),
    skills: input.skills ?? [],
    ...(input.qualifications ? { qualifications: input.qualifications } : {}),
    ...(input.responsibilities ? { responsibilities: input.responsibilities } : {}),
    ...(input.educationRequirements ? { educationRequirements: input.educationRequirements } : {}),
    ...(input.experienceRequirements ? { experienceRequirements: input.experienceRequirements } : {}),
    ...(input.benefits ? { benefits: input.benefits } : {}),
    ...(input.industry ? { industry: input.industry } : {}),
    ...(input.occupationalCategory ? { occupationalCategory: input.occupationalCategory } : {}),
    ...(input.department ? { department: input.department } : {}),
    ...(input.identifier ? { identifier: input.identifier } : {}),
    ...(input.directApply === undefined ? {} : { directApply: input.directApply }),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.validThrough ? { validThrough: input.validThrough } : {}),
    normalizedTitle: normalizeJobTitle(title),
    ...(fingerprint ? { descriptionFingerprint: fingerprint } : {}),
    evidence: {},
  };
  const stated: Record<string, unknown> = {
    title, employer: employerName, canonicalUrl, applyUrl: input.applyUrl ? applyUrl : undefined,
    description: posting.description, employerUrl, employerLogoUrl,
    locations: posting.locations.length ? posting.locations : undefined,
    applicantLocationRequirements: posting.applicantLocationRequirements.length ? posting.applicantLocationRequirements : undefined,
    workplaceType: posting.workplaceType,
    employmentTypes: posting.employmentTypes.length ? posting.employmentTypes : undefined,
    seniority: posting.seniority, salary: posting.salary,
    skills: posting.skills.length ? posting.skills : undefined,
    qualifications: posting.qualifications, responsibilities: posting.responsibilities,
    educationRequirements: posting.educationRequirements, experienceRequirements: posting.experienceRequirements,
    benefits: posting.benefits, industry: posting.industry, occupationalCategory: posting.occupationalCategory,
    department: posting.department, identifier: posting.identifier, directApply: posting.directApply,
    publishedAt: posting.publishedAt, validThrough: posting.validThrough,
  };
  for (const [field, value] of Object.entries(stated)) {
    if (value !== undefined) posting.evidence[field] = { source: 'feed', selector: context.kind, extractedAt: context.extractedAt };
  }
  return posting;
}

/** The built listings of a page, with the incomplete ones dropped. */
export function page(listings: Array<ExtractedJobPosting | undefined>, nextCursor?: string): JobFeedPage {
  return {
    listings: listings.filter((item): item is ExtractedJobPosting => Boolean(item)),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

/**
 * The next offset for an offset-paged source, or undefined at the end. A page
 * shorter than requested, or a total already reached, ends the walk.
 */
export function nextOffset(cursor: string | undefined, received: number, pageSize: number, total?: number): string | undefined {
  const offset = Number(cursor ?? 0) || 0;
  const next = offset + received;
  if (received === 0 || received < pageSize) return undefined;
  if (total !== undefined && next >= total) return undefined;
  return String(next);
}

/** The next 1-based page number for a page-numbered source, or undefined at the end. */
export function nextPageNumber(cursor: string | undefined, hasMore: boolean, first = 1): string | undefined {
  if (!hasMore) return undefined;
  return String((Number(cursor ?? first) || first) + 1);
}

/**
 * Providers that embed `schema.org/JobPosting` JSON-LD get the crawl path's
 * extractor rather than a second, divergent mapping of the same fields.
 */
export function fromEmbeddedJsonLd(value: unknown, baseUrl: string, extractedAt: string): ExtractedJobPosting | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  const [posting] = extractJobPostings([parsed], baseUrl, extractedAt, 'feed');
  return posting;
}

/**
 * Raw line breaks and tabs inside JSON strings, which many publishers' JSON-LD
 * contains and every browser and search engine tolerates, escaped so the
 * block parses. Nothing outside a string literal is touched.
 */
function escapeControlCharactersInStrings(json: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const character of json) {
    if (inString) {
      if (escaped) { escaped = false; output += character; continue; }
      if (character === '\\') { escaped = true; output += character; continue; }
      if (character === '"') inString = false;
      else if (character === '\n') { output += '\\n'; continue; }
      else if (character === '\r') { output += '\\r'; continue; }
      else if (character === '\t') { output += '\\t'; continue; }
      else if (character < ' ') continue;
    } else if (character === '"') {
      inString = true;
    }
    output += character;
  }
  return output;
}

/** Every `application/ld+json` block in an HTML page, parsed; unparseable blocks are skipped. */
export function jsonLdBlocks(html: string): unknown[] {
  return [...html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((match) => {
    const raw = match[1].trim();
    for (const candidate of [raw, escapeControlCharactersInStrings(raw)]) {
      try {
        return [JSON.parse(candidate)];
      } catch {
        // Try the tolerant reading next; a block that fails both is skipped.
      }
    }
    return [];
  });
}

/**
 * A page that asks search engines not to index it — `<meta name="robots">`
 * (or `name="claritybot"`) containing `noindex` or `none`.
 */
export function noindex(html: string): boolean {
  for (const [meta] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(meta)?.[1]?.toLowerCase();
    if (name !== 'robots' && name !== 'claritybot') continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(meta)?.[1]?.toLowerCase() ?? '';
    if (/(?:^|[\s,])(?:noindex|none)(?:$|[\s,])/.test(content)) return true;
  }
  return false;
}

/** The URLs and last-modified dates of a sitemap `urlset`. */
export function sitemapEntries(xml: string): Array<{ url: string; lastModified?: Date }> {
  return elements(xml, 'url').flatMap((entry) => {
    const loc = text(tag(entry, 'loc'));
    if (!loc) return [];
    const modified = date(text(tag(entry, 'lastmod')));
    return [{ url: loc, ...(modified ? { lastModified: modified } : {}) }];
  });
}

/** The element's raw content, XML-unescaped, markup inside it left intact. */
export function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!match) return undefined;
  const value = xmlText(match[1]).trim();
  return value.length > 0 ? value : undefined;
}

/** Every occurrence of an element's content, XML-unescaped. */
export function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))]
    .map((match) => xmlText(match[1]).trim())
    .filter((value) => value.length > 0);
}

/** Every complete `<name>…</name>` element, markup included. */
export function elements(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, 'gi'))].map((match) => match[0]);
}

/** CDATA content is literal; everything else was XML-escaped once. */
export function xmlText(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(value);
  return cdata ? cdata[1] : unescapeXml(value);
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
