/**
 * Resolving a listing's location to a canonical {@link Place}.
 *
 * Resolution never guesses. A locality becomes a `placeId` only when it names
 * exactly one place inside a country the source stated: an exact name match
 * wins over an alternate-name match, a stated region breaks a tie, and
 * anything still ambiguous stays unresolved — its raw text is kept.
 */
import type { CountryCode, PlaceKind } from '@clarity.surf/sdk/vocabularies';

import { foldCase } from '../jobs/taxonomy.js';

export interface PlaceCandidate {
  id: string;
  kind: PlaceKind;
  name: string;
  asciiName: string;
  countryCode: string;
  admin1Name: string | null;
  matchNames: readonly string[];
  population: number;
}

export interface PlaceResolver {
  /** Places whose `matchNames` contain any of the folded names, inside those countries. */
  candidates(queries: readonly { countryCode: CountryCode; names: readonly string[] }[]): Promise<PlaceCandidate[]>;
  byIds(ids: readonly string[]): Promise<PlaceCandidate[]>;
  /** True when no gazetteer has been imported. */
  isEmpty(): Promise<boolean>;
}

export type PlaceMatch =
  | { status: 'resolved'; place: PlaceCandidate }
  | { status: 'ambiguous'; candidates: PlaceCandidate[] }
  | { status: 'not_found' };

/** Canonical folding for place names on both sides of a match. */
export function foldPlaceName(value: string): string {
  return foldCase(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** GeoNames reference a publisher states in `jobLocation.sameAs`. */
const GEONAMES_URI = /^https?:\/\/(?:www\.|sws\.)?geonames\.org\/(\d{1,12})(?:[/?#].*)?$/i;

export function geonamesIdFromUri(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const match = GEONAMES_URI.exec(candidate.trim());
    if (match) return String(Number(match[1]));
  }
  return undefined;
}

/**
 * Picks the one place a locality names inside a country, from candidates the
 * resolver returned for that country.
 */
export function matchPlace(
  candidates: readonly PlaceCandidate[],
  input: { countryCode: string; locality: string; region?: string },
): PlaceMatch {
  const locality = foldPlaceName(input.locality);
  if (!locality) return { status: 'not_found' };
  const inCountry = candidates.filter((candidate) => candidate.countryCode === input.countryCode && candidate.kind === 'city');
  const exact = inCountry.filter((candidate) =>
    foldPlaceName(candidate.name) === locality || foldPlaceName(candidate.asciiName) === locality);
  const tier = exact.length > 0 ? exact : inCountry.filter((candidate) => candidate.matchNames.includes(locality));
  if (tier.length === 0) return { status: 'not_found' };
  if (tier.length === 1) return { status: 'resolved', place: tier[0] };

  const region = input.region ? foldPlaceName(input.region) : '';
  if (region) {
    const inRegion = tier.filter((candidate) => candidate.admin1Name && foldPlaceName(candidate.admin1Name) === region);
    if (inRegion.length === 1) return { status: 'resolved', place: inRegion[0] };
  }
  return { status: 'ambiguous', candidates: [...tier].sort((left, right) => right.population - left.population) };
}
