/**
 * Feedback a person sends the Clarity team — the use cases behind `/feedback`
 * and the catalogue's feedback tools. Every read and write is scoped to the
 * person in the query itself, so another person's feedback is not-found.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { feedback as feedbackTable } from '../db/schema/index.js';

export const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export function isFeedbackType(value: unknown): value is FeedbackType {
  return typeof value === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(value);
}

export interface FeedbackInput {
  type: FeedbackType;
  message: string;
  rating?: number | null;
  email?: string | null;
  metadata?: unknown;
}

export async function submitFeedback(oxyUserId: string, input: FeedbackInput) {
  const [row] = await getDb()
    .insert(feedbackTable)
    .values({
      id: randomUUID(),
      oxyUserId,
      type: input.type,
      rating: input.rating ?? null,
      message: input.message,
      email: input.email ?? null,
      metadata: input.metadata ?? null,
      status: 'pending',
    })
    .returning();
  if (!row) throw new Error('feedback insert returned no row');
  return { id: row.id, type: row.type, message: row.message, createdAt: row.createdAt };
}

/** The person's last 50 messages, newest first. */
export function listFeedback(oxyUserId: string) {
  return getDb()
    .select()
    .from(feedbackTable)
    .where(eq(feedbackTable.oxyUserId, oxyUserId))
    .orderBy(desc(feedbackTable.createdAt), desc(feedbackTable.id))
    .limit(50);
}

export async function findFeedback(oxyUserId: string, id: string) {
  const [row] = await getDb()
    .select()
    .from(feedbackTable)
    .where(and(eq(feedbackTable.id, id), eq(feedbackTable.oxyUserId, oxyUserId)))
    .limit(1);
  return row;
}
