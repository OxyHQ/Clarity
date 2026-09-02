// ---------------------------------------------------------------------------
// Conversation / Message DTOs — the wire shape exchanged between the Clarity
// frontend and backend over HTTP. The PostgreSQL repositories use these
// interfaces; the frontend hooks consume them directly.
// ---------------------------------------------------------------------------

/**
 * Canonical tool-invocation shape. Used across SSE streaming, the conversation
 * hooks, and the chat UI.
 */
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: unknown;
  result?: unknown;
}

/**
 * Metadata attached to an assistant message when the conversation delegated to
 * a specialist agent.
 */
export interface AgentInfo {
  id: string;
  name: string;
  avatar: string | null;
  handle: string;
  accessories?: string[];
}

/** A single block of structured message content. */
export interface MessageContentBlock {
  type: string;
  [key: string]: unknown;
}

/** Originating modality for a message. */
export type MessageSource = 'text' | 'voice';

/** Speaker identity for voice-originated messages. */
export type MessageSpeaker = 'primary' | 'cohost';

/** A user vote on an assistant message. */
export type MessageVote = 'up' | 'down';

/**
 * Incremental deep-research progress attached to an assistant message while a
 * research run is in flight (mirrors the `clarity.research_progress` SSE event).
 */
export interface MessageResearchProgress {
  phase?: string;
  message?: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
  isComplete?: boolean;
}

/** A single step of an agent execution plan awaiting user approval. */
export interface PlanStep {
  title?: string;
  description?: string;
}

/** Plan preview attached to an assistant message, awaiting user approval. */
export interface PendingPlan {
  planId: string;
  steps: PlanStep[];
  approved: boolean;
  rejected: boolean;
}

/** Tool-execution approval request attached to an assistant message. */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  description?: string;
  severity?: string;
  timeout?: number;
  args?: unknown;
}

/** Resolution of a tool-execution approval request. */
export interface PendingApprovalResult {
  requestId: string;
  decision: string;
}

/**
 * A single chat message DTO. Shared by the frontend chat UI and the backend
 * message model / API responses.
 */
export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string | MessageContentBlock[];
  /** Extended thinking content (present when thinking mode is enabled). */
  thinking?: string;
  vote?: MessageVote;
  toolInvocations?: ToolInvocation[];
  /** Originating modality (present for voice-originated messages). */
  source?: MessageSource;
  /** Speaker identity (present for voice-originated messages). */
  speaker?: MessageSpeaker;
  isStreaming?: boolean;
  /** Present when the message was produced by a delegated specialist agent. */
  agentInfo?: AgentInfo;
  audioUrl?: string;
  createdAt?: string | Date;
  /** Deep-research progress (present while a research run streams). */
  researchProgress?: MessageResearchProgress;
  /** Agent execution plan awaiting user approval. */
  pendingPlan?: PendingPlan;
  /** Tool-execution approval request awaiting user decision. */
  pendingApproval?: PendingApproval;
  /** Resolution of a tool-execution approval request. */
  pendingApprovalResult?: PendingApprovalResult;
}

/**
 * Source app/platform a conversation originated from. Extensible for future
 * integrations.
 */
export type ConversationSource =
  | 'app'
  | 'telegram'
  | 'api'
  | 'web'
  | 'discord'
  | 'whatsapp'
  | 'slack';

/**
 * A conversation DTO. Shared by the frontend conversation hooks and the
 * backend conversation model / API responses.
 */
export interface Conversation {
  id: string;
  title: string;
  isManualTitle?: boolean;
  lastMessage?: string;
  source?: ConversationSource;
  folderId?: string | null;
  icon?: string;
  iconColor?: string;
  isFavorite?: boolean;
  isPublic?: boolean;
  agentId?: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  messages?: Message[];
}

/** Color options for chat folders. */
export type FolderColor =
  | 'gray'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink';

/** A chat folder used to organize conversations. */
export interface ChatFolder {
  id: string;
  name: string;
  color: FolderColor;
  icon?: string;
  parentId?: string | null;
  /** UI-only open/closed state. */
  isOpen?: boolean;
}
