// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) payloads for Clarity's streaming chat responses.
// Custom `clarity.*` events are emitted by the backend and consumed by the
// frontend stream reader. Payload shapes are shared so both sides stay in sync.
//
// MODEL ABSTRACTION RULE: `clarity.model_switch` carries only Clarity-branded
// model ids — never provider names or provider model ids.
// ---------------------------------------------------------------------------

/** A web source surfaced during research/search. */
export interface ResearchSource {
  id: number;
  url: string;
  title: string;
}

/** Incremental research-progress payload (`clarity.research_progress`). */
export interface ResearchProgress {
  phase?: string;
  message?: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
  isComplete?: boolean;
  sources?: ResearchSource[];
  totalSearches?: number;
}

/** Reasoning / extended-thinking delta payload (`clarity.reasoning`). */
export interface ReasoningEvent {
  text: string;
}

/** Tool-result payload (`clarity.tool_result`). */
export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

/** Conversation-title payload (`clarity.title`). */
export interface TitleEvent {
  title: string;
}

/**
 * Model-switch payload (`clarity.model_switch`) — emitted when the request is
 * served by a different Clarity model than requested (e.g. an availability
 * fallback). Only Clarity-branded ids are exposed.
 */
export interface ModelSwitchEvent {
  /** Clarity model id originally requested. */
  from: string;
  /** Clarity model id actually used. */
  to: string;
  reason?: string;
}

/** Names of the custom SSE events Clarity emits. */
export type ClaritySseEventName =
  | 'clarity.research_progress'
  | 'clarity.reasoning'
  | 'clarity.tool_result'
  | 'clarity.title'
  | 'clarity.model_switch'
  | 'clarity.agent'
  | 'clarity.approval_request'
  | 'clarity.approval_result'
  | 'clarity.bloom'
  | 'clarity.oxy';
