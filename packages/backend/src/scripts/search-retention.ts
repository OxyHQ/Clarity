#!/usr/bin/env bun
/**
 * One-shot: retention for the crawl audit and dead job listings
 * (`search/retention.ts`, docs/search-storage.md "Retention"). A DRY RUN
 * unless `--execute` and `--confirm-delete=<target database>` are both given:
 * deleting production data is the app owner's decision.
 *
 *   bun packages/backend/dist/db/search-retention.js --target-database=clarity \
 *     --target=crawl|job-vectors|job-documents [--days=30] [--include-stale] \
 *     [--window=1-7|always] [--batch-size=200] [--max-batch-ms=2000] \
 *     [--pause-ms=60000] [--duty-cycle=0.5] [--max-batches=N] [--after=<cursor>] \
 *     [--execute --confirm-delete=clarity]
 *
 * Idempotent and resumable: an interrupted run is run again, from the start or
 * from the `cursor` it logged (`--after`).
 */
import { pathToFileURL } from 'node:url';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import {
  DEFAULT_RETENTION_DAYS,
  RETENTION_TARGETS,
  type RetentionTarget,
  runRetention,
} from '../search/retention.js';
import { DEFAULT_OFF_PEAK_WINDOW, parseOffPeakWindow } from '../search/retention-pacing.js';

export interface RetentionArguments {
  databaseUrl: string;
  target: RetentionTarget;
  days: number;
  includeStale: boolean;
  execute: boolean;
  window: ReturnType<typeof parseOffPeakWindow>;
  batchSize: number;
  maxBatchMs: number;
  pauseMs: number;
  dutyCycle: number;
  maxBatches?: number;
  after: string | null;
}

/** Parses and checks the arguments; throws on anything that could delete by accident. */
export function parseRetentionArguments(
  args: readonly string[],
  databaseUrl: string | undefined,
): RetentionArguments {
  const read = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const flag = (name: string) => args.includes(`--${name}`);
  const database = read('target-database');
  if (
    !databaseUrl ||
    !database ||
    decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) !== database
  )
    throw new Error('DATABASE_URL and matching --target-database are required');
  const target = read('target') as RetentionTarget | undefined;
  if (!target || !RETENTION_TARGETS.includes(target))
    throw new Error(`--target must be one of ${RETENTION_TARGETS.join(', ')}`);
  const execute = flag('execute');
  if (execute && read('confirm-delete') !== database)
    throw new Error(`--execute deletes data: confirm it with --confirm-delete=${database}`);
  const integer = (name: string, fallback: number, min: number) => {
    const value = Number(read(name) ?? fallback);
    if (!Number.isInteger(value) || value < min)
      throw new Error(`--${name} must be an integer ≥ ${min}`);
    return value;
  };
  const dutyCycle = Number(read('duty-cycle') ?? 0.5);
  if (!(dutyCycle > 0 && dutyCycle <= 1)) throw new Error('--duty-cycle must be in (0, 1]');
  const windowText = read('window');
  const maxBatches = read('max-batches');
  return {
    databaseUrl,
    target,
    days: integer('days', DEFAULT_RETENTION_DAYS, 1),
    includeStale: flag('include-stale'),
    execute,
    window: windowText === undefined ? DEFAULT_OFF_PEAK_WINDOW : parseOffPeakWindow(windowText),
    batchSize: integer('batch-size', target === 'crawl' ? 1_000 : 200, 1),
    maxBatchMs: integer('max-batch-ms', 2_000, 1),
    pauseMs: integer('pause-ms', 60_000, 0),
    dutyCycle,
    maxBatches: maxBatches === undefined ? undefined : integer('max-batches', 0, 1),
    after: read('after') ?? null,
  };
}

async function main() {
  const options = parseRetentionArguments(process.argv.slice(2), process.env.DATABASE_URL);
  connectPostgres(options.databaseUrl);
  try {
    await runRetention(getDb(), {
      target: options.target,
      retentionDays: options.days,
      includeStale: options.includeStale,
      execute: options.execute,
      after: options.after,
      maxBatches: options.maxBatches,
      window: options.window,
      pacing: {
        batchSize: options.batchSize,
        minBatchSize: Math.min(25, options.batchSize),
        maxBatchMs: options.maxBatchMs,
        pauseMs: options.pauseMs,
        dutyCycle: options.dutyCycle,
      },
      log: (event, fields) =>
        console.info(JSON.stringify({ event, ...fields, at: new Date().toISOString() })),
    });
  } finally {
    await closePostgres();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
