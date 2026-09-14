#!/usr/bin/env bun
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from './index.js';
import { runtimeState } from './schema/index.js';
import { CLARITY_AGENT_MANIFEST } from '../lib/clarity-agent-manifest.js';
import { sha256 } from './cutover-manifest.js';

function argument(argv: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/**
 * Attests that this deployment never had prior data to migrate at all, so
 * readiness may open without a cutover manifest. This is the ONLY other way
 * `postgres-cutover` may reach an attested status (see `attest-cutover.ts` for
 * the real-migration path) — it deliberately writes no snapshot, because there
 * is nothing to hash.
 *
 * Refuses outright if `postgres-cutover` already records ANY status: a
 * service that has ever been through cutover, or reconciled toward one, is by
 * definition not the "never had data" case this path exists for.
 */
export async function attestFreshInstall(input: {
  databaseUrl: string;
  confirmation: string;
  agentId: string;
}): Promise<void> {
  if (input.agentId !== CLARITY_AGENT_MANIFEST.agentId) {
    throw new Error('CLARITY_ALIA_AGENT_ID must match the canonical Clarity agent');
  }
  if (input.confirmation !== 'FRESH_INSTALL_NO_DATA_TO_MIGRATE') {
    throw new Error('exact --confirm=FRESH_INSTALL_NO_DATA_TO_MIGRATE is required');
  }

  connectPostgres(input.databaseUrl);
  try {
    const [existing] = await getDb().select({ status: runtimeState.status })
      .from(runtimeState).where(eq(runtimeState.id, 'postgres-cutover')).limit(1);
    if (existing !== undefined) {
      throw new Error(
        `postgres-cutover already records status "${existing.status}" — fresh-install attestation is only for a `
        + 'deployment with no prior recorded state at all. Use attest-cutover.ts for a real migration.',
      );
    }

    await getDb().insert(runtimeState).values({
      id: 'postgres-cutover',
      status: 'fresh_install',
      aliaAgentIdSha256: sha256(input.agentId),
    });

    const [after] = await getDb().select({ status: runtimeState.status })
      .from(runtimeState).where(eq(runtimeState.id, 'postgres-cutover')).limit(1);
    if (after?.status !== 'fresh_install') {
      throw new Error('fresh-install attestation did not take effect (a concurrent write may have raced it)');
    }
  } finally {
    await closePostgres();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  const agentId = process.env.CLARITY_ALIA_AGENT_ID;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!agentId) throw new Error('CLARITY_ALIA_AGENT_ID is required');
  attestFreshInstall({
    databaseUrl,
    agentId,
    confirmation: argument(argv, 'confirm'),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
