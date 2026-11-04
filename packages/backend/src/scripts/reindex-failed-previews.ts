#!/usr/bin/env bun
import { pathToFileURL } from 'node:url';
import { closePostgres, connectPostgres } from '../db/index.js';
import {
  REINDEX_CAUSES,
  type ReindexCause,
  reindexFailedPreviews,
} from '../search/preview-reindex.js';

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
  const since = read('since');
  if (!ownerAccountId || !applicationId || !since)
    throw new Error('--owner-account-id, --application-id and --since are required');
  const causes = (read('causes')?.split(',') ?? [...REINDEX_CAUSES]) as ReindexCause[];
  if (causes.some((cause) => !REINDEX_CAUSES.includes(cause)))
    throw new Error(`--causes must be a subset of ${REINDEX_CAUSES.join(',')}`);
  connectPostgres(databaseUrl);
  try {
    const result = await reindexFailedPreviews(
      {
        ownerAccountId,
        applicationId,
        since: new Date(since),
        limit: Number(read('limit') ?? 1000),
        batchSize: Number(read('batch') ?? 200),
        causes,
      },
      args.includes('--apply'),
    );
    console.info(JSON.stringify(result));
  } finally {
    await closePostgres();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
