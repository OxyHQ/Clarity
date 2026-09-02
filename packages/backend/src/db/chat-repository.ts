import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import type { ConversationSource, Message as ProductMessage } from '@clarity/shared-types';

import { getDb, type ClarityExecutor } from './index.js';
import { conversations, messages } from './schema/index.js';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export async function createConversation(input: {
  oxyUserId: string;
  conversationId: string;
  title: string;
  source: ConversationSource;
  agentId?: string;
}): Promise<ConversationRow> {
  const [row] = await getDb().insert(conversations).values({
    id: randomUUID(),
    oxyUserId: input.oxyUserId,
    conversationId: input.conversationId,
    title: input.title,
    source: input.source,
    agentId: input.agentId ?? null,
  }).returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

export async function listConversations(
  oxyUserId: string,
  limit: number,
  before?: Date,
): Promise<ConversationRow[]> {
  return getDb().select().from(conversations)
    .where(before
      ? and(eq(conversations.oxyUserId, oxyUserId), lt(conversations.updatedAt, before))
      : eq(conversations.oxyUserId, oxyUserId))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);
}

export async function findConversation(
  oxyUserId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [row] = await getDb().select().from(conversations).where(and(
    eq(conversations.oxyUserId, oxyUserId),
    eq(conversations.conversationId, conversationId),
  )).limit(1);
  return row ?? null;
}

export async function listMessages(
  oxyUserId: string,
  conversationId: string,
): Promise<MessageRow[]> {
  return getDb().select().from(messages).where(and(
    eq(messages.oxyUserId, oxyUserId),
    eq(messages.conversationId, conversationId),
  )).orderBy(asc(messages.createdAt), asc(messages.id));
}

export interface WritableMessage {
  id?: string;
  role: ProductMessage['role'];
  content: ProductMessage['content'];
  vote?: 'up' | 'down';
  toolInvocations?: unknown[];
  agentInfo?: unknown;
  audioUrl?: string;
  createdAt?: Date | string;
}

function messageValues(
  oxyUserId: string,
  conversationId: string,
  rows: WritableMessage[],
): Array<typeof messages.$inferInsert> {
  return rows.map((message) => ({
    id: randomUUID(),
    messageId: message.id ?? null,
    oxyUserId,
    conversationId,
    role: message.role,
    content: message.content,
    vote: message.vote ?? null,
    toolInvocations: message.toolInvocations ?? [],
    agentInfo: message.agentInfo ?? null,
    audioUrl: message.audioUrl ?? null,
    createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
  }));
}

async function upsertConversationIn(
  tx: ClarityExecutor,
  input: {
    oxyUserId: string;
    conversationId: string;
    title?: string;
    titleOnInsert: string;
    lastMessage?: string;
    source?: ConversationSource;
    agentId?: string;
  },
): Promise<ConversationRow> {
  const changed = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.lastMessage === undefined ? {} : { lastMessage: input.lastMessage }),
    updatedAt: new Date(),
  };
  const [row] = await tx.insert(conversations).values({
    id: randomUUID(),
    oxyUserId: input.oxyUserId,
    conversationId: input.conversationId,
    title: input.title ?? input.titleOnInsert,
    ...(input.lastMessage === undefined ? {} : { lastMessage: input.lastMessage }),
    ...(input.source === undefined ? {} : { source: input.source }),
    agentId: input.agentId ?? null,
  }).onConflictDoUpdate({
    target: [conversations.oxyUserId, conversations.conversationId],
    set: changed,
  }).returning();
  if (!row) throw new Error('conversation upsert returned no row');
  return row;
}

/** Metadata and the full message replacement are one atomic unit. */
export async function replaceConversation(input: {
  oxyUserId: string;
  conversationId: string;
  title?: string;
  titleOnInsert: string;
  lastMessage?: string;
  source?: ConversationSource;
  agentId?: string;
  messages: WritableMessage[];
}): Promise<ConversationRow> {
  return getDb().transaction(async (tx) => {
    const row = await upsertConversationIn(tx, input);
    await tx.delete(messages).where(and(
      eq(messages.oxyUserId, input.oxyUserId),
      eq(messages.conversationId, input.conversationId),
    ));
    const values = messageValues(input.oxyUserId, input.conversationId, input.messages);
    if (values.length > 0) await tx.insert(messages).values(values);
    return row;
  });
}

export async function updateConversationTitle(
  oxyUserId: string,
  conversationId: string,
  title: string,
  onlyAutomatic = false,
): Promise<number> {
  const result = await getDb().update(conversations).set({ title, updatedAt: new Date() }).where(and(
    eq(conversations.oxyUserId, oxyUserId),
    eq(conversations.conversationId, conversationId),
    ...(onlyAutomatic ? [eq(conversations.isManualTitle, false)] : []),
  ));
  return result.count;
}

export async function voteMessage(
  oxyUserId: string,
  conversationId: string,
  messageId: string,
  vote: 'up' | 'down' | null,
): Promise<boolean> {
  const result = await getDb().update(messages).set({ vote }).where(and(
    eq(messages.oxyUserId, oxyUserId),
    eq(messages.conversationId, conversationId),
    eq(messages.messageId, messageId),
  ));
  return result.count > 0;
}

export async function deleteConversation(oxyUserId: string, conversationId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const result = await tx.delete(conversations).where(and(
      eq(conversations.oxyUserId, oxyUserId),
      eq(conversations.conversationId, conversationId),
    ));
    return result.count > 0;
  });
}

export async function countMessages(oxyUserId: string, conversationId: string): Promise<number> {
  const [row] = await getDb().select({ count: sql<number>`count(*)::int` }).from(messages).where(and(
    eq(messages.oxyUserId, oxyUserId),
    eq(messages.conversationId, conversationId),
  ));
  return row?.count ?? 0;
}
