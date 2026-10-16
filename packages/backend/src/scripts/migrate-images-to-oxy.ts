#!/usr/bin/env bun
import { createWriteStream } from 'node:fs';
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { migrateLegacyImages } from '../files/migrate-legacy-images.js';

/**
 * `bun run images:migrate-to-oxy -- --target-database=<db> [--apply]
 *   [--limit=N] [--batch=N] [--report=<file.jsonl>]`
 *
 * Copies the images Clarity kept itself into Clarity-owned Oxy files
 * (files/migrate-legacy-images.ts; docs/oxy-files.md). Without `--apply` it is a
 * preview: nothing is written and Oxy is not called. The target database must
 * be named, and must be the one `DATABASE_URL` connects to. The report has one
 * JSON line per image, naming it by SHA-256 only.
 */
function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = readTargetDatabase(argv);
  const apply = argv.includes('--apply');
  const limit = positiveInteger(flag(argv, 'limit'), 'limit');
  const batchSize = positiveInteger(flag(argv, 'batch'), 'batch');
  const reportPath = flag(argv, 'report');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  connectPostgres(process.env.DATABASE_URL);
  const [{ current }] = await getDb().execute<{ current: string }>(
    sql`select current_database() as current`,
  );
  if (current !== target) throw new Error(`Expected database ${target}, connected to ${current}`);

  const report = reportPath ? createWriteStream(reportPath, { flags: 'a' }) : undefined;
  try {
    const summary = await migrateLegacyImages({
      apply,
      limit,
      batchSize,
      report: (line) => {
        const text = `${JSON.stringify(line)}\n`;
        if (report) report.write(text);
        else process.stdout.write(text);
      },
    });
    console.info(JSON.stringify({ summary }, null, 2));
  } finally {
    await new Promise<void>((resolve) => (report ? report.end(resolve) : resolve()));
    await closePostgres();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
