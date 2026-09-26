/**
 * What of an answer's tool activity Clarity keeps with the conversation: which
 * tools ran, what they searched for or read, and the links they came back
 * with — enough to show an answer's sources after a reload, and no more.
 *
 * A tool's full output (a scraped page, a research report) is Alia's; storing
 * it here would copy third-party page text into Clarity's product tables. So
 * results are reduced to the link-shaped fields the chat renders.
 */

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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function compactLink(value: unknown): StoredLink | null {
  const link = record(value);
  const url = httpUrl(link?.url);
  if (!link || !url) return null;
  return { url, ...(text(link.title) ? { title: text(link.title) } : {}), ...(text(link.snippet) ? { snippet: text(link.snippet) } : {}) };
}

/** The link-shaped part of a tool's output; `null` when it carries no link. */
export function compactToolResult(output: unknown): StoredToolResult | null {
  const result = record(output);
  if (!result) return null;
  const compact: StoredToolResult = {};
  if (typeof result.action === 'string') compact.action = result.action.slice(0, 32);
  const url = httpUrl(result.url);
  if (url) {
    compact.url = url;
    if (text(result.title)) compact.title = text(result.title);
    if (typeof result.content === 'string') compact.content = result.content.slice(0, 200);
  }
  if (Array.isArray(result.results)) {
    const links = result.results.flatMap((value) => compactLink(value) ?? []).slice(0, MAX_LINKS);
    if (links.length) compact.results = links;
  }
  if (Array.isArray(result.sources)) {
    const sources = result.sources.flatMap((value) => {
      const link = compactLink(value);
      const id = record(value)?.id;
      return link ? [{ ...(typeof id === 'number' ? { id } : {}), url: link.url, ...(link.title ? { title: link.title } : {}) }] : [];
    }).slice(0, MAX_LINKS);
    if (sources.length) compact.sources = sources;
  }
  return compact.url || compact.results || compact.sources ? compact : null;
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
    const event = record(value);
    const toolCallId = typeof event?.tool_call_id === 'string' ? event.tool_call_id : undefined;
    if (!event || !toolCallId || invocations.size >= MAX_INVOCATIONS) return;
    const result = compactToolResult(event.output);
    if (!result) return;
    const call = args.get(toolCallId);
    const toolName = typeof event.name === 'string' && event.name ? event.name : call?.toolName ?? 'unknown';
    invocations.set(toolCallId, {
      toolCallId, toolName: toolName.slice(0, 64), state: 'result',
      ...(call?.args ? { args: call.args } : {}),
      result,
    });
  }

  function onToolCall(value: unknown) {
    const call = record(value);
    const fn = record(call?.function);
    if (!call || typeof call.id !== 'string' || typeof fn?.name !== 'string') return;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = typeof fn.arguments === 'string' ? record(JSON.parse(fn.arguments)) : null;
    } catch {
      parsed = null;
    }
    const query = text(parsed?.query);
    const url = httpUrl(parsed?.url);
    args.set(call.id, { toolName: fn.name, ...(query || url ? { args: { ...(query ? { query } : {}), ...(url ? { url } : {}) } } : {}) });
  }

  return {
    observe(eventName: string, payload: unknown) {
      if (eventName === 'alia.tool_result' || eventName === 'clarity.tool_result') { onResult(payload); return; }
      const choices = record(payload)?.choices;
      const delta = Array.isArray(choices) ? record(record(choices[0])?.delta) : null;
      if (!delta) return;
      if (Array.isArray(delta.tool_calls)) delta.tool_calls.forEach(onToolCall);
      if (delta.tool_result) onResult(delta.tool_result);
    },
    invocations(): StoredToolInvocation[] {
      return [...invocations.values()];
    },
  };
}
