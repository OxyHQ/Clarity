/**
 * Parsing the GeoNames dumps into `clarity_places` rows.
 *
 * Source: https://download.geonames.org/export/dump/ — `cities15000.zip`
 * (every populated place with at least 15,000 people) and
 * `admin1CodesASCII.txt` (first-order subdivisions). GeoNames data is licensed
 * CC BY 4.0; the attribution lives in NOTICE and docs/jobs.mdx.
 *
 * Pure functions only, so the format handling is testable without a network
 * or a database. The operator script (`src/scripts/import-geonames-places.ts`)
 * downloads, parses and upserts.
 */
import { inflateRawSync } from 'node:zlib';

import { isCountryCode, type CountryCode, type PlaceKind } from '@clarity.surf/sdk/vocabularies';

import { foldPlaceName } from './resolve.js';

export const GEONAMES_DUMP_URL = 'https://download.geonames.org/export/dump';
export const GEONAMES_CITIES_FILE = 'cities15000.zip';
export const GEONAMES_ADMIN1_FILE = 'admin1CodesASCII.txt';

export interface PlaceRecord {
  id: string;
  kind: PlaceKind;
  name: string;
  asciiName: string;
  searchName: string;
  matchNames: string[];
  countryCode: CountryCode;
  admin1Code: string | null;
  admin1Name: string | null;
  subdivisionCode: string | null;
  population: number | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  featureCode: string | null;
  sourceModifiedAt: Date | null;
}

export interface Admin1Entry {
  id: string;
  countryCode: string;
  code: string;
  name: string;
  asciiName: string;
}

/**
 * Countries whose GeoNames admin1 code IS the ISO 3166-2 subdivision suffix.
 * Elsewhere GeoNames uses its own numbering (ES `56` is ISO `ES-CT`), and a
 * subdivision code is left empty rather than mapped by guesswork.
 */
const ISO_SUBDIVISION_COUNTRIES: ReadonlySet<string> = new Set(['BE', 'CH', 'GB', 'US']);

export function subdivisionCode(countryCode: string, admin1Code: string | null | undefined): string | null {
  if (!admin1Code || !ISO_SUBDIVISION_COUNTRIES.has(countryCode) || !/^[A-Z0-9]{1,3}$/.test(admin1Code)) return null;
  return `${countryCode}-${admin1Code}`;
}

/** Extracts one file from a ZIP archive (stored or deflated, no ZIP64). */
export function readZipEntry(archive: Buffer, fileName: string): Buffer {
  const minimumEnd = Math.max(0, archive.length - 65_557);
  let end = -1;
  for (let offset = archive.length - 22; offset >= minimumEnd; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('Not a ZIP archive: no end of central directory');
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== fileName) continue;
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt ZIP local header');
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${method}`);
  }
  throw new Error(`${fileName} not found in archive`);
}

/** `admin1CodesASCII.txt`: `CC.CODE<TAB>name<TAB>asciiname<TAB>geonameid`. */
export function parseAdmin1Codes(text: string): Map<string, Admin1Entry> {
  const entries = new Map<string, Admin1Entry>();
  for (const line of text.split('\n')) {
    const [key, name, asciiName, id] = line.replace(/\r$/, '').split('\t');
    if (!key || !name || !id || !/^\d+$/.test(id)) continue;
    const separator = key.indexOf('.');
    if (separator !== 2) continue;
    entries.set(key, { id, countryCode: key.slice(0, 2), code: key.slice(3), name, asciiName: asciiName || name });
  }
  return entries;
}

function uniqueFolded(values: readonly string[]): string[] {
  const output = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 100 || /^https?:/i.test(trimmed) || !/\p{L}/u.test(trimmed)) continue;
    const folded = foldPlaceName(trimmed);
    if (folded) output.add(folded);
  }
  return [...output];
}

function number(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ParsedGazetteer {
  records: PlaceRecord[];
  /** Rows skipped because their country is not an officially assigned ISO code (e.g. XK). */
  skippedCountries: Map<string, number>;
}

/**
 * `cities15000.txt` (the GeoNames "geoname" table, 19 tab-separated columns)
 * plus the admin1 table, as place records: every admin1 division as a
 * `region`, every populated place as a `city`.
 */
export function parseGazetteer(citiesText: string, admin1: ReadonlyMap<string, Admin1Entry>): ParsedGazetteer {
  const records: PlaceRecord[] = [];
  const skippedCountries = new Map<string, number>();
  const skip = (country: string) => skippedCountries.set(country, (skippedCountries.get(country) ?? 0) + 1);

  for (const entry of admin1.values()) {
    if (!isCountryCode(entry.countryCode)) { skip(entry.countryCode); continue; }
    records.push({
      id: entry.id,
      kind: 'region',
      name: entry.name,
      asciiName: entry.asciiName,
      searchName: foldPlaceName(entry.asciiName),
      matchNames: uniqueFolded([entry.name, entry.asciiName]),
      countryCode: entry.countryCode,
      admin1Code: entry.code,
      admin1Name: entry.name,
      subdivisionCode: subdivisionCode(entry.countryCode, entry.code),
      population: null,
      latitude: null,
      longitude: null,
      timezone: null,
      featureCode: 'ADM1',
      sourceModifiedAt: null,
    });
  }

  for (const line of citiesText.split('\n')) {
    const columns = line.replace(/\r$/, '').split('\t');
    if (columns.length < 19) continue;
    const [id, name, asciiName, alternateNames, latitude, longitude, featureClass, featureCode, countryCode,
      , admin1Code, , , , population, , , timezone, modified] = columns;
    if (!/^\d+$/.test(id) || !name || featureClass !== 'P') continue;
    if (!isCountryCode(countryCode)) { skip(countryCode); continue; }
    const region = admin1Code ? admin1.get(`${countryCode}.${admin1Code}`) : undefined;
    const modifiedAt = /^\d{4}-\d{2}-\d{2}$/.test(modified ?? '') ? new Date(`${modified}T00:00:00Z`) : null;
    records.push({
      id,
      kind: 'city',
      name,
      asciiName: asciiName || name,
      searchName: foldPlaceName(asciiName || name),
      matchNames: uniqueFolded([name, asciiName, ...(alternateNames ? alternateNames.split(',') : [])]),
      countryCode,
      admin1Code: admin1Code || null,
      admin1Name: region?.name ?? null,
      subdivisionCode: subdivisionCode(countryCode, admin1Code),
      population: number(population),
      latitude: number(latitude),
      longitude: number(longitude),
      timezone: timezone || null,
      featureCode: featureCode || null,
      sourceModifiedAt: modifiedAt,
    });
  }
  return { records, skippedCountries };
}
