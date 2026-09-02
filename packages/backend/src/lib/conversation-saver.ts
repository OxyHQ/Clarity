/**
 * Conversation Saver
 * Shared utility for extracting titles and persisting conversations.
 * Used by both the internal chat endpoint and the v1/chat-completions endpoint.
 */

import type { ConversationSource } from '@clarity/shared-types';
import {
  countMessages,
  findConversation,
  replaceConversation,
  updateConversationTitle,
  type WritableMessage,
} from '../db/chat-repository.js';
import { log } from './logger.js';

// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`CLARITY_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;
const TITLE_EXTRACT_RE = new RegExp(String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`, 'i');
const TITLE_STRIP_RE = new RegExp(String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi');

/** Extract or generate a conversation title from the AI response, with fallbacks. */
export function extractConversationTitle(response: string, messages: any[]): string {
  const m = response.match(TITLE_EXTRACT_RE);
  if (m) return (m[2] || m[4]).trim();

  // Prefer the first user message (most descriptive of conversation topic)
  const firstUserMsg = messages.find((msg: any) => msg.role === 'user')?.content;
  if (typeof firstUserMsg === 'string' && firstUserMsg.length > 0) return firstUserMsg.slice(0, 60);

  // Fallback: first ~6 words of cleaned response
  const cleaned = response.replace(/\[.*?\]|<.*?>|[#*_`]/g, '').trim();
  if (cleaned.length >= 10) return cleaned.split(/\s+/).slice(0, 6).join(' ');

  return 'New chat';
}

/** Remove [TITLE]...[/TITLE] and <TITLE>...</TITLE> tags from content. */
export function stripTitleTags(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').trim();
}

export interface SaveConversationParams {
  userId: string;
  conversationId: string;
  messages: any[];
  assistantResponse: string;
  toolInvocations?: any[];
  source?: ConversationSource;
  agentId?: string;
  agentMessages?: Array<{ role: 'assistant'; content: string; agentInfo: { id: string; name: string; avatar: string | null; handle: string } }>;
}

/**
 * Save or update a conversation in the database.
 * Handles title extraction, tag stripping, and message assembly.
 */
export async function saveConversation(params: SaveConversationParams): Promise<void> {
  const { userId, conversationId, messages, assistantResponse, toolInvocations, source, agentId, agentMessages } = params;

  const allMessages: WritableMessage[] = [
    ...messages.filter(m => m && m.role).map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      vote: m.vote,
      toolInvocations: m.toolInvocations,
      agentInfo: m.agentInfo,
      audioUrl: m.audioUrl,
      createdAt: m.createdAt,
    })),
    // Insert agent messages before the final assistant response
    ...(agentMessages || []).map(am => ({
      role: am.role,
      content: am.content,
      agentInfo: am.agentInfo,
    })),
    {
      role: 'assistant' as const,
      content: stripTitleTags(assistantResponse),
      ...(toolInvocations && toolInvocations.length > 0 && { toolInvocations }),
    },
  ].filter(msg => msg != null && msg.role && msg.content !== undefined);

  const title = extractConversationTitle(assistantResponse, messages);

  await replaceConversation({
    oxyUserId: userId,
    conversationId,
    titleOnInsert: title,
    lastMessage: stripTitleTags(assistantResponse).slice(0, 100),
    source: source || 'app',
    ...(agentId ? { agentId } : {}),
    messages: allMessages,
  });
}

/**
 * Generate a stable local fallback title without opening a second inference
 * path. The Alia stream's `alia.title` event is authoritative when present.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  const title = userMessage
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ')
    .slice(0, 80);
  return title || null;
}

/**
 * Generate a conversation title asynchronously and save it to DB.
 * Skips if the conversation already has a meaningful title or was manually titled.
 * Used as fire-and-forget fallback for non-streaming paths.
 */
export async function generateConversationTitle(
  userId: string,
  conversationId: string,
  userMessage: string,
): Promise<void> {
  try {
    const conv = await findConversation(userId, conversationId);
    if (!conv || conv.isManualTitle) return;
    const messageCount = await countMessages(userId, conversationId);
    if (messageCount > 3) return;

    const title = await generateTitle(userMessage);
    if (title) {
      await updateConversationTitle(userId, conversationId, title, true);
      log.chat.info({ conversationId, title }, 'Auto-generated conversation title');
    }
  } catch (err) {
    log.chat.error({ err, conversationId }, 'generateConversationTitle failed');
  }
}
