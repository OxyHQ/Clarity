import type { Request, Response } from 'express';

import {
  getClarityModel,
  getDefaultClarityModel,
  type ClarityModel,
} from './clarity-models.js';
import { saveConversation } from './conversation-saver.js';
import { log } from './logger.js';
import { updateConversationTitle } from '../db/chat-repository.js';

const DEFAULT_ALIA_API_URL = 'https://api.alia.onl';
const ALIA_CHAT_PATH = '/alia/chat';
// Deep research is a long-lived SSE operation. Alia emits progress frames, so
// keep a bounded total deadline without cutting off the product mode at the old
// short request timeout.
const UPSTREAM_TIMEOUT_MS = 15 * 60_000;

export class AliaAgentConfigurationError extends Error {}

export interface AliaAgentConfig {
  baseUrl: string;
  agentId: string;
}

export function getAliaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawBaseUrl = env.ALIA_API_URL?.trim() || DEFAULT_ALIA_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new AliaAgentConfigurationError('ALIA_API_URL is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AliaAgentConfigurationError('ALIA_API_URL must use HTTP or HTTPS.');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function getAliaAgentConfig(env: NodeJS.ProcessEnv = process.env): AliaAgentConfig {
  const agentId = env.CLARITY_ALIA_AGENT_ID?.trim();
  if (!agentId) {
    throw new AliaAgentConfigurationError(
      'The Clarity Alia agent has not been provisioned.',
    );
  }

  return {
    baseUrl: getAliaBaseUrl(env),
    agentId,
  };
}

function getUserBearer(req: Request): string | null {
  if (!req.user?.id || req.serviceApp || !req.accessToken) return null;
  return req.accessToken;
}

function validateMessages(body: Record<string, unknown>): unknown[] | null {
  const messages = body.messages ?? body.input;
  return Array.isArray(messages) && messages.length > 0 ? messages : null;
}

export interface PreparedAliaRequest {
  clarityModel: ClarityModel;
  upstreamBody: Record<string, unknown>;
}

export async function completeAsClarityAgent(input: {
  accessToken: string;
  messages: unknown[];
  clarityModelId?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const config = getAliaAgentConfig();
  const prepared = prepareAliaRequest({
    messages: input.messages,
    stream: false,
    model: input.clarityModelId ?? getDefaultClarityModel(),
  }, config.agentId);
  const response = await fetch(`${config.baseUrl}${ALIA_CHAT_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(prepared.upstreamBody),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Alia request failed with status ${response.status}`);
  }
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('Alia returned no completion content');
  }
  return content;
}

/**
 * Converts Clarity product controls to the explicit Alia product contract.
 * No client-supplied agent id crosses the boundary: every turn is for the one
 * provisioned Clarity agent. IDs inside messages and conversationId are kept.
 */
export function prepareAliaRequest(
  body: Record<string, unknown>,
  agentId: string,
): PreparedAliaRequest {
  const messages = validateMessages(body);
  if (!messages) throw new TypeError('invalid_messages');

  const requestedModelId = typeof body.model === 'string'
    ? body.model
    : getDefaultClarityModel();
  const clarityModel = getClarityModel(requestedModelId);
  if (!clarityModel) throw new TypeError('model_not_found');

  const upstreamBody: Record<string, unknown> = {
    messages,
    stream: body.stream === true,
    model: clarityModel.aliaProfileId,
    agentId,
  };

  const passThrough = [
    'conversationId',
    'deepResearch',
    'agentMode',
    'webSearch',
    'skillIds',
    'mcpServerId',
    'stream_options',
    'fallbackPolicy',
  ] as const;
  for (const key of passThrough) {
    if (body[key] !== undefined) upstreamBody[key] = body[key];
  }

  if (body.reasoningEffort !== undefined) {
    upstreamBody.reasoningEffort = body.reasoningEffort;
  } else if (body.thinkingMode === true) {
    upstreamBody.reasoningEffort = 'medium';
  } else if (clarityModel.reasoningEffort) {
    upstreamBody.reasoningEffort = clarityModel.reasoningEffort;
  }

  return { clarityModel, upstreamBody };
}

