import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getDb } from './index.js';
import { runtimeState } from './schema/index.js';

export type RuntimeNotReadyReason =
  | 'database_unavailable'
  | 'postgres_cutover_unattested'
  | 'clarity_agent_unconfigured'
  | 'clarity_agent_attestation_mismatch';

export type RuntimeReadiness =
  | { ready: true }
  | { ready: false; reason: RuntimeNotReadyReason };

export interface RuntimeAttestation {
  status: string;
  aliaAgentIdSha256: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function evaluateRuntimeReadiness(
  row: RuntimeAttestation | undefined,
  agentId: string | undefined,
): RuntimeReadiness {
  const configuredAgentId = agentId?.trim();
  if (!configuredAgentId) return { ready: false, reason: 'clarity_agent_unconfigured' };
  if (row?.status !== 'cutover') {
    return { ready: false, reason: 'postgres_cutover_unattested' };
  }
  if (row.aliaAgentIdSha256 !== sha256(configuredAgentId)) {
    return { ready: false, reason: 'clarity_agent_attestation_mismatch' };
  }
  return { ready: true };
}

export async function getRuntimeReadiness(
  agentId: string | undefined = process.env.CLARITY_ALIA_AGENT_ID,
): Promise<RuntimeReadiness> {
  try {
    const [row] = await getDb().select({
      status: runtimeState.status,
      aliaAgentIdSha256: runtimeState.aliaAgentIdSha256,
    }).from(runtimeState).where(eq(runtimeState.id, 'postgres-cutover')).limit(1);
    return evaluateRuntimeReadiness(row, agentId);
  } catch {
    return { ready: false, reason: 'database_unavailable' };
  }
}
