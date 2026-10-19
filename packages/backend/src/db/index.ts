import { createDatabase, type OxyDatabase } from '@oxy.so/db';
import type postgres from 'postgres';

import { createLogger } from '../lib/logger.js';
import * as schema from './schema/index.js';

const log = createLogger('postgres');

export type ClarityDatabase = OxyDatabase<typeof schema>;
export type ClarityTransaction = Parameters<Parameters<ClarityDatabase['transaction']>[0]>[0];
export type ClarityExecutor = ClarityDatabase | ClarityTransaction;

let handle: { db: ClarityDatabase; client: postgres.Sql } | null = null;

export function connectPostgres(databaseUrl: string | undefined): ClarityDatabase | null {
  if (handle) return handle.db;
  if (!databaseUrl) return null;
  handle = createDatabase({
    databaseUrl,
    schema,
    client: {
      // postgres.js prints every NOTICE with console.log by default (e.g.
      // to_tsvector's "word is too long to be indexed"), as raw stdout objects.
      onnotice: (notice) => log.debug({ code: notice.code }, notice.message),
      // Release connections idle for 30 s, and fail a connect in 10 s instead
      // of 30: the instance is shared by every Oxy product.
      idle_timeout: 30,
      connect_timeout: 10,
    },
  });
  return handle.db;
}

export function getDb(): ClarityDatabase {
  if (!handle) {
    throw new Error('PostgreSQL is not connected — call connectPostgres() during startup');
  }
  return handle.db;
}

export async function checkPostgres(): Promise<boolean> {
  if (!handle) return false;
  try {
    await handle.client`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closePostgres(): Promise<void> {
  if (!handle) return;
  await handle.client.end();
  handle = null;
}

export { schema };
