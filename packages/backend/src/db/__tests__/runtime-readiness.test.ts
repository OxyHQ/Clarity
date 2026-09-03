import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { evaluateRuntimeReadiness } from '../runtime-readiness.js';
import { CLARITY_AGENT_MANIFEST } from '../../lib/clarity-agent-manifest.js';

const agentId = CLARITY_AGENT_MANIFEST.agentId;
const agentHash = createHash('sha256').update(agentId).digest('hex');

describe('runtime cutover readiness', () => {
  it('opens only for the exact agent identity recorded by the reconciled snapshot', () => {
    expect(evaluateRuntimeReadiness({
      status: 'cutover',
      aliaAgentIdSha256: agentHash,
    }, agentId)).toEqual({ ready: true });
  });

  it.each([
    [undefined, agentId, 'postgres_cutover_unattested'],
    [{ status: 'reconciled', aliaAgentIdSha256: agentHash }, agentId, 'postgres_cutover_unattested'],
    [{ status: 'cutover', aliaAgentIdSha256: agentHash }, undefined, 'clarity_agent_unconfigured'],
    [{ status: 'cutover', aliaAgentIdSha256: agentHash }, 'different-agent', 'clarity_agent_unconfigured'],
    [{ status: 'cutover', aliaAgentIdSha256: null }, agentId, 'clarity_agent_attestation_mismatch'],
  ] as const)('fails closed for an incomplete or changed attestation', (row, configured, reason) => {
    expect(evaluateRuntimeReadiness(row, configured)).toEqual({ ready: false, reason });
  });
});
