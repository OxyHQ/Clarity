import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getDb } from './index.js';
import { runtimeState } from './schema/index.js';
import { CLARITY_AGENT_MANIFEST } from '../lib/clarity-agent-manifest.js';
import { hasExactClarityServiceConfiguration } from '../lib/clarity-service-auth.js';

export type RuntimeNotReadyReason =
  | 'database_unavailable'
  | 'postgres_cutover_unattested'
  | 'clarity_agent_unconfigured'
  | 'clarity_service_identity_unconfigured'
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
  const configuredAgentId = agentId;
  if (configuredAgentId !== CLARITY_AGENT_MANIFEST.agentId) {
    return { ready: false, reason: 'clarity_agent_unconfigured' };
  }
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
  if (!hasExactClarityServiceConfiguration()) {
    return { ready: false, reason: 'clarity_service_identity_unconfigured' };
  }
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
