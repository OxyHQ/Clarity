import type { Message } from '@clarity/shared-types';
import { getToolLabel } from '@/lib/sdk';
import { asRecord, sourceFrom, type Source } from '@/lib/message-sources';

export { extractSources, type Source } from '@/lib/message-sources';

export interface ThoughtStep {
  type: 'thinking' | 'tool' | 'done';
  label: string;
  toolName?: string;
  sources?: Source[];
  state?: 'partial-call' | 'call' | 'result';
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
