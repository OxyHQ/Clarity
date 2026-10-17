#!/usr/bin/env bun
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { reconcileDueReferences } from '../files/references.js';

/**
 * `bun run images:reconcile-references -- --target-database=<db> [--apply]`
 *
 * Oxy ADR 0043 D6 for Clarity's three entity types (docs/oxy-files.md): without
 * `--apply` a DRY RUN — Oxy reports, per entity type, the uses it would add,
 * remove and refuse, and changes nothing (nor the worker's schedule). With
 * `--apply` every entity type is reconciled now, live, and the worker's next
 * nightly run is a day on. Review the dry run first.
 *
 * In production it runs as a one-shot ECS task on the clarity-api task
 * definition, the only place Clarity's attested identity exists:
 * `bun packages/backend/dist/files/reconcile-references.js --target-database=clarity`.
 * Exits 1 if any entity type failed.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = readTargetDatabase(argv);
  const apply = argv.includes('--apply');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  connectPostgres(process.env.DATABASE_URL);
  try {
    const [{ current }] = await getDb().execute<{ current: string }>(
      sql`select current_database() as current`,
    );
    if (current !== target) throw new Error(`Expected database ${target}, connected to ${current}`);
    const outcome = await reconcileDueReferences(apply ? { force: true } : { dryRun: true });
    console.info(JSON.stringify({ dryRun: !apply, outcome }, null, 2));
    const failed = Object.values(outcome).some(
      (result) => typeof result === 'object' && result !== null && 'error' in result,
    );
    process.exitCode = failed ? 1 : 0;
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
