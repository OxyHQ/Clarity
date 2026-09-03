import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { getDb } from './index.js';
import { billingCustomers, subscriptions } from './schema/index.js';

export type SubscriptionRow = typeof subscriptions.$inferSelect;

export async function findActiveSubscriptions(oxyUserId: string): Promise<SubscriptionRow[]> {
  return getDb().select().from(subscriptions).where(and(
    eq(subscriptions.oxyUserId, oxyUserId),
    inArray(subscriptions.status, ['active', 'trialing']),
  )).orderBy(desc(subscriptions.createdAt), desc(subscriptions.id));
}

export async function findActiveSubscription(
  oxyUserId: string,
  product?: string,
): Promise<SubscriptionRow | null> {
  const rows = await findActiveSubscriptions(oxyUserId);
  if (!product) return rows[0] ?? null;
  return rows.find((row) => {
    const snapshot = row.planSnapshot as { product?: unknown };
    return snapshot.product === product;
  }) ?? null;
}

export async function findSubscriptionByStripeId(stripeSubscriptionId: string): Promise<SubscriptionRow | null> {
  const [row] = await getDb().select().from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId)).limit(1);
  return row ?? null;
}

export async function upsertSubscription(input: Omit<typeof subscriptions.$inferInsert, 'id'> & { id?: string }): Promise<SubscriptionRow> {
  const values = { ...input, id: input.id ?? randomUUID() };
  const updates: Partial<typeof subscriptions.$inferInsert> = { ...values };
  delete updates.id;
  const [row] = await getDb().insert(subscriptions).values(values).onConflictDoUpdate({
    target: subscriptions.stripeSubscriptionId,
    set: { ...updates, updatedAt: new Date() },
  }).returning();
  if (!row) throw new Error('subscription upsert returned no row');
  return row;
}

export async function updateSubscription(
  stripeSubscriptionId: string,
  patch: Partial<typeof subscriptions.$inferInsert>,
): Promise<SubscriptionRow | null> {
  const safe = { ...patch };
  delete safe.id;
  delete safe.stripeSubscriptionId;
  const [row] = await getDb().update(subscriptions).set({ ...safe, updatedAt: new Date() })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId)).returning();
  return row ?? null;
}

export async function findBillingCustomer(oxyUserId: string): Promise<string | null> {
  const [row] = await getDb().select({ stripeCustomerId: billingCustomers.stripeCustomerId })
    .from(billingCustomers).where(eq(billingCustomers.oxyUserId, oxyUserId)).limit(1);
  return row?.stripeCustomerId ?? null;
}

export async function setBillingCustomer(oxyUserId: string, stripeCustomerId: string): Promise<void> {
  await getDb().insert(billingCustomers).values({ oxyUserId, stripeCustomerId })
    .onConflictDoUpdate({
      target: billingCustomers.oxyUserId,
      set: { stripeCustomerId, updatedAt: new Date() },
    });
}
