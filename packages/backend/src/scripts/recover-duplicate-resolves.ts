#!/usr/bin/env bun
import { pathToFileURL } from 'node:url';
import { closePostgres, connectPostgres } from '../db/index.js';
import { recoverDuplicateResolves } from '../search/resolve-recovery.js';

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
  const ownerAccountId = read('owner-account-id');
  const applicationId = read('application-id');
  const before = read('before');
  if (!ownerAccountId || !applicationId || !before)
    throw new Error('--owner-account-id, --application-id and --before are required');
  connectPostgres(databaseUrl);
  try {
    console.info(
      JSON.stringify(
        await recoverDuplicateResolves(
          {
            ownerAccountId,
            applicationId,
            before: new Date(before),
            limit: Number(read('limit') ?? 1000),
          },
          args.includes('--apply'),
        ),
        null,
        2,
      ),
    );
  } finally {
    await closePostgres();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
