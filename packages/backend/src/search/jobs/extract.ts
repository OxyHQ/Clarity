/**
 * `schema.org/JobPosting` extraction.
 *
 * Consumes the JSON-LD nodes the shared document extractor already collected
 * and produces normalized employment fields with per-field provenance. The
 * exact same normalizer serves crawled pages (`json_ld`) and listings handed to
 * Clarity through the ingestion API (`api`), so a first-party publisher and the
 * open web are held to one contract.
 *
 * Rule: a field that the source does not state is absent. Nothing is inferred
 * from prose, and no default is substituted for a missing value.
 */
import type {
  JobEmploymentType,
  JobEvidence,
  JobFieldSource,
  JobLocation,
  JobSalary,
  JobWorkplaceType,
} from '@clarity/shared-types';

import {
  descriptionFingerprint,
  employerKey,
  normalizeCountry,
  normalizeCurrency,
  normalizeEmploymentType,
  normalizeJobTitle,
  normalizeSalaryInterval,
  urlDomain,
} from './taxonomy.js';

export interface ExtractedJobPosting {
  /** Stable key for this listing inside its document. */
  sourceKey: string;
  canonicalUrl: string;
  applyUrl?: string;
  title: string;
  description?: string;
  employerName: string;
  employerUrl?: string;
  employerDomain?: string;
  employerLogoUrl?: string;
  employerKey?: string;
  locations: JobLocation[];
  applicantLocationRequirements: string[];
  workplaceType?: JobWorkplaceType;
  employmentTypes: JobEmploymentType[];
  salary?: JobSalary;
  skills: string[];
  qualifications?: string;
  responsibilities?: string;
  educationRequirements?: string;
  experienceRequirements?: string;
  industry?: string;
  occupationalCategory?: string;
  identifier?: string;
  directApply?: boolean;
  publishedAt?: Date;
  validThrough?: Date;
  normalizedTitle: string;
  descriptionFingerprint?: string;
  evidence: Record<string, JobEvidence>;
}

type Node = Record<string, unknown>;

/** Walks `@graph`, arrays and nested nodes so wrapper shapes still resolve. */
function flattenNodes(values: readonly unknown[]): Node[] {
  const output: Node[] = [];
  const queue = [...values];
  let visited = 0;
  while (queue.length > 0 && visited < 2_000) {
    visited += 1;
    const value = queue.shift();
    if (Array.isArray(value)) { queue.push(...value); continue; }
    if (!value || typeof value !== 'object') continue;
    const node = value as Node;
    output.push(node);
    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
      if (key in node) queue.push(node[key]);
    }
  }
  return output;
}

function typesOf(node: Node): string[] {
  const raw = node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase());
}

export function isJobPostingNode(node: unknown): boolean {
  return Boolean(node) && typeof node === 'object' && typesOf(node as Node).includes('jobposting');
}

/** True when a document's structured data carries at least one job listing. */
export function hasJobPosting(structuredData: readonly unknown[]): boolean {
  return flattenNodes(structuredData).some(isJobPostingNode);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const stripped = stripHtml(value);
    return stripped.length > 0 ? stripped : undefined;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(text).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (value && typeof value === 'object') {
    const node = value as Node;
    for (const key of ['name', 'value', 'credentialCategory', 'description', 'termCode', 'codeValue']) {
      const nested = text(node[key]);
      if (nested) return nested;
    }
    const months = node['monthsOfExperience'];
    if (typeof months === 'number' || typeof months === 'string') return `${months} months of experience`;
  }
  return undefined;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absoluteUrl(value: unknown, base: string): string | undefined {
  const candidate = typeof value === 'string' ? value : typeof value === 'object' && value ? (value as Node).url : undefined;
  if (typeof candidate !== 'string') return undefined;
  try { return new URL(candidate, base).toString(); } catch { return undefined; }
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\s,]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && cleaned.length > 0 ? parsed : undefined;
}

function list(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((item) => {
      const resolved = text(item);
      return resolved ? resolved.split(/[,;•\n]/) : [];
    })
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 80);
}

