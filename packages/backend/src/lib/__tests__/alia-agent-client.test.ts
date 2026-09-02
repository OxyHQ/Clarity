import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AliaAgentConfigurationError,
  ClaritySseTransformer,
  getAliaAgentConfig,
  prepareAliaRequest,
  proxyAliaJson,
} from '../alia-agent-client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ALIA_API_URL;
});

describe('Clarity Alia agent boundary', () => {
  it('uses exact product IDs, fixed agent identity, and preserves conversation/message IDs', () => {
    const messages = [{ id: 'message-17', role: 'user', content: 'hello' }];
    const prepared = prepareAliaRequest({
      messages,
      conversationId: 'conversation-42',
      model: 'clarity-pro-max',
      agentId: 'client-controlled-id',
    }, 'provisioned-clarity-agent');

    expect(prepared.clarityModel.id).toBe('clarity-pro-max');
    expect(prepared.upstreamBody).toMatchObject({
      agentId: 'provisioned-clarity-agent',
      conversationId: 'conversation-42',
      model: 'profile:v1-pro-max',
      reasoningEffort: 'max',
    });
    expect(prepared.upstreamBody.messages).toBe(messages);
  });

  it('does not infer routing from name order and rejects unknown IDs', () => {
    expect(() => prepareAliaRequest({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'clarity-aardvark',
    }, 'configured')).toThrow('model_not_found');
  });

  it('fails closed instead of inventing an agent ID', () => {
    expect(() => getAliaAgentConfig({ ALIA_API_URL: 'https://api.alia.onl' }))
      .toThrow(AliaAgentConfigurationError);
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

  it('proxies only the selected Alia path with the authenticated user session', async () => {
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
        headers: expect.objectContaining({ Authorization: 'Bearer oxy-user-session' }),
        body: '{"tone":"direct"}',
      }),
    );
    expect(sent).toMatchObject({ status: 200, body: '{"ok":true}' });
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
