// ---------------------------------------------------------------------------
// @clarity/shared-types
//
// Types shared by BOTH the Clarity frontend (@clarity/frontend) and the
// Clarity backend (@clarity/backend). Import from `@clarity/shared-types`.
//
// MODEL ABSTRACTION RULE: nothing exported here may expose internal provider
// names, provider model ids, or provider routing details — only Clarity-branded
// model identities. See AGENTS.md "Model Abstraction Architecture".
// ---------------------------------------------------------------------------

export type {
  CursorPaginated,
  PaginationMeta,
  Paginated,
  ApiErrorResponse,
} from './common.js';

export type {
  ToolInvocation,
  AgentInfo,
  MessageContentBlock,
  MessageSource,
  MessageSpeaker,
  MessageVote,
  Message,
  ConversationSource,
  Conversation,
  FolderColor,
  ChatFolder,
} from './conversation.js';

export type {
  ModelCategory,
  ClarityModelCapabilities,
  ClarityModelPricing,
  ClarityModelDTO,
  ClarityModelsResponse,
} from './model.js';

export type {
  ResearchSource,
  ResearchProgress,
  ReasoningEvent,
  ToolResultEvent,
  TitleEvent,
  ModelSwitchEvent,
  ClaritySseEventName,
} from './sse.js';