function address(value: unknown): JobLocation | undefined {
  if (typeof value === 'string') {
    const raw = stripHtml(value);
    return raw ? { raw, countryCode: normalizeCountry(raw) } : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Node;
  const locality = text(node['addressLocality']);
  const region = text(node['addressRegion']);
  const country = text(node['addressCountry']);
  const postalCode = text(node['postalCode']);
  const raw = [locality, region, country].filter(Boolean).join(', ');
  if (!raw) return undefined;
  const countryCode = country ? normalizeCountry(country) : undefined;
  return {
    raw,
    ...(countryCode ? { countryCode } : {}),
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
    ...(locality ? { locality } : {}),
    ...(postalCode ? { postalCode } : {}),
  };
}

function locations(value: unknown): JobLocation[] {
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const output: JobLocation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      const direct = address(item);
      if (direct && !seen.has(direct.raw)) { seen.add(direct.raw); output.push(direct); }
      continue;
    }
    const node = item as Node;
    const resolved = address(node['address'] ?? node);
    if (resolved && !seen.has(resolved.raw)) { seen.add(resolved.raw); output.push(resolved); }
  }
  return output;
}

function salary(node: Node): JobSalary | undefined {
  const base = node['baseSalary'];
  const container = Array.isArray(base) ? base[0] : base;
  if (!container || typeof container !== 'object') return undefined;
  const amount = container as Node;
  const currency = normalizeCurrency(
    text(amount['currency']) ?? text(amount['salaryCurrency']) ?? text(node['salaryCurrency']) ?? '',
  );
  if (!currency) return undefined;
  const valueNode = amount['value'];
  const quantitative = valueNode && typeof valueNode === 'object' ? valueNode as Node : undefined;
  const interval = normalizeSalaryInterval(
    text(quantitative?.['unitText']) ?? text(amount['unitText']) ?? '',
  );
  if (!interval) return undefined;
  const min = numeric(quantitative?.['minValue']) ?? numeric(quantitative?.['value']) ?? numeric(valueNode);
  const max = numeric(quantitative?.['maxValue']) ?? numeric(quantitative?.['value']) ?? numeric(valueNode);
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    currency,
    interval,
  };
}

/**
 * Workplace type is DERIVED, and only from explicit structured signals:
 * `jobLocationType: TELECOMMUTE` alone means remote; the same flag together
 * with a physical `jobLocation` means hybrid; a physical location without the
 * flag means onsite. Anything else stays undefined.
 */
function workplaceType(node: Node, physicalLocations: JobLocation[]): JobWorkplaceType | undefined {
  const declared = list(node['jobLocationType']).map((item) => item.toUpperCase());
  const telecommute = declared.some((item) => item.includes('TELECOMMUTE'));
  if (telecommute) return physicalLocations.length > 0 ? 'hybrid' : 'remote';
  return physicalLocations.length > 0 ? 'onsite' : undefined;
}

/**
 * `identifier` is usually a `PropertyValue` whose `name` is the ATS and whose
 * `value` is the requisition id, so `value` wins over the generic text rules.
 */
function identifier(value: unknown): string | undefined {
  const node = Array.isArray(value) ? value[0] : value;
  const resolved = node && typeof node === 'object'
    ? text((node as Node)['value']) ?? text((node as Node)['identifier']) ?? text(node)
    : text(node);
  return resolved && resolved.length <= 200 ? resolved : undefined;
}

