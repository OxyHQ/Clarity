import { eq } from 'drizzle-orm';

import { getDb } from './index.js';
import { runtimeState } from './schema/index.js';
import { hasExactClarityServiceConfiguration } from '../lib/clarity-service-auth.js';

export type RuntimeNotReadyReason =
  | 'database_unavailable'
  | 'postgres_cutover_unattested'
  | 'clarity_service_identity_unconfigured';

export type RuntimeReadiness = { ready: true } | { ready: false; reason: RuntimeNotReadyReason };

export interface RuntimeAttestation {
  status: string;
}

/**
 * Either attested status opens readiness. `cutover` means real prior data was
 * migrated and reconciled (`attest-cutover.ts`); `fresh_install` means the
 * deployment never had prior data to migrate at all (`attest-fresh-install.ts`).
 */
const ATTESTED_STATUSES = new Set(['cutover', 'fresh_install']);

export function evaluateRuntimeReadiness(row: RuntimeAttestation | undefined): RuntimeReadiness {
  if (row === undefined || !ATTESTED_STATUSES.has(row.status)) {
    return { ready: false, reason: 'postgres_cutover_unattested' };
  }
  return { ready: true };
}

export async function getRuntimeReadiness(): Promise<RuntimeReadiness> {
  if (!hasExactClarityServiceConfiguration()) {
    return { ready: false, reason: 'clarity_service_identity_unconfigured' };
  }
  try {
    const [row] = await getDb()
      .select({ status: runtimeState.status })
      .from(runtimeState)
      .where(eq(runtimeState.id, 'postgres-cutover'))
      .limit(1);
    return evaluateRuntimeReadiness(row);
  } catch {
    return { ready: false, reason: 'database_unavailable' };
  }
}
