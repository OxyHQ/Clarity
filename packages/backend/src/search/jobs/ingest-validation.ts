/**
 * The contract a FIRST-PARTY publisher's `JobPosting` must meet.
 *
 * Crawled pages and feeds are third parties: Clarity never rejects them, it
 * drops what does not fit the vocabularies. A publisher calling
 * `POST /v1/jobs/ingest` controls its payload, so the same vocabularies are
 * enforced as errors instead — an unknown currency, an arbitrary country or a
 * city Clarity cannot identify is a 400 with one issue per field, never a
 * listing that silently loses its salary or location.
 */
import {
  JOB_SALARY_INTERVALS, isCountryCode, isCurrencyCode, type CountryCode,
} from '@clarity.surf/sdk/vocabularies';

import { foldPlaceName, geonamesIdFromUri, matchPlace, type PlaceResolver } from '../places/resolve.js';
import { jobPostingNodes } from './extract.js';

export type JobPostingIssueCode =
  | 'job_posting_required' | 'title_required' | 'hiring_organization_required'
  | 'invalid_salary' | 'currency_required' | 'unknown_currency'
  | 'salary_interval_required' | 'unknown_salary_interval'
  | 'salary_amount_required' | 'invalid_salary_amount' | 'salary_range_inverted'
  | 'invalid_location' | 'structured_address_required' | 'unknown_country' | 'country_required'
  | 'invalid_place_reference' | 'unknown_place' | 'ambiguous_place' | 'place_country_mismatch';

export interface JobPostingIssue {
  /** Dotted path inside the request body, e.g. `jobPosting.baseSalary.currency`. */
  path: string;
  code: JobPostingIssueCode;
  message: string;
  /** For `ambiguous_place`: the GeoNames ids that matched, most populous first. */
  candidates?: string[];
}

export interface JobPostingValidation {
  issues: JobPostingIssue[];
  /** A location needed the gazetteer and none has been imported. */
  placesUnavailable: boolean;
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (isNode(value) && typeof value['name'] === 'string') return value['name'].trim() || undefined;
  return undefined;
}

function amountIssue(value: unknown): boolean {
  return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
}

function validateSalary(node: Node, path: string, issues: JobPostingIssue[]): void {
  asList(node['baseSalary']).forEach((entry, index, all) => {
    const at = all.length > 1 ? `${path}.baseSalary[${index}]` : `${path}.baseSalary`;
    if (!isNode(entry)) {
      issues.push({ path: at, code: 'invalid_salary', message: 'baseSalary must be a MonetaryAmount object' });
      return;
    }
    const currency = entry['currency'] ?? entry['salaryCurrency'] ?? node['salaryCurrency'];
    if (currency === undefined) {
      issues.push({ path: `${at}.currency`, code: 'currency_required', message: 'baseSalary.currency is required' });
    } else if (!isCurrencyCode(currency)) {
      issues.push({ path: `${at}.currency`, code: 'unknown_currency', message: 'currency must be an active ISO 4217 code from CURRENCY_CODES, e.g. "EUR"' });
    }

    const value = entry['value'];
    const quantitative = isNode(value) ? value : undefined;
    const unit = quantitative?.['unitText'] ?? entry['unitText'];
    if (unit === undefined) {
      issues.push({ path: `${at}.value.unitText`, code: 'salary_interval_required', message: 'unitText is required' });
    } else if (typeof unit !== 'string' || !(JOB_SALARY_INTERVALS as readonly string[]).includes(unit.toLowerCase())) {
      issues.push({ path: `${at}.value.unitText`, code: 'unknown_salary_interval', message: `unitText must be one of ${JOB_SALARY_INTERVALS.map((item) => item.toUpperCase()).join(', ')}` });
    }

    const amounts: [string, unknown][] = quantitative
      ? (['minValue', 'maxValue', 'value'] as const).filter((key) => quantitative[key] !== undefined).map((key) => [`${at}.value.${key}`, quantitative[key]])
      : value === undefined ? [] : [[`${at}.value`, value]];
    if (amounts.length === 0) {
      issues.push({ path: `${at}.value`, code: 'salary_amount_required', message: 'State minValue/maxValue or value' });
      return;
    }
    let invalid = false;
    for (const [amountPath, amount] of amounts) {
      if (amountIssue(amount)) {
        invalid = true;
        issues.push({ path: amountPath, code: 'invalid_salary_amount', message: 'Amounts must be finite, non-negative numbers' });
      }
    }
    const min = quantitative?.['minValue'];
    const max = quantitative?.['maxValue'];
    if (!invalid && typeof min === 'number' && typeof max === 'number' && min > max) {
      issues.push({ path: `${at}.value`, code: 'salary_range_inverted', message: 'minValue must not exceed maxValue' });
    }
  });
}

interface PendingPlace {
  path: string;
  countryCode?: CountryCode;
  locality?: string;
  region?: string;
  placeId?: string;
}

