import { createHash } from 'node:crypto';

export const CLARITY_AGENT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  projectAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
  botAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
  agentId: '01a0646a-078f-7642-95ef-439952f4f3f9',
  bindingApplicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
  publicApplication: Object.freeze({
    applicationId: '01a0646a-2382-74a3-a795-788924d55722',
    credentialId: '01a0646e-2508-7048-8c08-b1f7b3af634f',
    clientId: 'oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a',
    scopes: Object.freeze(['user:read'] as const),
  }),
  backendApplication: Object.freeze({
    applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
    credentialId: '01a0648b-8d74-7240-adba-80707fdfdf9c',
    clientId: 'oxy_dk_8c84c74a2656b8f5147d4d0b65fcd0e88c192ce64f465f78',
    scopes: Object.freeze(['user:read', 'inference:invoke'] as const),
  }),
  capabilityGrants: Object.freeze(['web', 'artifacts', 'memory'] as const),
  systemPrompt: Object.freeze({
    file: 'prompts/base.md',
    sha256: 'd9d6aba931af9ede11b3c57b775b36bc9a9f42169a808b3cd8ff7d0693b698b0',
  }),
});

export function buildClarityAgentBootstrap(systemPrompt: string) {
  const actualHash = createHash('sha256').update(systemPrompt).digest('hex');
  if (actualHash !== CLARITY_AGENT_MANIFEST.systemPrompt.sha256) {
    throw new Error('Clarity system prompt does not match the pinned manifest hash.');
  }
  return { ...CLARITY_AGENT_MANIFEST, systemPrompt: { ...CLARITY_AGENT_MANIFEST.systemPrompt, content: systemPrompt } };
}