function rewriteModelEnvelope(value: unknown, clarityModelId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  if ('model' in payload) payload.model = clarityModelId;
  if ('alia_usage' in payload) {
    payload.clarity_usage = payload.alia_usage;
    delete payload.alia_usage;
  }
  return payload;
}

type SseObserver = (eventName: string, payload: unknown) => void;

function rewriteSseFrame(
  frame: string,
  clarityModelId: string,
  observer?: SseObserver,
): string {
  const lines = frame.split(/\r?\n/);
  let eventName = '';
  for (const line of lines) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
  }

  // An internal routing switch must not change Clarity's selected product ID.
  if (eventName === 'alia.model_switch') return '';

  return lines.map((line) => {
    if (line.startsWith('event: alia.')) {
      return `event: clarity.${line.slice('event: alia.'.length)}`;
    }
    if (!line.startsWith('data:')) return line;

    const rawData = line.slice(5).trimStart();
    if (rawData === '[DONE]' || rawData === '') return line;
    try {
      const parsed = JSON.parse(rawData);
      observer?.(eventName, parsed);
      return `data: ${JSON.stringify(rewriteModelEnvelope(parsed, clarityModelId))}`;
    } catch {
      return line;
    }
  }).join('\n');
}

export class ClaritySseTransformer {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(
    private readonly clarityModelId: string,
    private readonly observer?: SseObserver,
  ) {}

  push(chunk: Uint8Array): string {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(flush: boolean): string {
    const normalized = this.buffer.replace(/\r\n/g, '\n');
    const frames = normalized.split('\n\n');
    if (flush) {
      this.buffer = '';
    } else {
      this.buffer = frames.pop() ?? '';
    }

    return frames
      .map((frame) => rewriteSseFrame(frame, this.clarityModelId, this.observer))
      .filter(Boolean)
      .map((frame) => `${frame}\n\n`)
      .join('');
  }
}

async function persistClarityTurn(input: {
  userId: string;
  conversationId?: unknown;
  messages: unknown[];
  assistantResponse: string;
  title?: string;
}): Promise<void> {
  if (typeof input.conversationId !== 'string' || input.conversationId === '') return;
  if (input.assistantResponse !== '') {
    await saveConversation({
      userId: input.userId,
      conversationId: input.conversationId,
      messages: input.messages,
      assistantResponse: input.assistantResponse,
    });
  }
  if (input.title?.trim()) {
    await updateConversationTitle(
      input.userId,
      input.conversationId,
      input.title.trim().slice(0, 100),
      true,
    );
  }
}

function copySafeUpstreamHeaders(upstream: globalThis.Response, res: Response): void {
  for (const name of ['content-type', 'cache-control', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('X-Accel-Buffering', 'no');
}

function sendProxyError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      param: null,
      code,
    },
  });
}

/**
 * Proxy an explicitly selected Alia product API path. The caller supplies the
 * fixed path; no request URL is accepted here, so ALIA_API_URL cannot become a
 * general-purpose proxy. Inference credits/telemetry stay in Alia PostgreSQL.
 */
