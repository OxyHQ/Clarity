#!/usr/bin/env bun
/**
 * Populates `clarity_places` from GeoNames (CC BY 4.0).
 *
 *   DATABASE_URL=postgresql://... bun run --filter @clarity/backend places:import -- \
 *     --target-database=clarity_ci [--dry-run] [--source-dir=/path/with/dumps]
 *
 * Downloads `cities15000.zip` and `admin1CodesASCII.txt` at run time (nothing
 * is committed), or reads them from `--source-dir`. Idempotent: every row is an
 * upsert keyed by GeoNames id, so a re-run converges on the current dump. Rows
 * GeoNames later drops are left in place, because job locations may reference
 * their ids.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { readTargetDatabase } from '@oxy.so/db/migrate';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { places } from '../db/schema/index.js';
import {
  GEONAMES_ADMIN1_FILE, GEONAMES_CITIES_FILE, GEONAMES_DUMP_URL,
  parseAdmin1Codes, parseGazetteer, readZipEntry, type PlaceRecord,
} from '../search/places/geonames.js';

const BATCH_SIZE = 500;

async function load(name: string, sourceDir: string | undefined): Promise<Buffer> {
  if (sourceDir) return readFile(join(sourceDir, name));
  const response = await fetch(`${GEONAMES_DUMP_URL}/${name}`, {
    headers: { 'User-Agent': 'ClarityBot/0.1 (+https://clarity.surf/bot)' },
  });
  if (!response.ok) throw new Error(`GeoNames ${name} responded ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function upsertSet(): Record<string, unknown> {
  return {
    kind: sql`excluded.kind`,
    name: sql`excluded.name`,
    asciiName: sql`excluded.ascii_name`,
    searchName: sql`excluded.search_name`,
    matchNames: sql`excluded.match_names`,
    countryCode: sql`excluded.country_code`,
    admin1Code: sql`excluded.admin1_code`,
    admin1Name: sql`excluded.admin1_name`,
    subdivisionCode: sql`excluded.subdivision_code`,
    population: sql`excluded.population`,
    latitude: sql`excluded.latitude`,
    longitude: sql`excluded.longitude`,
    timezone: sql`excluded.timezone`,
    featureCode: sql`excluded.feature_code`,
    sourceModifiedAt: sql`excluded.source_modified_at`,
    updatedAt: sql`now()`,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetDatabase = readTargetDatabase(argv);
  const dryRun = argv.includes('--dry-run');
  const sourceDir = argv.find((arg) => arg.startsWith('--source-dir='))?.slice('--source-dir='.length);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const [citiesArchive, admin1File] = await Promise.all([
    load(GEONAMES_CITIES_FILE, sourceDir),
    load(GEONAMES_ADMIN1_FILE, sourceDir),
  ]);
  const citiesText = readZipEntry(citiesArchive, GEONAMES_CITIES_FILE.replace(/\.zip$/, '.txt')).toString('utf8');
  const { records, skippedCountries } = parseGazetteer(citiesText, parseAdmin1Codes(admin1File.toString('utf8')));
  const cities = records.filter((record) => record.kind === 'city').length;
  console.info(`Parsed ${cities} cities and ${records.length - cities} regions from GeoNames`);
  if (skippedCountries.size > 0) {
    console.info(`Skipped rows outside COUNTRY_CODES: ${[...skippedCountries].map(([code, count]) => `${code}=${count}`).join(', ')}`);
  }

  connectPostgres(process.env.DATABASE_URL);
  const database = getDb();
  try {
    // Checked before any write, on the connection that will do the writing.
    const [current] = await database.execute<{ name: string }>(sql`select current_database() as name`);
    if (current?.name !== targetDatabase) {
      throw new Error(`Connected to database ${JSON.stringify(current?.name)}, not --target-database=${targetDatabase}`);
    }
    if (dryRun) {
      console.info(`Dry run: would upsert ${records.length} places into ${targetDatabase}`);
      return;
    }
    await database.transaction(async (tx) => {
      for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
        const batch: PlaceRecord[] = records.slice(offset, offset + BATCH_SIZE);
        await tx.insert(places).values(batch).onConflictDoUpdate({ target: places.id, set: upsertSet() });
      }
    });
    console.info(`Upserted ${records.length} places into ${targetDatabase}`);
  } finally {
    await closePostgres();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
