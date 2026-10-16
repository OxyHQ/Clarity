#!/usr/bin/env bun
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { storageRetirementStatus } from '../files/legacy-reads.js';

/**
 * `bun run images:storage-status -- --target-database=<db>`
 *
 * Whether Clarity's own image storage may be retired (docs/oxy-files.md): the
 * legacy reads of the last 14 days and the copies not yet in Oxy. Read only.
 * Exits 0 when ready, 2 when not, so a runbook can gate on it.
 */
async function main(): Promise<void> {
  const target = readTargetDatabase(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  connectPostgres(process.env.DATABASE_URL);
  try {
    const [{ current }] = await getDb().execute<{ current: string }>(
      sql`select current_database() as current`,
    );
    if (current !== target) throw new Error(`Expected database ${target}, connected to ${current}`);
    const status = await storageRetirementStatus();
    console.info(JSON.stringify(status, null, 2));
    process.exitCode = status.ready ? 0 : 2;
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
