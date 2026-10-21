#!/usr/bin/env bun
/**
 * One-shot: copy each listing's full-text vector into its inline table, build
 * its index and record it (`search/jobs/search-vectors-copy.ts`).
 * Idempotent: an interrupted run is run again.
 *
 *   bun packages/backend/dist/db/copy-job-search-vectors.js --target-database=clarity
 *     [--batch-size=1000] [--duty-cycle=0.5]
 */
import { pathToFileURL } from 'node:url';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { copyJobSearchVectors } from '../search/jobs/search-vectors-copy.js';

async function main() {
  const args = process.argv.slice(2);
  const read = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const databaseUrl = process.env.DATABASE_URL;
  const target = read('target-database');
  if (
    !databaseUrl ||
    !target ||
    decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) !== target
  ) {
    throw new Error('DATABASE_URL and matching --target-database are required');
  }
  const batchSize = Number(read('batch-size') ?? 1000);
  const dutyCycle = Number(read('duty-cycle') ?? 0.5);
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error('--batch-size must be a positive integer');
  if (!(dutyCycle > 0 && dutyCycle <= 1)) throw new Error('--duty-cycle must be in (0, 1]');
  connectPostgres(databaseUrl);
  try {
    const result = await copyJobSearchVectors(getDb(), {
      batchSize,
      dutyCycle,
      log: (event, fields) =>
        console.info(JSON.stringify({ event, ...fields, at: new Date().toISOString() })),
    });
    console.info(JSON.stringify({ event: 'done', ...result }));
  } finally {
    await closePostgres();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
