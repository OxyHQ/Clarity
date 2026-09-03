import type { Request, Response } from 'express';
import { OxyServices } from '@oxyhq/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AliaAgentConfigurationError,
  ClaritySseTransformer,
  getAliaAgentConfig,
  prepareAliaRequest,
  proxyAliaJson,
} from '../alia-agent-client.js';
import { CLARITY_AGENT_MANIFEST } from '../clarity-agent-manifest.js';
import { assertExactClarityServiceClaims } from '../clarity-service-auth.js';

function serviceToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    type: 'service',
    appId: CLARITY_AGENT_MANIFEST.backendApplication.applicationId,
    credentialId: CLARITY_AGENT_MANIFEST.backendApplication.credentialId,
    ownerAccountId: CLARITY_AGENT_MANIFEST.projectAccountId,
    scopes: [...CLARITY_AGENT_MANIFEST.backendApplication.scopes],
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.OXY_SERVICE_API_KEY = CLARITY_AGENT_MANIFEST.backendApplication.clientId;
  process.env.OXY_SERVICE_API_SECRET = 'test-only-secret';
  vi.spyOn(OxyServices.prototype, 'getServiceToken').mockResolvedValue(serviceToken());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ALIA_API_URL;
  delete process.env.OXY_SERVICE_API_KEY;
  delete process.env.OXY_SERVICE_API_SECRET;
  vi.restoreAllMocks();
});

