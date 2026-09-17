/**
 * Attaching canonical places to a listing's locations.
 *
 * Runs for every source at projection time. A place id the source claimed is
 * kept only if the gazetteer has it and it agrees with any country the source
 * stated; a locality without a claim is resolved only when it names exactly
 * one place inside the stated country. Everything else keeps its raw text and
 * no `placeId` — nothing is guessed.
 */
import type { JobLocation } from '@clarity/shared-types';
import type { CountryCode } from '@clarity.surf/sdk/vocabularies';

import { foldPlaceName, matchPlace, type PlaceCandidate, type PlaceResolver } from '../places/resolve.js';
import type { ExtractedJobPosting } from './extract.js';

/** Display text for a location that only named a place. */
export function placeLabel(place: Pick<PlaceCandidate, 'name' | 'admin1Name' | 'countryCode' | 'kind'>): string {
  return [place.name, place.kind === 'city' ? place.admin1Name : undefined, place.countryCode].filter(Boolean).join(', ');
}

function withPlace(location: JobLocation, place: PlaceCandidate): JobLocation {
  return {
    ...location,
    raw: location.raw || placeLabel(place),
    countryCode: location.countryCode ?? (place.countryCode as CountryCode),
    ...(place.kind === 'city' && !location.locality ? { locality: place.name } : {}),
    ...(place.kind === 'region' && !location.region ? { region: place.name } : {}),
    ...(place.kind === 'city' && !location.region && place.admin1Name ? { region: place.admin1Name } : {}),
    placeId: place.id,
  };
}

function withoutPlace(location: JobLocation): JobLocation | undefined {
  if (!location.raw) return undefined;
  const rest = { ...location };
  delete rest.placeId;
  return rest;
}

export async function resolveJobLocations(
  resolver: PlaceResolver,
  postings: readonly ExtractedJobPosting[],
): Promise<ExtractedJobPosting[]> {
  const locations = postings.flatMap((posting) => posting.locations);
  if (locations.length === 0) return [...postings];

  const claimedIds = locations.flatMap((location) => (location.placeId ? [location.placeId] : []));
  const lookups = locations.flatMap((location) =>
    !location.placeId && location.locality && location.countryCode
      ? [{ countryCode: location.countryCode as CountryCode, names: [foldPlaceName(location.locality)] }]
      : []);
  const [claimed, candidates] = await Promise.all([
    claimedIds.length > 0 ? resolver.byIds(claimedIds) : Promise.resolve([]),
    lookups.length > 0 ? resolver.candidates(lookups) : Promise.resolve([]),
  ]);
  const claimedById = new Map(claimed.map((place) => [place.id, place]));

  const resolve = (location: JobLocation): JobLocation | undefined => {
    if (location.placeId) {
      const place = claimedById.get(location.placeId);
      if (!place || (location.countryCode && location.countryCode !== place.countryCode)) return withoutPlace(location);
      return withPlace(location, place);
    }
    if (!location.locality || !location.countryCode) return location;
    const match = matchPlace(candidates, {
      countryCode: location.countryCode,
      locality: location.locality,
      ...(location.region ? { region: location.region } : {}),
    });
    return match.status === 'resolved' ? withPlace(location, match.place) : location;
  };

  return postings.map((posting) => {
    const seen = new Set<string>();
    const resolved = posting.locations.flatMap((location) => {
      const next = resolve(location);
      if (!next) return [];
      const key = next.placeId ? `place:${next.placeId}` : `raw:${next.raw}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [next];
    });
    return { ...posting, locations: resolved };
  });
}