export function extractJobPostings(
  structuredData: readonly unknown[],
  baseUrl: string,
  extractedAt: string,
  fieldSource: JobFieldSource = 'json_ld',
): ExtractedJobPosting[] {
  const nodes = flattenNodes(structuredData).filter(isJobPostingNode);
  const output: ExtractedJobPosting[] = [];
  const seenKeys = new Set<string>();

  nodes.forEach((node, index) => {
    const title = text(node['title']) ?? text(node['name']);
    const organization = node['hiringOrganization'];
    const organizationNode = organization && typeof organization === 'object' && !Array.isArray(organization)
      ? organization as Node
      : undefined;
    const employerName = text(organizationNode?.['name']) ?? text(organization);
    if (!title || !employerName) return;

    const employerUrl = absoluteUrl(organizationNode?.['url'] ?? organizationNode?.['sameAs'], baseUrl);
    const employerLogoUrl = absoluteUrl(organizationNode?.['logo'], baseUrl);
    const listingUrl = absoluteUrl(node['url'], baseUrl);
    const applyUrl = absoluteUrl(node['applicationContact'] ?? node['directApplyUrl'], baseUrl) ?? listingUrl;
    const canonicalUrl = listingUrl ?? baseUrl;
    const physicalLocations = locations(node['jobLocation']);
    const description = text(node['description']);
    const resolvedIdentifier = identifier(node['identifier']);
    const evidence: Record<string, JobEvidence> = {};
    const record = (field: string, present: unknown): void => {
      if (present !== undefined && present !== null && !(Array.isArray(present) && present.length === 0)) {
        evidence[field] = { source: fieldSource, selector: 'JobPosting', extractedAt };
      }
    };

    const posting: ExtractedJobPosting = {
      sourceKey: (resolvedIdentifier ?? listingUrl ?? `${index}`).slice(0, 200),
      canonicalUrl,
      ...(applyUrl ? { applyUrl } : {}),
      title,
      ...(description ? { description } : {}),
      employerName,
      ...(employerUrl ? { employerUrl } : {}),
      ...(urlDomain(employerUrl) ? { employerDomain: urlDomain(employerUrl) } : {}),
      ...(employerLogoUrl ? { employerLogoUrl } : {}),
      ...(employerKey(employerName, employerUrl) ? { employerKey: employerKey(employerName, employerUrl) } : {}),
      locations: physicalLocations,
      applicantLocationRequirements: list(node['applicantLocationRequirements']),
      ...(workplaceType(node, physicalLocations) ? { workplaceType: workplaceType(node, physicalLocations) } : {}),
      employmentTypes: [...new Set(
        list(node['employmentType'])
          .map(normalizeEmploymentType)
          .filter((item): item is JobEmploymentType => Boolean(item)),
      )],
      ...(salary(node) ? { salary: salary(node) } : {}),
      skills: list(node['skills']),
      ...(text(node['qualifications']) ? { qualifications: text(node['qualifications']) } : {}),
      ...(text(node['responsibilities']) ? { responsibilities: text(node['responsibilities']) } : {}),
      ...(text(node['educationRequirements']) ? { educationRequirements: text(node['educationRequirements']) } : {}),
      ...(text(node['experienceRequirements']) ? { experienceRequirements: text(node['experienceRequirements']) } : {}),
      ...(text(node['industry']) ? { industry: text(node['industry']) } : {}),
      ...(text(node['occupationalCategory']) ? { occupationalCategory: text(node['occupationalCategory']) } : {}),
      ...(resolvedIdentifier ? { identifier: resolvedIdentifier } : {}),
      ...(typeof node['directApply'] === 'boolean' ? { directApply: node['directApply'] } : {}),
      ...(date(node['datePosted']) ? { publishedAt: date(node['datePosted']) } : {}),
      ...(date(node['validThrough']) ? { validThrough: date(node['validThrough']) } : {}),
      normalizedTitle: normalizeJobTitle(title),
      ...(descriptionFingerprint(description) ? { descriptionFingerprint: descriptionFingerprint(description) } : {}),
      evidence: {},
    };

    record('title', title);
    record('description', description);
    record('employer', employerName);
    record('employerUrl', employerUrl);
    record('employerLogoUrl', employerLogoUrl);
    record('locations', physicalLocations.length ? physicalLocations : undefined);
    record('applicantLocationRequirements', posting.applicantLocationRequirements.length ? posting.applicantLocationRequirements : undefined);
    record('workplaceType', posting.workplaceType);
    record('employmentTypes', posting.employmentTypes.length ? posting.employmentTypes : undefined);
    record('salary', posting.salary);
    record('skills', posting.skills.length ? posting.skills : undefined);
    record('qualifications', posting.qualifications);
    record('responsibilities', posting.responsibilities);
    record('educationRequirements', posting.educationRequirements);
    record('experienceRequirements', posting.experienceRequirements);
    record('industry', posting.industry);
    record('occupationalCategory', posting.occupationalCategory);
    record('identifier', posting.identifier);
    record('directApply', posting.directApply);
    record('publishedAt', posting.publishedAt);
    record('validThrough', posting.validThrough);
    record('applyUrl', applyUrl);
    record('canonicalUrl', listingUrl);
    posting.evidence = evidence;

    let key = posting.sourceKey;
    let suffix = 1;
    while (seenKeys.has(key)) { key = `${posting.sourceKey}#${suffix}`; suffix += 1; }
    seenKeys.add(key);
    posting.sourceKey = key;
    output.push(posting);
  });

  return output;
}
