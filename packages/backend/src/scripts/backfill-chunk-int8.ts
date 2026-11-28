#!/usr/bin/env bun
/**
 * One-shot: give every chunk embedded before the int8 store its int8 vector
 * (`search/int8-backfill.ts`, docs/adr/0001-search-storage-diet.md, phase 2).
 * Inserts only; idempotent; resumable with --from-page.
 *
 *   bun packages/backend/dist/db/backfill-chunk-int8.js --target-database=clarity
 *     [--pages-per-batch=500] [--duty-cycle=0.5] [--from-page=0] [--max-batches=N]
 */
import { pathToFileURL } from 'node:url';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { backfillInt8Vectors } from '../search/int8-backfill.js';

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
  const pagesPerBatch = Number(read('pages-per-batch') ?? 500);
  const dutyCycle = Number(read('duty-cycle') ?? 0.5);
  const fromPage = Number(read('from-page') ?? 0);
  const maxBatches = read('max-batches') === undefined ? undefined : Number(read('max-batches'));
  if (!Number.isInteger(pagesPerBatch) || pagesPerBatch < 1)
    throw new Error('--pages-per-batch must be a positive integer');
  if (!(dutyCycle > 0 && dutyCycle <= 1)) throw new Error('--duty-cycle must be in (0, 1]');
  if (!Number.isInteger(fromPage) || fromPage < 0)
    throw new Error('--from-page must be a page number');
  if (maxBatches !== undefined && (!Number.isInteger(maxBatches) || maxBatches < 1))
    throw new Error('--max-batches must be a positive integer');
  connectPostgres(databaseUrl);
  try {
    const result = await backfillInt8Vectors(getDb(), {
      pagesPerBatch,
      dutyCycle,
      fromPage,
      maxBatches,
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
