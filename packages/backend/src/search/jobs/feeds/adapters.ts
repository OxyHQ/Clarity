/**
 * Turning each public board's payload into Clarity's normalized listing.
 *
 * Every adapter obeys the same rule the JSON-LD extractor does: a field the
 * source did not state is ABSENT, never inferred. Where a provider ships
 * `schema.org/JobPosting` JSON-LD inside its payload — Greenhouse and Ashby do
 * — that is parsed with the SAME extractor a crawl uses, so a listing reaching
 * Clarity through a feed and the same listing reaching it through a crawl
 * normalize identically and deduplicate against each other.
 */
import type { JobEmploymentType, JobFeedKind, JobLocation } from '@clarity/shared-types';

import { extractJobPostings, type ExtractedJobPosting } from '../extract.js';
import {
  descriptionFingerprint, employerKey, normalizeCountry, normalizeCurrency,
  normalizeEmploymentType, normalizeJobTitle, normalizeSalaryInterval, urlDomain,
} from '../taxonomy.js';

export interface FeedContext {
  kind: JobFeedKind;
  identifier: string;
  /** The URL the payload came from, for resolving relative links. */
  requestUrl: string;
  extractedAt: string;
}

type Node = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const stripped = stripHtml(value);
    return stripped.length > 0 ? stripped : undefined;
  }
  if (typeof value === 'number') return String(value);
  return undefined;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function location(raw: string | undefined): JobLocation[] {
  const value = raw?.trim();
  if (!value) return [];
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  const country = parts.length > 1 ? normalizeCountry(parts[parts.length - 1]) : normalizeCountry(value);
  return [{
    raw: value,
    ...(country ? { countryCode: country } : {}),
    ...(parts.length > 1 ? { locality: parts[0] } : {}),
  }];
}

function employmentTypes(value: unknown): JobEmploymentType[] {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw
    .filter((item): item is string => typeof item === 'string')
    .map(normalizeEmploymentType)
    .filter((item): item is JobEmploymentType => Boolean(item)))];
}

/**
 * Builds a listing from already-normalized parts. Returns undefined unless the
 * source gave both a title and an employer — the same floor the JSON-LD
 * extractor applies, so a half-listing never enters the corpus.
 */
function listing(input: {
  title?: string;
  employerName?: string;
  canonicalUrl?: string;
  context: FeedContext;
  description?: string;
  employerUrl?: string;
  locations?: JobLocation[];
  applicantLocationRequirements?: string[];
  workplaceType?: ExtractedJobPosting['workplaceType'];
  employmentTypes?: JobEmploymentType[];
  salary?: ExtractedJobPosting['salary'];
  skills?: string[];
  identifier?: string;
  publishedAt?: Date;
  validThrough?: Date;
  evidenceFields?: string[];
}): ExtractedJobPosting | undefined {
  const { title, employerName, canonicalUrl, context } = input;
  if (!title || !employerName || !canonicalUrl) return undefined;
  const stated: Record<string, { source: 'feed'; selector: string; extractedAt: string }> = {};
  for (const field of input.evidenceFields ?? []) {
    stated[field] = { source: 'feed', selector: context.kind, extractedAt: context.extractedAt };
  }
  const domain = urlDomain(input.employerUrl);
  return {
    sourceKey: (input.identifier ?? canonicalUrl).slice(0, 200),
    canonicalUrl,
    applyUrl: canonicalUrl,
    title,
    ...(input.description ? { description: input.description } : {}),
    employerName,
    ...(input.employerUrl ? { employerUrl: input.employerUrl } : {}),
    ...(domain ? { employerDomain: domain } : {}),
    ...(employerKey(employerName, input.employerUrl) ? { employerKey: employerKey(employerName, input.employerUrl) } : {}),
    locations: input.locations ?? [],
    applicantLocationRequirements: input.applicantLocationRequirements ?? [],
    ...(input.workplaceType ? { workplaceType: input.workplaceType } : {}),
    employmentTypes: input.employmentTypes ?? [],
    ...(input.salary ? { salary: input.salary } : {}),
    skills: input.skills ?? [],
    ...(input.identifier ? { identifier: input.identifier } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.validThrough ? { validThrough: input.validThrough } : {}),
    normalizedTitle: normalizeJobTitle(title),
    ...(descriptionFingerprint(input.description) ? { descriptionFingerprint: descriptionFingerprint(input.description) } : {}),
    evidence: stated,
  };
}

