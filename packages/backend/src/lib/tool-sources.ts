/**
 * What of an answer's tool activity Clarity keeps with the conversation: which
 * tools ran, what they searched for or read, and the links they came back
 * with — enough to show an answer's sources after a reload, and no more.
 *
 * A tool's full output (a scraped page, a research report) is Alia's; storing
 * it here would copy third-party page text into Clarity's product tables. So
 * results are reduced to the link-shaped fields the chat renders.
 */

import { excerpt } from '../search/query-primitives.js';
import { hostOf } from '../search/site-icons.js';
import { asRecord } from './json-record.js';

export interface StoredToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'result';
  args?: { query?: string; url?: string };
  result: StoredToolResult;
}

interface StoredLink { url: string; title?: string; snippet?: string }
interface StoredToolResult {
  action?: string;
  url?: string;
  title?: string;
  content?: string;
  results?: StoredLink[];
  sources?: Array<{ id?: number; url: string; title?: string }>;
}

const MAX_LINKS = 20;
const MAX_TEXT = 300;
const MAX_INVOCATIONS = 50;

function httpUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048 && hostOf(value) ? value : undefined;
}

// Absent fields are left `undefined`; JSON storage drops them.
function compactLink(value: unknown): StoredLink | null {
  const link = asRecord(value);
  const url = httpUrl(link?.url);
  if (!link || !url) return null;
  return { url, title: excerpt(asText(link.title), MAX_TEXT), snippet: excerpt(asText(link.snippet), MAX_TEXT) };
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The link-shaped part of a tool's output; `null` when it carries no link. */
export function compactToolResult(output: unknown): StoredToolResult | null {
  const result = asRecord(output);
  if (!result) return null;
  const url = httpUrl(result.url);
  const results = Array.isArray(result.results)
    ? result.results.flatMap((value) => compactLink(value) ?? []).slice(0, MAX_LINKS)
    : [];
  const sources = Array.isArray(result.sources)
    ? result.sources.flatMap((value) => {
      const link = compactLink(value);
      const id = asRecord(value)?.id;
      return link ? [{ id: typeof id === 'number' ? id : undefined, url: link.url, title: link.title }] : [];
    }).slice(0, MAX_LINKS)
    : [];
  if (!url && results.length === 0 && sources.length === 0) return null;
  return {
    action: typeof result.action === 'string' ? result.action.slice(0, 32) : undefined,
    ...(url ? { url, title: excerpt(asText(result.title), MAX_TEXT), content: excerpt(asText(result.content), 200) } : {}),
    results: results.length ? results : undefined,
    sources: sources.length ? sources : undefined,
  };
}

/**
 * Watches one streamed answer and keeps the tool calls whose results carried
 * links. Reads both shapes Alia streams: the named `tool_result` event and the
 * `delta.tool_result` extension, with arguments from standard `delta.tool_calls`.
 */
export function createToolSourceCollector() {
  const args = new Map<string, { toolName: string; args?: StoredToolInvocation['args'] }>();
  const invocations = new Map<string, StoredToolInvocation>();

  function onResult(value: unknown) {
    const event = asRecord(value);
    const toolCallId = typeof event?.tool_call_id === 'string' ? event.tool_call_id : undefined;
    if (!event || !toolCallId || invocations.size >= MAX_INVOCATIONS) return;
    const result = compactToolResult(event.output);
    if (!result) return;
    const call = args.get(toolCallId);
    const toolName = typeof event.name === 'string' && event.name ? event.name : call?.toolName ?? 'unknown';
    invocations.set(toolCallId, { toolCallId, toolName: toolName.slice(0, 64), state: 'result', args: call?.args, result });
  }

  function onToolCall(value: unknown) {
    const call = asRecord(value);
    const fn = asRecord(call?.function);
    if (!call || typeof call.id !== 'string' || typeof fn?.name !== 'string' || args.size >= MAX_INVOCATIONS) return;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = typeof fn.arguments === 'string' ? asRecord(JSON.parse(fn.arguments)) : null;
    } catch {
      parsed = null;
    }
    const query = excerpt(asText(parsed?.query), MAX_TEXT);
    const url = httpUrl(parsed?.url);
    args.set(call.id, { toolName: fn.name, args: query || url ? { query, url } : undefined });
  }

  return {
    observe(eventName: string, payload: unknown) {
      if (eventName === 'alia.tool_result' || eventName === 'clarity.tool_result') { onResult(payload); return; }
      const choices = asRecord(payload)?.choices;
      const delta = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.delta) : null;
      if (!delta) return;
      if (Array.isArray(delta.tool_calls)) delta.tool_calls.forEach(onToolCall);
      if (delta.tool_result) onResult(delta.tool_result);
    },
    invocations(): StoredToolInvocation[] {
      return [...invocations.values()];
    },
  };
}
