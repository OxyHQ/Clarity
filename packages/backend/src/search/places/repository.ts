/**
 * Reads over `clarity_places`. The gazetteer is reference data: nothing in the
 * request path writes to it (the operator import does).
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  COUNTRY_CODES, PLACE_KINDS, type CountryCode, type PlaceKind,
} from '@clarity.surf/sdk/vocabularies';
import type { Place } from '@clarity.surf/sdk';

import { getDb, type ClarityExecutor } from '../../db/index.js';
import { places } from '../../db/schema/index.js';
import { escapeLike } from '../query-primitives.js';
import { foldPlaceName, type PlaceCandidate, type PlaceResolver } from './resolve.js';

type PlaceRow = typeof places.$inferSelect;

export const placeSearchSchema = z.object({
  q: z.string().trim().min(1).max(100),
  countryCode: z.string().trim().toUpperCase().pipe(z.enum(COUNTRY_CODES)).optional(),
  kind: z.enum(PLACE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type PlaceSearchInput = z.infer<typeof placeSearchSchema>;

export function serializePlace(row: PlaceRow): Place {
  return {
    id: row.id,
    kind: row.kind as PlaceKind,
    name: row.name,
    asciiName: row.asciiName,
    countryCode: row.countryCode as CountryCode,
    ...(row.admin1Code ? { admin1Code: row.admin1Code } : {}),
    ...(row.admin1Name ? { admin1Name: row.admin1Name } : {}),
    ...(row.subdivisionCode ? { subdivisionCode: row.subdivisionCode } : {}),
    ...(row.population === null ? {} : { population: row.population }),
    ...(row.latitude === null ? {} : { latitude: row.latitude }),
    ...(row.longitude === null ? {} : { longitude: row.longitude }),
    ...(row.timezone ? { timezone: row.timezone } : {}),
  };
}

/**
 * Exact names in any language first (`München` finds Munich), then name
 * prefixes, then close spellings; each tier ordered by population.
 */
export async function searchPlaces(input: PlaceSearchInput): Promise<Place[]> {
  const folded = foldPlaceName(input.q);
  if (!folded) return [];
  const prefix = `${escapeLike(folded)}%`;
  const exact = sql`${places.matchNames} @> array[${folded}]::text[]`;
  const filters: SQL[] = [sql`(${exact} or ${places.searchName} like ${prefix} escape '\\' or ${places.searchName} % ${folded})`];
  if (input.countryCode) filters.push(eq(places.countryCode, input.countryCode));
  if (input.kind) filters.push(eq(places.kind, input.kind));
  const rows = await getDb().select().from(places)
    .where(and(...filters))
    .orderBy(
      sql`(${exact}) desc`,
      sql`(${places.searchName} like ${prefix} escape '\\') desc`,
      sql`${places.population} desc nulls last`,
      places.id,
    )
    .limit(input.limit);
  return rows.map(serializePlace);
}

export async function getPlace(id: string): Promise<Place | undefined> {
  if (!/^\d{1,12}$/.test(id)) return undefined;
  const [row] = await getDb().select().from(places).where(eq(places.id, id)).limit(1);
  return row ? serializePlace(row) : undefined;
}

const candidateColumns = {
  id: places.id,
  kind: places.kind,
  name: places.name,
  asciiName: places.asciiName,
  countryCode: places.countryCode,
  admin1Name: places.admin1Name,
  matchNames: places.matchNames,
  population: places.population,
};

function toCandidate(row: { kind: string; population: number | null } & Omit<PlaceCandidate, 'kind' | 'population'>): PlaceCandidate {
  return { ...row, kind: row.kind as PlaceKind, population: row.population ?? 0 };
}

/** The database-backed resolver used by ingestion and projection. */
export function createPlaceResolver(executor: ClarityExecutor = getDb()): PlaceResolver {
  let empty: boolean | undefined;
  return {
    async candidates(queries) {
      const byCountry = new Map<string, Set<string>>();
      for (const query of queries) {
        const names = byCountry.get(query.countryCode) ?? new Set<string>();
        for (const name of query.names) if (name) names.add(name);
        byCountry.set(query.countryCode, names);
      }
      const clauses = [...byCountry.entries()]
        .filter(([, names]) => names.size > 0)
        .map(([countryCode, names]) => and(
          eq(places.countryCode, countryCode),
          sql`${places.matchNames} && array[${sql.join([...names].map((name) => sql`${name}`), sql`, `)}]::text[]`,
        ));
      if (clauses.length === 0) return [];
      const rows = await executor.select(candidateColumns).from(places)
        .where(sql.join(clauses.map((clause) => sql`(${clause})`), sql` or `))
        .limit(500);
      return rows.map(toCandidate);
    },
    async byIds(ids) {
      const valid = [...new Set(ids.filter((id) => /^\d{1,12}$/.test(id)))];
      if (valid.length === 0) return [];
      const rows = await executor.select(candidateColumns).from(places).where(inArray(places.id, valid));
      return rows.map(toCandidate);
    },
    async isEmpty() {
      if (empty === undefined) {
        const [row] = await executor.select({ id: places.id }).from(places).limit(1);
        empty = !row;
      }
      return empty;
    },
  };
}