/**
 * Providers that embed `schema.org/JobPosting` JSON-LD get the crawl path's
 * extractor rather than a second, divergent mapping of the same fields.
 */
function fromEmbeddedJsonLd(value: unknown, baseUrl: string, extractedAt: string): ExtractedJobPosting | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  const [posting] = extractJobPostings([parsed], baseUrl, extractedAt, 'feed');
  return posting;
}

function greenhouse(payload: Node, context: FeedContext): ExtractedJobPosting[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const embedded = fromEmbeddedJsonLd(job['content'], context.requestUrl, context.extractedAt);
    if (embedded) return [embedded];
    const company = job['company_name'];
    const offices = Array.isArray(job['offices']) ? job['offices'] as Node[] : [];
    const built = listing({
      title: text(job['title']),
      employerName: text(company) ?? context.identifier,
      canonicalUrl: typeof job['absolute_url'] === 'string' ? job['absolute_url'] : undefined,
      context,
      description: text(job['content']),
      locations: location(text((job['location'] as Node | undefined)?.['name'])
        ?? text(offices[0]?.['name'])),
      identifier: job['id'] === undefined ? undefined : String(job['id']),
      publishedAt: date(job['updated_at'] ?? job['first_published']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'locations', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

function lever(payload: unknown, context: FeedContext): ExtractedJobPosting[] {
  const postings = Array.isArray(payload) ? payload : [];
  return postings.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const categories = (job['categories'] ?? {}) as Node;
    const built = listing({
      title: text(job['text']),
      employerName: context.identifier,
      canonicalUrl: typeof job['hostedUrl'] === 'string' ? job['hostedUrl'] : undefined,
      context,
      description: text(job['descriptionPlain'] ?? job['description']),
      locations: location(text(categories['location'])),
      workplaceType: text(categories['workplaceType']) === 'remote' ? 'remote'
        : text(categories['workplaceType']) === 'hybrid' ? 'hybrid'
        : text(categories['workplaceType']) === 'onsite' ? 'onsite' : undefined,
      employmentTypes: employmentTypes(categories['commitment']),
      identifier: typeof job['id'] === 'string' ? job['id'] : undefined,
      publishedAt: date(job['createdAt']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'locations', 'workplaceType', 'employmentTypes', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

function ashby(payload: Node, context: FeedContext): ExtractedJobPosting[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const embedded = fromEmbeddedJsonLd(job['descriptionHtml'], context.requestUrl, context.extractedAt);
    if (embedded) return [embedded];
    const remote = job['isRemote'] === true;
    const built = listing({
      title: text(job['title']),
      employerName: text(job['organizationName']) ?? context.identifier,
      canonicalUrl: typeof job['jobUrl'] === 'string' ? job['jobUrl']
        : typeof job['applyUrl'] === 'string' ? job['applyUrl'] : undefined,
      context,
      description: text(job['descriptionPlain'] ?? job['descriptionHtml']),
      locations: remote ? [] : location(text(job['location'])),
      ...(remote ? { workplaceType: 'remote' as const } : {}),
      employmentTypes: employmentTypes(job['employmentType']),
      identifier: typeof job['id'] === 'string' ? job['id'] : undefined,
      publishedAt: date(job['publishedAt'] ?? job['updatedAt']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'locations', 'workplaceType', 'employmentTypes', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

function workable(payload: Node, context: FeedContext): ExtractedJobPosting[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const employer = text((payload['name'] ?? payload['description']) as unknown) ?? context.identifier;
  return jobs.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const city = text(job['city']);
    const country = text(job['country']);
    const built = listing({
      title: text(job['title']),
      employerName: employer,
      canonicalUrl: typeof job['url'] === 'string' ? job['url']
        : typeof job['application_url'] === 'string' ? job['application_url'] : undefined,
      context,
      description: text(job['description']),
      locations: location([city, country].filter(Boolean).join(', ')),
      ...(job['telecommuting'] === true ? { workplaceType: 'remote' as const } : {}),
      employmentTypes: employmentTypes(job['employment_type']),
      identifier: typeof job['shortcode'] === 'string' ? job['shortcode'] : undefined,
      publishedAt: date(job['published_on'] ?? job['created_at']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'locations', 'workplaceType', 'employmentTypes', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

function recruitee(payload: Node, context: FeedContext): ExtractedJobPosting[] {
  const offers = Array.isArray(payload.offers) ? payload.offers : [];
  return offers.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const built = listing({
      title: text(job['title']),
      employerName: text(job['company_name']) ?? context.identifier,
      canonicalUrl: typeof job['careers_url'] === 'string' ? job['careers_url']
        : typeof job['careers_apply_url'] === 'string' ? job['careers_apply_url'] : undefined,
      context,
      description: text(job['description']),
      locations: location([text(job['city']), text(job['country'])].filter(Boolean).join(', ')),
      ...(job['remote'] === true ? { workplaceType: 'remote' as const } : {}),
      employmentTypes: employmentTypes(job['employment_type_code'] ?? job['employment_type']),
      identifier: job['id'] === undefined ? undefined : String(job['id']),
      publishedAt: date(job['published_at'] ?? job['created_at']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'locations', 'workplaceType', 'employmentTypes', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

function smartrecruiters(payload: Node, context: FeedContext): ExtractedJobPosting[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const place = (job['location'] ?? {}) as Node;
    const company = (job['company'] ?? {}) as Node;
    const built = listing({
      title: text(job['name']),
      employerName: text(company['name']) ?? context.identifier,
      canonicalUrl: typeof job['ref'] === 'string' ? job['ref'] : undefined,
      context,
      locations: location([text(place['city']), text(place['country'])].filter(Boolean).join(', ')),
      ...(place['remote'] === true ? { workplaceType: 'remote' as const } : {}),
      employmentTypes: employmentTypes((job['typeOfEmployment'] as Node | undefined)?.['label']),
      identifier: typeof job['id'] === 'string' ? job['id'] : undefined,
      publishedAt: date(job['releasedDate']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'locations', 'workplaceType', 'employmentTypes', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

function remoteok(payload: unknown, context: FeedContext): ExtractedJobPosting[] {
  // The first element is the API's legal/attribution notice, not a listing.
  const entries = Array.isArray(payload) ? payload.filter((item) => (item as Node)?.['id'] !== undefined) : [];
  return entries.flatMap((raw) => {
    const job = raw as Node;
    const min = typeof job['salary_min'] === 'number' ? job['salary_min'] : undefined;
    const max = typeof job['salary_max'] === 'number' ? job['salary_max'] : undefined;
    const built = listing({
      title: text(job['position']),
      employerName: text(job['company']),
      canonicalUrl: typeof job['url'] === 'string' ? job['url'] : undefined,
      context,
      description: text(job['description']),
      applicantLocationRequirements: typeof job['location'] === 'string' && job['location'].trim()
        ? [job['location'].trim()] : [],
      workplaceType: 'remote',
      skills: Array.isArray(job['tags']) ? job['tags'].filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : [],
      // Only a real range counts; the API reports 0 for "not stated".
      salary: min && max ? { min, max, currency: 'USD', interval: 'year' as const } : undefined,
      identifier: job['id'] === undefined ? undefined : String(job['id']),
      publishedAt: date(job['date']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'workplaceType', 'skills', 'identifier', 'publishedAt', ...(min && max ? ['salary'] : [])],
    });
    return built ? [built] : [];
  });
}

function remotive(payload: Node, context: FeedContext): ExtractedJobPosting[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const currency = normalizeCurrency(text(job['salary_currency']) ?? '');
    const built = listing({
      title: text(job['title']),
      employerName: text(job['company_name']),
      canonicalUrl: typeof job['url'] === 'string' ? job['url'] : undefined,
      context,
      description: text(job['description']),
      applicantLocationRequirements: typeof job['candidate_required_location'] === 'string'
        ? job['candidate_required_location'].split(',').map((item) => item.trim()).filter(Boolean) : [],
      workplaceType: 'remote',
      employmentTypes: employmentTypes(job['job_type']),
      skills: Array.isArray(job['tags']) ? job['tags'].filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : [],
      identifier: job['id'] === undefined ? undefined : String(job['id']),
      publishedAt: date(job['publication_date']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'workplaceType', 'employmentTypes', 'skills', 'identifier', 'publishedAt', ...(currency ? ['salary'] : [])],
    });
    return built ? [built] : [];
  });
}

function arbeitnow(payload: Node, context: FeedContext): ExtractedJobPosting[] {
  const jobs = Array.isArray(payload.data) ? payload.data : [];
  return jobs.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const job = raw as Node;
    const built = listing({
      title: text(job['title']),
      employerName: text(job['company_name']),
      canonicalUrl: typeof job['url'] === 'string' ? job['url'] : undefined,
      context,
      description: text(job['description']),
      locations: location(text(job['location'])),
      ...(job['remote'] === true ? { workplaceType: 'remote' as const } : {}),
      employmentTypes: employmentTypes(job['job_types']),
      skills: Array.isArray(job['tags']) ? job['tags'].filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : [],
      identifier: typeof job['slug'] === 'string' ? job['slug'] : undefined,
      publishedAt: typeof job['created_at'] === 'number' ? new Date(job['created_at'] * 1000) : date(job['created_at']),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'locations', 'workplaceType', 'employmentTypes', 'skills', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

/**
 * Generic RSS/Atom. A feed states far less than a board API, so most fields
 * stay absent — which is correct. The employer comes from the channel title
 * only when the item does not name one, and never from the item's prose.
 */
function rss(body: string, context: FeedContext): ExtractedJobPosting[] {
  const channelTitle = /<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/i.exec(body)?.[1]
    ?? /<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
  const employerFallback = channelTitle ? stripHtml(unescapeXml(channelTitle)) : undefined;
  const items = [...body.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((match) => match[0]);
  return items.flatMap((item) => {
    const title = tag(item, 'title');
    const link = tag(item, 'link') ?? /<link[^>]*href="([^"]+)"/i.exec(item)?.[1];
    const built = listing({
      title,
      employerName: tag(item, 'dc:creator') ?? tag(item, 'author') ?? employerFallback,
      canonicalUrl: link,
      context,
      description: tag(item, 'description') ?? tag(item, 'summary') ?? tag(item, 'content:encoded'),
      identifier: tag(item, 'guid') ?? tag(item, 'id'),
      publishedAt: date(tag(item, 'pubDate') ?? tag(item, 'published') ?? tag(item, 'updated')),
      evidenceFields: ['title', 'employer', 'canonicalUrl', 'description', 'identifier', 'publishedAt'],
    });
    return built ? [built] : [];
  });
}

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!match) return undefined;
  const value = stripHtml(unescapeXml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')));
  return value.length > 0 ? value : undefined;
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Parses one feed's raw body into normalized listings. */
export function parseJobFeed(kind: JobFeedKind, body: string, context: FeedContext): ExtractedJobPosting[] {
  if (kind === 'rss') return rss(body, context);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${kind} returned a body that is not JSON`);
  }
  const node = (payload ?? {}) as Node;
  switch (kind) {
    case 'greenhouse': return greenhouse(node, context);
    case 'lever': return lever(payload, context);
    case 'ashby': return ashby(node, context);
    case 'workable': return workable(node, context);
    case 'recruitee': return recruitee(node, context);
    case 'smartrecruiters': return smartrecruiters(node, context);
    case 'remoteok': return remoteok(payload, context);
    case 'remotive': return remotive(node, context);
    case 'arbeitnow': return arbeitnow(node, context);
    default: throw new Error(`Unsupported job feed kind: ${String(kind)}`);
  }
}
