#!/usr/bin/env bun
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_RUNS,
  type MigrationRun,
  readTargetDatabase,
  runMigrations,
} from '@oxyhq/db/migrate';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readPhase(argv: readonly string[]): MigrationRun {
  const flag = argv.find((arg) => arg.startsWith('--phase='));
  if (!flag) throw new Error(`--phase is required: ${MIGRATION_RUNS.join(', ')}`);
  const value = flag.slice('--phase='.length);
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(`Unknown phase ${JSON.stringify(value)}: ${MIGRATION_RUNS.join(', ')}`);
  }
  return value as MigrationRun;
}

export function isDryRun(argv: readonly string[]): boolean {
  return argv.includes('--dry-run');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const run = readPhase(argv);
  const expectedDatabase = readTargetDatabase(argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  await runMigrations({
    databaseUrl,
    migrationsFolder: join(packageRoot, 'drizzle'),
    extensions: [],
    run,
    expectedDatabase,
    dryRun: isDryRun(argv),
    logger: {
      info: (message) => console.info(message),
      debug: (message) => console.debug(message),
    },
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
