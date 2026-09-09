/**
 * Conservative, reversible canonicalization for Clarity Jobs.
 *
 * The same opening is frequently published on the employer's careers site, an
 * ATS-hosted page, one or more job boards and a first-party Oxy product. Those
 * rows are all kept: grouping only assigns a shared cluster and elects one
 * canonical member to show. Nothing is merged away, so unlinking a bad group is
 * a matter of clearing `cluster_id` and the signature rows.
 *
 * Two listings only join when they share at least one signature below. A
 * similar title alone is never enough.
 */
import type { JobSourceType } from '@clarity/shared-types';

import { urlDomain } from './taxonomy.js';

export type JobSignatureKind = 'identifier' | 'listing_url' | 'content';

export interface JobSignature {
  kind: JobSignatureKind;
  value: string;
}

/**
 * Public ATS hosts. Membership only affects which copy is elected canonical —
 * never a listing's search position.
 */
export const ATS_HOSTS: readonly string[] = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'myworkdayjobs.com',
  'workday.com', 'smartrecruiters.com', 'jobvite.com', 'bamboohr.com', 'recruitee.com',
  'teamtailor.com', 'personio.com', 'personio.de', 'breezy.hr', 'jazzhr.com', 'icims.com',
  'taleo.net', 'successfactors.com', 'pinpointhq.com', 'join.com', 'factorialhr.com',
  'applytojob.com', 'workatastartup.com',
];

const TRACKING_PARAMETERS = /^(utm_|gh_|mc_|hsa_|pk_)|^(ref|source|src|gclid|fbclid|msclkid|trk|referrer|campaign)$/i;

/** Strips presentation-only URL noise so syndicated links compare equal. */
export function normalizeListingUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.protocol = 'https:';
  url.port = '';
  const parameters = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMETERS.test(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  url.search = '';
  for (const [key, parameterValue] of parameters) url.searchParams.append(key, parameterValue);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.hostname}${pathname}${url.search}`;
}

export interface JobSignatureInput {
  employerKey?: string;
  identifier?: string;
  canonicalUrl: string;
  applyUrl?: string;
  normalizedTitle: string;
  descriptionFingerprint?: string;
  locations: readonly { countryCode?: string; locality?: string; raw: string }[];
}

function primaryLocationKey(locations: JobSignatureInput['locations']): string | undefined {
  const first = locations[0];
  if (!first) return undefined;
  return (first.countryCode ?? '') + '/' + (first.locality ?? first.raw).toLowerCase();
}

/**
 * Every signature this listing can be grouped by. Order is irrelevant; any
 * single match is enough to join an existing cluster.
 */
export function jobClusterSignatures(job: JobSignatureInput): JobSignature[] {
  const signatures: JobSignature[] = [];

  if (job.employerKey && job.identifier && job.identifier.trim().length >= 3) {
    signatures.push({ kind: 'identifier', value: `${job.employerKey}|id|${job.identifier.trim().toLowerCase()}` });
  }

  for (const candidate of [job.canonicalUrl, job.applyUrl]) {
    const normalized = candidate ? normalizeListingUrl(candidate) : undefined;
    if (normalized) signatures.push({ kind: 'listing_url', value: `url|${normalized}` });
  }

  const location = primaryLocationKey(job.locations);
  if (job.employerKey && job.descriptionFingerprint && job.normalizedTitle && location) {
    signatures.push({
      kind: 'content',
      value: `${job.employerKey}|content|${job.normalizedTitle}|${location}|${job.descriptionFingerprint}`,
    });
  }

  return [...new Map(signatures.map((signature) => [signature.value, signature])).values()];
}

export function isAtsHost(host: string | undefined): boolean {
  if (!host) return false;
  return ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`));
}

/**
 * Which copy of a grouped opening Clarity shows. Lower wins.
 *
 * 0 the employer's own domain, 1 a public ATS, 2 a Clarity-verified site,
 * 3 anything else. Source type never promotes a first-party product above the
 * employer's own canonical page.
 */
export function canonicalSourceRank(input: {
  canonicalUrl: string;
  employerDomain?: string;
  sourceType: JobSourceType;
}): number {
  const host = urlDomain(input.canonicalUrl);
  if (host && input.employerDomain && (host === input.employerDomain || host.endsWith(`.${input.employerDomain}`))) return 0;
  if (isAtsHost(host)) return 1;
  if (input.sourceType === 'verified_site') return 2;
  return 3;
}