export async function proxyAliaJson(
  req: Request,
  res: Response,
  path: string,
  options: { requireUser?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('Alia proxy path must be absolute and origin-relative');
  }
  const bearer = getUserBearer(req);
  if (options.requireUser !== false && !bearer) {
    res.status(401).json({ error: 'An authenticated Oxy user session is required.' });
    return;
  }

  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(req.query)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value === 'string') query.append(key, value);
    }
  }
  const url = `${getAliaBaseUrl()}${path}${query.size > 0 ? `?${query}` : ''}`;
  const upstream = await fetch(url, {
    method: req.method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      Accept: 'application/json',
      ...(req.method === 'GET' || req.method === 'HEAD'
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(req.method === 'GET' || req.method === 'HEAD'
      ? {}
      : { body: JSON.stringify(req.body ?? {}) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const body = await upstream.text();
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) res.setHeader('Retry-After', retryAfter);
  res.status(upstream.status).send(body);
}

export async function fetchAliaJson<T>(
  accessToken: string,
  path: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('Alia path must be absolute and origin-relative');
  }
  const response = await fetch(`${getAliaBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`Alia request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}

export async function proxyClarityChat(req: Request, res: Response): Promise<void> {
  const bearer = getUserBearer(req);
  if (!bearer) {
    sendProxyError(
      res,
      401,
      'oxy_user_session_required',
      'Clarity chat currently requires an authenticated Oxy user session.',
    );
    return;
  }

  let config: AliaAgentConfig;
  let prepared: PreparedAliaRequest;
  try {
    config = getAliaAgentConfig();
    prepared = prepareAliaRequest(req.body as Record<string, unknown>, config.agentId);
  } catch (error) {
    if (error instanceof AliaAgentConfigurationError) {
      sendProxyError(res, 503, 'clarity_agent_not_configured', error.message);
      return;
    }
    if (error instanceof TypeError && error.message === 'invalid_messages') {
      sendProxyError(res, 400, 'invalid_messages', 'A non-empty messages array is required.');
      return;
    }
    if (error instanceof TypeError && error.message === 'model_not_found') {
      sendProxyError(res, 404, 'model_not_found', 'The requested Clarity model does not exist.');
      return;
    }
    throw error;
  }

  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  req.once('aborted', abortUpstream);
  res.once('close', abortUpstream);
  const timeout = setTimeout(abortUpstream, UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${config.baseUrl}${ALIA_CHAT_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: prepared.upstreamBody.stream === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(prepared.upstreamBody),
      signal: abortController.signal,
    });

    copySafeUpstreamHeaders(upstream, res);

    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(upstream.status).send(body || JSON.stringify({
        error: { message: 'Alia rejected the Clarity turn.', code: 'alia_request_failed' },
      }));
      return;
    }

    if (prepared.upstreamBody.stream !== true) {
      const upstreamBody = await upstream.json();
      const envelope = upstreamBody as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const assistantResponse = envelope.choices?.[0]?.message?.content;
      if (typeof assistantResponse === 'string') {
        await persistClarityTurn({
          userId: req.user!.id,
          conversationId: prepared.upstreamBody.conversationId,
          messages: prepared.upstreamBody.messages as unknown[],
          assistantResponse,
        }).catch((error) => log.v1.error({ err: error }, 'Could not persist Clarity turn'));
      }
      res.status(upstream.status).json(
        rewriteModelEnvelope(upstreamBody, prepared.clarityModel.id),
      );
      return;
    }

    if (!upstream.body) {
      sendProxyError(res, 502, 'alia_stream_missing', 'Alia returned no stream.');
      return;
    }

    res.status(upstream.status);
    let assistantResponse = '';
    let title: string | undefined;
    const transformer = new ClaritySseTransformer(prepared.clarityModel.id, (eventName, payload) => {
      if (!payload || typeof payload !== 'object') return;
      const object = payload as Record<string, unknown>;
      if (eventName === 'alia.title' && typeof object.title === 'string') {
        title = object.title;
      }
      const choices = object.choices;
      if (!Array.isArray(choices)) return;
      const delta = choices[0] && typeof choices[0] === 'object'
        ? (choices[0] as Record<string, unknown>).delta
        : null;
      if (delta && typeof delta === 'object') {
        const content = (delta as Record<string, unknown>).content;
        if (typeof content === 'string') assistantResponse += content;
      }
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const output = transformer.push(value);
      if (output && !res.writableEnded) res.write(output);
    }
    const tail = transformer.finish();
    if (tail && !res.writableEnded) res.write(tail);
    await persistClarityTurn({
      userId: req.user!.id,
      conversationId: prepared.upstreamBody.conversationId,
      messages: prepared.upstreamBody.messages as unknown[],
      assistantResponse,
      title,
    }).catch((error) => log.v1.error({ err: error }, 'Could not persist Clarity turn'));
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (abortController.signal.aborted) {
      if (!res.headersSent) {
        sendProxyError(res, 504, 'alia_timeout', 'The Clarity agent did not respond in time.');
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    log.v1.error({ err: error }, 'Clarity agent proxy failed');
    if (!res.headersSent) {
      sendProxyError(res, 502, 'alia_unavailable', 'The Clarity agent is unavailable.');
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abortUpstream);
    res.off('close', abortUpstream);
  }
}