describe('Clarity Alia agent boundary', () => {
  it('uses exact product IDs, fixed agent identity, and preserves conversation/message IDs', () => {
    const messages = [{ id: 'message-17', role: 'user', content: 'hello' }];
    const prepared = prepareAliaRequest({
      messages,
      conversationId: 'conversation-42',
      model: 'clarity-pro-max',
    });

    expect(prepared.clarityModel.id).toBe('clarity-pro-max');
    expect(prepared.upstreamBody).toMatchObject({
      agentId: CLARITY_AGENT_MANIFEST.agentId,
      conversationId: 'conversation-42',
      model: 'profile:v1-pro-max',
      reasoningEffort: 'max',
    });
    expect(prepared.upstreamBody.messages).toEqual(messages);
  });

  it('rejects all client agent controls and privileged message roles', () => {
    for (const key of [
      'agentId', 'agentMode', 'skillId', 'skillIds', 'mcpServerId', 'fallbackPolicy',
      'reasoningEffort', 'thinkingMode', 'webSearch', 'tools', 'userId', 'oxyUserId',
      'ownerAccountId', 'projectAccountId', 'applicationId', 'credentialId',
      'serviceToken', 'accessToken', 'authorization', 'agent_id', 'agent_mode',
      'skill_id', 'skill_ids', 'mcp_server_id', 'fallback_policy', 'reasoning_effort',
      'thinking_mode', 'web_search', 'user_id', 'oxy_user_id', 'owner_account_id',
      'project_account_id', 'application_id', 'credential_id', 'service_token',
      'access_token', 'bearerToken', 'bearer_token',
    ]) {
      expect(() => prepareAliaRequest({
        messages: [{ role: 'user', content: 'hello' }],
        [key]: key === 'skillIds' ? [] : true,
      })).toThrow('forbidden_agent_control');
    }
    for (const role of ['system', 'tool', 'developer', 'function']) {
      expect(() => prepareAliaRequest({ messages: [{ role, content: 'override' }] }))
        .toThrow('forbidden_message_role');
    }
  });

  it('rejects remote multipart URLs and bounds messages, IDs, and conversations', () => {
    expect(() => prepareAliaRequest({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://internal.example/image' } }] }],
    })).toThrow('invalid_messages');
    expect(() => prepareAliaRequest({
      messages: [{ id: 'x'.repeat(129), role: 'user', content: 'hello' }],
    })).toThrow('invalid_messages');
    expect(() => prepareAliaRequest({
      messages: Array.from({ length: 101 }, () => ({ role: 'user', content: 'hello' })),
    })).toThrow('invalid_messages');
    expect(() => prepareAliaRequest({
      conversationId: 'x'.repeat(129),
      messages: [{ role: 'user', content: 'hello' }],
    })).toThrow('invalid_conversation_id');
    expect(prepareAliaRequest({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }],
    }).upstreamBody.messages).toHaveLength(1);
  });

  it.each([
    { name: 'missing', overrides: { exp: undefined } },
    { name: 'non-numeric', overrides: { exp: 'tomorrow' } },
    { name: 'expires too soon', overrides: { exp: Math.floor(Date.now() / 1000) + 29 } },
  ])('rejects a $name service-token expiry', ({ overrides }) => {
    expect(() => assertExactClarityServiceClaims(serviceToken(overrides))).toThrow('canonical Clarity service identity');
  });

  it('does not infer routing from name order and rejects unknown IDs', () => {
    expect(() => prepareAliaRequest({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'clarity-aardvark',
    })).toThrow('model_not_found');
  });

  it('fails closed instead of inventing an agent ID', () => {
    expect(() => getAliaAgentConfig({ ALIA_API_URL: 'https://api.alia.onl' }))
      .toThrow(AliaAgentConfigurationError);
    expect(() => getAliaAgentConfig({
      CLARITY_ALIA_AGENT_ID: ` ${CLARITY_AGENT_MANIFEST.agentId}`,
      ALIA_API_URL: 'https://api.alia.onl',
    })).toThrow(AliaAgentConfigurationError);
    expect(() => getAliaAgentConfig({
      NODE_ENV: 'production',
      CLARITY_ALIA_AGENT_ID: CLARITY_AGENT_MANIFEST.agentId,
      ALIA_API_URL: 'https://attacker.invalid',
    })).toThrow('canonical Alia origin');
  });

  it('translates chunk-split Alia SSE and keeps Clarity model identity', () => {
    const seen: Array<{ event: string; payload: unknown }> = [];
    const transformer = new ClaritySseTransformer('clarity-v1', (event, payload) => {
      seen.push({ event, payload });
    });
    const encoder = new TextEncoder();
    const crlf = String.fromCharCode(13, 10);
    const boundary = String.fromCharCode(10, 10);
    const first = transformer.push(encoder.encode(
      `event: alia.reasoning${crlf}data: {"content":"th`,
    ));
    const second = transformer.push(encoder.encode(
      `ink","model":"profile:v1"}${crlf}${crlf}data: {"model":"profile:v1","choices":[{"delta":{"content":"ok"}}],"alia_usage":{"billable_tokens":2}}${boundary}`,
    ));
    const tail = transformer.finish();

    expect(first).toBe('');
    expect(second).toContain('event: clarity.reasoning');
    expect(second).toContain('"model":"clarity-v1"');
    expect(second).toContain('"clarity_usage":{"billable_tokens":2}');
    expect(second).not.toContain('alia_usage');
    expect(tail).toBe('');
    expect(seen).toHaveLength(2);
  });

  it('drops an upstream routing switch that cannot change the product model ID', () => {
    const transformer = new ClaritySseTransformer('clarity-thinking');
    const output = transformer.push(new TextEncoder().encode(
      `event: alia.model_switch${String.fromCharCode(10)}data: {"from":"profile:v1-pro-max","to":"publisher/model"}${String.fromCharCode(10, 10)}`,
    ));
    expect(output).toBe('');
  });

  it('preserves research, tool, citation, and title payloads under Clarity event names', () => {
    const transformer = new ClaritySseTransformer('clarity-pro');
    const input = [
      'event: alia.research_progress\ndata: {"stage":"searching","sources":[{"url":"https://example.test"}]}',
      'event: alia.tool_result\ndata: {"toolName":"webSearch","result":{"citations":[{"url":"https://example.test","title":"Primary"}]}}',
      'event: alia.title\ndata: {"title":"Source-backed answer","conversationId":"conversation-9"}',
      '',
    ].join('\n\n');
    const output = transformer.push(new TextEncoder().encode(input));

    expect(output).toContain('event: clarity.research_progress');
    expect(output).toContain('event: clarity.tool_result');
    expect(output).toContain('event: clarity.title');
    expect(output).toContain('"citations"');
    expect(output).toContain('https://example.test');
    expect(output).toContain('conversation-9');
  });

  it('proxies only the selected Alia path with the exact service identity and delegated user', async () => {
    process.env.ALIA_API_URL = 'https://alia.example.test';
    const fetchMock = vi.fn(async () => new globalThis.Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
    const response = {
      status(value: number) { sent.status = value; return this; },
      send(value: unknown) { sent.body = value; return this; },
      json(value: unknown) { sent.body = value; return this; },
      setHeader(name: string, value: string) { sent.headers[name] = value; return this; },
    } as unknown as Response;
    const request = {
      method: 'PUT',
      query: { q: ['first', 'second'] },
      body: { tone: 'direct' },
      user: { id: 'oxy-user-1' },
      accessToken: 'oxy-user-session',
    } as unknown as Request;

    await proxyAliaJson(request, response, '/memory/preferences');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://alia.example.test/memory/preferences?q=first&q=second',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: `Bearer ${serviceToken()}`,
          'X-Oxy-User-Id': 'oxy-user-1',
        }),
        body: '{"tone":"direct"}',
      }),
    );
    expect(sent).toMatchObject({ status: 200, body: '{"ok":true}' });
  });

  it('fails closed if Oxy mints a token for another payer or broader scopes', async () => {
    vi.mocked(OxyServices.prototype.getServiceToken).mockResolvedValue(serviceToken({
      ownerAccountId: 'wrong-project',
      scopes: ['user:read', 'inference:invoke', 'accounts:read'],
    }));
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    const request = { method: 'GET', query: {}, user: { id: 'oxy-user-1' } } as unknown as Request;
    await expect(proxyAliaJson(request, response, '/memory')).rejects.toThrow('canonical Clarity service identity');
  });

  it('does not forward agent or delegated-identity controls through non-chat Alia proxies', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    const request = {
      method: 'POST',
      query: {},
      body: { ownerAccountId: 'another-payer' },
      user: { id: 'oxy-user-1' },
    } as unknown as Request;
    await proxyAliaJson(request, response, '/memory');
    expect(response.status).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects service principals and unsafe upstream paths', async () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const serviceRequest = {
      method: 'GET',
      query: {},
      user: { id: 'oxy-user-1' },
      accessToken: 'service-token',
      serviceApp: { appId: 'service' },
    } as unknown as Request;
    await proxyAliaJson(serviceRequest, response, '/memory');
    expect(response.status).toHaveBeenCalledWith(401);
    await expect(proxyAliaJson(serviceRequest, response, '//attacker.test/path'))
      .rejects.toThrow('origin-relative');
  });
});