function readLocations(node: Node, path: string, issues: JobPostingIssue[]): PendingPlace[] {
  const pending: PendingPlace[] = [];
  asList(node['jobLocation']).forEach((entry, index, all) => {
    const at = all.length > 1 ? `${path}.jobLocation[${index}]` : `${path}.jobLocation`;
    if (!isNode(entry)) {
      issues.push({ path: at, code: 'invalid_location', message: 'jobLocation must be a Place object' });
      return;
    }
    const address = entry['address'];
    if (typeof address === 'string') {
      issues.push({ path: `${at}.address`, code: 'structured_address_required', message: 'address must be a PostalAddress with addressCountry (and addressLocality for a city)' });
      return;
    }
    const postal = isNode(address) ? address : {};
    const location: PendingPlace = { path: at };

    const sameAs = entry['sameAs'];
    if (sameAs !== undefined) {
      const placeId = geonamesIdFromUri(sameAs);
      if (!placeId) {
        issues.push({ path: `${at}.sameAs`, code: 'invalid_place_reference', message: 'sameAs must be a GeoNames URI: https://www.geonames.org/<placeId>' });
        return;
      }
      location.placeId = placeId;
    }

    const country = postal['addressCountry'];
    if (country !== undefined) {
      const code = stringValue(country);
      if (!isCountryCode(code)) {
        issues.push({ path: `${at}.address.addressCountry`, code: 'unknown_country', message: 'addressCountry must be an ISO 3166-1 alpha-2 code from COUNTRY_CODES, e.g. "ES"' });
        return;
      }
      location.countryCode = code;
    }
    const locality = stringValue(postal['addressLocality']);
    const region = stringValue(postal['addressRegion']);
    if (locality) location.locality = locality;
    if (region) location.region = region;

    if (!location.placeId && !location.countryCode) {
      issues.push({ path: `${at}.address.addressCountry`, code: 'country_required', message: 'State addressCountry, or reference the place with sameAs' });
      return;
    }
    pending.push(location);
  });
  return pending;
}

export async function validateJobPostingPayload(
  structuredData: readonly unknown[],
  resolver: PlaceResolver,
): Promise<JobPostingValidation> {
  const issues: JobPostingIssue[] = [];
  const nodes = jobPostingNodes(structuredData);
  if (nodes.length === 0) {
    return { issues: [{ path: 'jobPosting', code: 'job_posting_required', message: 'jobPosting must contain a schema.org JobPosting' }], placesUnavailable: false };
  }

  const pending: PendingPlace[] = [];
  nodes.forEach((node, index) => {
    const path = nodes.length > 1 ? `jobPosting[${index}]` : 'jobPosting';
    if (!stringValue(node['title'])) issues.push({ path: `${path}.title`, code: 'title_required', message: 'title is required' });
    const organization = node['hiringOrganization'];
    if (!stringValue(organization)) {
      issues.push({ path: `${path}.hiringOrganization.name`, code: 'hiring_organization_required', message: 'hiringOrganization.name is required' });
    }
    validateSalary(node, path, issues);
    pending.push(...readLocations(node, path, issues));
  });

  const needsPlaces = pending.filter((location) => location.placeId || location.locality);
  if (needsPlaces.length === 0) return { issues, placesUnavailable: false };
  if (await resolver.isEmpty()) return { issues, placesUnavailable: true };

  const [claimed, candidates] = await Promise.all([
    resolver.byIds(needsPlaces.flatMap((location) => (location.placeId ? [location.placeId] : []))),
    resolver.candidates(needsPlaces.flatMap((location) =>
      !location.placeId && location.locality && location.countryCode
        ? [{ countryCode: location.countryCode, names: [foldPlaceName(location.locality)] }]
        : [])),
  ]);
  const claimedById = new Map(claimed.map((place) => [place.id, place]));

  for (const location of needsPlaces) {
    if (location.placeId) {
      const place = claimedById.get(location.placeId);
      if (!place) {
        issues.push({ path: `${location.path}.sameAs`, code: 'unknown_place', message: `No Clarity place has id ${location.placeId}` });
      } else if (location.countryCode && place.countryCode !== location.countryCode) {
        issues.push({ path: `${location.path}.address.addressCountry`, code: 'place_country_mismatch', message: `Place ${place.id} is in ${place.countryCode}` });
      }
      continue;
    }
    const match = matchPlace(candidates, {
      countryCode: location.countryCode!,
      locality: location.locality!,
      ...(location.region ? { region: location.region } : {}),
    });
    if (match.status === 'not_found') {
      issues.push({ path: `${location.path}.address.addressLocality`, code: 'unknown_place', message: 'addressLocality does not name a known place in addressCountry; pick one from GET /v1/places/search and send it as sameAs' });
    } else if (match.status === 'ambiguous') {
      issues.push({
        path: `${location.path}.address.addressLocality`,
        code: 'ambiguous_place',
        message: 'addressLocality names more than one place; send the intended one as sameAs',
        candidates: match.candidates.slice(0, 5).map((candidate) => candidate.id),
      });
    }
  }
  return { issues, placesUnavailable: false };
}
