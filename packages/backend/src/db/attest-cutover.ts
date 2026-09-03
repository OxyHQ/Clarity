#!/usr/bin/env bun
import { and, eq } from 'drizzle-orm';

import { readCutoverManifest, sha256 } from './cutover-manifest.js';
import { closePostgres, connectPostgres, getDb } from './index.js';
import { runtimeState } from './schema/index.js';
import { CLARITY_AGENT_MANIFEST } from '../lib/clarity-agent-manifest.js';

function argument(argv: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export async function attestCutover(input: {
  databaseUrl: string;
  manifestPath: string;
  expectedSnapshotHash: string;
  confirmation: string;
  agentId: string;
}): Promise<void> {
  if (input.agentId !== CLARITY_AGENT_MANIFEST.agentId) {
    throw new Error('CLARITY_ALIA_AGENT_ID must match the canonical Clarity agent');
  }
  if (input.confirmation !== 'CUTOVER_CLARITY_TO_POSTGRES') {
    throw new Error('exact --confirm=CUTOVER_CLARITY_TO_POSTGRES is required');
  }
  const manifest = readCutoverManifest(input.manifestPath);
  if (manifest.snapshot.inventorySha256 !== input.expectedSnapshotHash) {
    throw new Error('the expected snapshot hash does not match the manifest');
  }
  if (sha256(input.agentId) !== manifest.runtimeEvidence.aliaAgentIdSha256) {
    throw new Error('the provisioned Clarity agent does not match runtime evidence');
  }

  connectPostgres(input.databaseUrl);
  try {
    const result = await getDb().update(runtimeState).set({
      status: 'cutover',
      updatedAt: new Date(),
    }).where(and(
      eq(runtimeState.id, 'postgres-cutover'),
      eq(runtimeState.status, 'reconciled'),
      eq(runtimeState.sourceSnapshotHash, input.expectedSnapshotHash),
      eq(runtimeState.aliaAgentIdSha256, sha256(input.agentId)),
    )).returning({ id: runtimeState.id });
    if (result.length !== 1) {
      throw new Error('no matching reconciled snapshot is ready for cutover');
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
  attestCutover({
    databaseUrl,
    agentId,
    manifestPath: argument(argv, 'manifest'),
    expectedSnapshotHash: argument(argv, 'snapshot-hash'),
    confirmation: argument(argv, 'confirm'),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
