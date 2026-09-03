import type { Message, ToolInvocation } from '@clarity/shared-types';
import { getToolLabel } from '@/lib/sdk';

export interface Source {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface ThoughtStep {
  type: 'thinking' | 'tool' | 'done';
  label: string;
  toolName?: string;
  sources?: Source[];
  state?: 'partial-call' | 'call' | 'result';
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceFrom(value: unknown): Source | null {
  const record = asRecord(value);
  if (!record || typeof record.url !== 'string' || record.url.length === 0) return null;
  return {
    title: typeof record.title === 'string' && record.title.length > 0
      ? record.title
      : getDomain(record.url),
    url: record.url,
    snippet: typeof record.snippet === 'string' ? record.snippet : '',
    domain: getDomain(record.url),
  };
}

/**
 * Extract unique sources from tool invocations (webSearch, webScraper).
 */
export function extractSources(toolInvocations?: ToolInvocation[]): Source[] {
  if (!toolInvocations) return [];

  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const inv of toolInvocations) {
    if (inv.state !== 'result' || !inv.result) continue;
    const result = asRecord(inv.result);
    if (!result) continue;

    if ((inv.toolName === 'webSearch' || (inv.toolName === 'browse' && result.action === 'search')) && Array.isArray(result.results)) {
      for (const value of result.results) {
        const source = sourceFrom(value);
        if (source && !seen.has(source.url)) {
          seen.add(source.url);
          sources.push(source);
        }
      }
    }

    if (inv.toolName === 'browse' && result.action === 'read' && typeof result.url === 'string') {
      const url = result.url;
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          title: typeof result.title === 'string' ? result.title : getDomain(url),
          url,
          snippet: typeof result.content === 'string' ? result.content.slice(0, 200) : '',
          domain: getDomain(url),
        });
      }
    }

    if (inv.toolName === 'webScraper' && typeof result.url === 'string') {
      const url = result.url;
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          title: typeof result.title === 'string' ? result.title : getDomain(url),
          url,
          snippet: typeof result.content === 'string' ? result.content.slice(0, 200) : '',
          domain: getDomain(url),
        });
      }
    }
  }

  return sources;
}

/**
 * Build an ordered timeline of steps from a message's thinking + tool invocations.
 */
export function buildSteps(
  message: Pick<Message, 'thinking' | 'content' | 'toolInvocations'>,
  isStreaming: boolean,
): ThoughtStep[] {
  const steps: ThoughtStep[] = [];

  // 1. Thinking step
  if (message.thinking) {
    steps.push({ type: 'thinking', label: 'Thinking' });
  }

  // 2. Tool invocation steps
  if (message.toolInvocations) {
    for (const inv of message.toolInvocations) {
      const result = asRecord(inv.result);
      const step: ThoughtStep = {
        type: 'tool',
        label: getToolLabel(inv.toolName),
        toolName: inv.toolName,
        state: inv.state,
      };

      // Attach sources for search tools that have results
      if (
        (inv.toolName === 'webSearch' || (inv.toolName === 'browse' && result?.action === 'search'))
        && inv.state === 'result'
        && Array.isArray(result?.results)
      ) {
        step.sources = result.results.flatMap((value) => {
          const source = sourceFrom(value);
          return source ? [source] : [];
        });
      }

      steps.push(step);
    }
  }

  // 3. Done step (only when message has content and is not streaming)
  const hasContent =
    typeof message.content === 'string'
      ? message.content.length > 0
      : Array.isArray(message.content) && message.content.length > 0;

  if (hasContent && !isStreaming) {
    steps.push({ type: 'done', label: 'Done' });
  }

  return steps;
}

/**
 * Entry in the action audit timeline.
 */
export interface AuditEntry {
  id: string;
  type: 'tool_call' | 'research_phase' | 'plan_approved' | 'artifact_generated';
  label: string;
  description: string;
  status: 'in_progress' | 'complete';
  toolName?: string;
  messageId: string;
}

/**
 * Build a chronological audit timeline from all conversation messages.
 */
export function buildAuditTimeline(
  messages: Array<Message & { id: string }>,
): AuditEntry[] {
  const entries: AuditEntry[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    // Plan approved
    if (msg.pendingPlan?.approved) {
      entries.push({
        id: `plan-${msg.id}`,
        type: 'plan_approved',
        label: 'Plan approved',
        description: `${msg.pendingPlan.steps?.length || 0} steps`,
        status: 'complete',
        messageId: msg.id,
      });
    }

    // Tool invocations
    if (msg.toolInvocations) {
      for (const inv of msg.toolInvocations) {
        const isDone = inv.state === 'result';
        const toolLabel = getToolLabel(inv.toolName);
        const args = asRecord(inv.args);

        let description = '';
        if (typeof args?.query === 'string') {
          const q = args.query;
          description = q.length > 50 ? q.slice(0, 50) + '...' : q;
        } else if (typeof args?.url === 'string') {
          const u = args.url;
          description = u.length > 50 ? u.slice(0, 50) + '...' : u;
        }

        entries.push({
          id: inv.toolCallId || `tool-${msg.id}-${inv.toolName}`,
          type: 'tool_call',
          label: toolLabel,
          description,
          status: isDone ? 'complete' : 'in_progress',
          toolName: inv.toolName,
          messageId: msg.id,
        });

        // Artifact generated from generateFile
        if (inv.toolName === 'generateFile' && isDone && inv.result) {
          const result = asRecord(inv.result);
          entries.push({
            id: `artifact-${inv.toolCallId}`,
            type: 'artifact_generated',
            label: 'File generated',
            description: typeof result?.filename === 'string'
              ? result.filename
              : typeof result?.title === 'string' ? result.title : '',
            status: 'complete',
            messageId: msg.id,
          });
        }
      }
    }

    // Research phases
    if (msg.researchProgress) {
      const rp = msg.researchProgress;
      entries.push({
        id: `research-${msg.id}`,
        type: 'research_phase',
        label: rp.isComplete ? 'Research complete' : `Research: ${rp.phase || 'in progress'}`,
        description: rp.message || '',
        status: rp.isComplete ? 'complete' : 'in_progress',
        messageId: msg.id,
      });
    }
  }

  return entries;
}
