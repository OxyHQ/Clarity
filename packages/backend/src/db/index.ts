import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import type postgres from 'postgres';

import * as schema from './schema/index.js';

export type ClarityDatabase = OxyDatabase<typeof schema>;
export type ClarityTransaction = Parameters<Parameters<ClarityDatabase['transaction']>[0]>[0];
export type ClarityExecutor = ClarityDatabase | ClarityTransaction;

let handle: { db: ClarityDatabase; client: postgres.Sql } | null = null;

export function connectPostgres(databaseUrl: string | undefined): ClarityDatabase | null {
  if (handle) return handle.db;
  if (!databaseUrl) return null;
  handle = createDatabase({ databaseUrl, schema });
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
