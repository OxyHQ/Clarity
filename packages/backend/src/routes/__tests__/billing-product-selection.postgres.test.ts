import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { eq, inArray } from 'drizzle-orm';
import express from 'express';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const stripe = vi.hoisted(() => ({
  update: vi.fn(async (_id: string, _input: unknown) => ({})),
  retrieve: vi.fn(async (id: string) => ({ items: { data: [{ id: `item-${id}` }] }, metadata: {}, cancel_at_period_end: false })),
}));
vi.mock('stripe', () => ({ default: class {
  subscriptions = stripe;
  products = { create: () => { throw new Error('Unexpected Stripe product creation'); } };
  prices = { create: () => { throw new Error('Unexpected Stripe price creation'); } };
} }));

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { plans, subscriptions } from '../../db/schema/index.js';
import { upsertSubscription } from '../../db/subscription-repository.js';
import { oxyClient } from '../../middleware/auth.js';
import billing from '../billing.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const prefix = `billing-selection-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const planIds = [`${prefix}-clarity-old`, `${prefix}-clarity-new`, `${prefix}-codea`, `${prefix}-codea-new`];
const nativeFetch = globalThis.fetch;
let server: Server;
let origin: string;
let previousStripeKey: string | undefined;
const fixtureSchema = `billing_selection_${randomUUID().replaceAll('-', '')}`;
let admin: postgres.Sql;

function token(userId = owner) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.fixture`;
}

async function request(path: string, body?: unknown, userId = owner) {
  const response = await nativeFetch(`${origin}/billing/subscription/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token(userId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const decoded = z.object({ subscription: z.object({ id: z.string(), status: z.string(), cancelAtPeriodEnd: z.boolean() }).passthrough().optional() }).passthrough().parse(await response.json());
  return { status: response.status, body: decoded };
}

async function subscription(product: 'clarity' | 'codea', overrides: { id?: string; status?: string; userId?: string; createdAt?: Date } = {}) {
  const planId = product === 'clarity' ? planIds[0] : planIds[2];
  return upsertSubscription({
    id: overrides.id ?? `${prefix}-${randomUUID()}`, oxyUserId: overrides.userId ?? owner,
    stripeCustomerId: `customer-${prefix}`, stripeSubscriptionId: `sub-${randomUUID()}`, stripePriceId: `price-${planId}`,
    status: overrides.status ?? 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000),
    planId, billingPeriod: 'monthly', planSnapshot: { planId, name: planId, product, creditsPerMonth: 0, price: 10, currency: 'usd', billingPeriod: 'monthly' },
    createdAt: overrides.createdAt ?? new Date(),
  });
}

suite('billing mutation selects the owned product subscription over real HTTP and PostgreSQL', () => {
  beforeAll(async () => {
    if (new URL(databaseUrl).pathname !== '/clarity_ci') throw new Error('Billing integration requires disposable clarity_ci');
    // Other integration suites truncate public product tables and reconcile
    // exact inventories. Clone the migrated billing definitions, including
    // constraints/indexes, so this fixture cannot race or contaminate them.
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA "${fixtureSchema}"`);
    for (const table of ['clarity_plans', 'clarity_subscriptions']) {
      await admin.unsafe(`CREATE TABLE "${fixtureSchema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('search_path', fixtureSchema);
    connectPostgres(scopedUrl.toString());
    await getDb().insert(plans).values(planIds.map((planId, index) => ({
      id: planId, planId, name: planId, product: index >= 2 ? 'codea' : 'clarity', sortOrder: index,
      monthlyPrice: 10, annualPrice: 100, stripeMonthlyPriceId: `price-${planId}`,
    })));
    // Synthetic central session validation; the published shared middleware,
    // route handlers, catalogue and subscription repositories remain real.
    vi.spyOn(oxyClient.session, 'validate').mockImplementation(async (sessionId) => ({ valid: true, user: { id: sessionId, publicKey: 'fixture-public-key', username: 'fixture', name: {} }, expiresAt: new Date(Date.now() + 600000).toISOString(), lastActivity: new Date().toISOString() }));
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external network'); }));
    previousStripeKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_local_fixture_not_a_credential';
    const app = express(); app.use(express.json()); app.use('/billing', billing);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await getDb().delete(subscriptions).where(inArray(subscriptions.oxyUserId, [owner, stranger]));
    stripe.update.mockClear(); stripe.retrieve.mockClear();
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closePostgres();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`);
      await admin.end();
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (previousStripeKey === undefined) Reflect.deleteProperty(process.env, 'STRIPE_SECRET_KEY'); else process.env.STRIPE_SECRET_KEY = previousStripeKey;
  });
  it('legacy cancel refuses two products before any Stripe operation', async () => {
    await subscription('clarity', { createdAt: new Date(0) }); await subscription('codea');
    expect((await request('cancel')).status).toBe(409);
    expect(stripe.update).not.toHaveBeenCalled();
    expect((await getDb().select().from(subscriptions).where(eq(subscriptions.oxyUserId, owner))).every(row => !row.cancelAtPeriodEnd)).toBe(true);
  });
  it('explicit cancel targets the displayed older product only', async () => {
    const selected = await subscription('clarity', { createdAt: new Date(0) }); const other = await subscription('codea');
    const result = await request('cancel', { subscriptionId: selected.id });
    expect(result.status).toBe(200); expect(result.body.subscription?.id).toBe(selected.id);
    expect(stripe.update.mock.calls.map(call => call[0])).toEqual([selected.stripeSubscriptionId]);
    const [untouched] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, other.id));
    expect(untouched.cancelAtPeriodEnd).toBe(false);
  });
  it('foreign and nonexistent selectors disclose no subscription and make no provider call', async () => {
    await subscription('clarity'); const foreign = await subscription('codea', { userId: stranger });
    const foreignResult = await request('cancel', { subscriptionId: foreign.id });
    expect(foreignResult.status).toBe(404);
    expect(foreignResult).toEqual(await request('cancel', { subscriptionId: `${prefix}-missing` }));
    expect(stripe.update).not.toHaveBeenCalled();
  });
  it.each(['clarity', 'codea'] as const)('change-plan selects %s, never the newer other product', async product => {
    const otherProduct = product === 'clarity' ? 'codea' : 'clarity';
    const selected = await subscription(product, { createdAt: new Date(0) }); const other = await subscription(otherProduct);
    const result = await request('change-plan', { planId: product === 'clarity' ? planIds[1] : planIds[3] });
    expect(result.status).toBe(200); expect(result.body.subscription?.id).toBe(selected.id);
    expect(stripe.retrieve.mock.calls.map(call => call[0])).toEqual([selected.stripeSubscriptionId]);
    expect(stripe.update.mock.calls.map(call => call[0])).toEqual([selected.stripeSubscriptionId]);
    const [untouched] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, other.id));
    expect(untouched.planId).toBe(other.planId);
  });
  it('duplicate subscriptions for the target product fail closed before price or provider lookup', async () => {
    await subscription('clarity'); await subscription('clarity');
    expect((await request('change-plan', { planId: planIds[1] })).status).toBe(409);
    expect(stripe.retrieve).not.toHaveBeenCalled(); expect(stripe.update).not.toHaveBeenCalled();
  });
  it.each(['active', 'trialing', 'past_due', 'unpaid'])('a sole %s subscription keeps period-end cancellation without changing status', async status => {
    const selected = await subscription('clarity', { status });
    const result = await request('cancel');
    expect(result.status).toBe(200);
    expect(result.body.subscription).toMatchObject({ id: selected.id, status, cancelAtPeriodEnd: true });
    expect(stripe.update).toHaveBeenCalledExactlyOnceWith(selected.stripeSubscriptionId, { cancel_at_period_end: true });
    expect(stripe.retrieve).not.toHaveBeenCalled();
  });
  it('incomplete is a conflict before provider update and participates in legacy ambiguity', async () => {
    const incomplete = await subscription('clarity', { status: 'incomplete' });
    expect((await request('cancel', { subscriptionId: incomplete.id })).status).toBe(409);
    await subscription('codea');
    expect((await request('cancel')).status).toBe(409);
    expect(stripe.update).not.toHaveBeenCalled();
  });
  it.each(['canceled', 'incomplete_expired'])('terminal %s is not a cancellation candidate', async status => {
    const terminal = await subscription('clarity', { status });
    expect((await request('cancel', { subscriptionId: terminal.id })).status).toBe(404);
    const selected = await subscription('codea');
    expect((await request('cancel')).body.subscription?.id).toBe(selected.id);
    expect(stripe.update).toHaveBeenCalledExactlyOnceWith(selected.stripeSubscriptionId, { cancel_at_period_end: true });
  });
  it.each([{ subscriptionId: '' }, { subscriptionId: ' ' }, { subscriptionId: 3 }, { product: 'clarity' }, { subscriptionId: null }])('invalid selector %j is 400 without a mutation', async input => {
    await subscription('clarity');
    expect((await request('cancel', input)).status).toBe(400);
    expect(stripe.update).not.toHaveBeenCalled();
  });
  it('another product or another account cannot satisfy change-plan ownership', async () => {
    const other = await subscription('codea');
    await subscription('clarity', { userId: stranger });
    expect((await request('change-plan', { planId: planIds[1] })).status).toBe(404);
    expect(stripe.retrieve).not.toHaveBeenCalled(); expect(stripe.update).not.toHaveBeenCalled();
    const [unchanged] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, other.id));
    expect(unchanged.planId).toBe(planIds[2]);
  });
  it.each([null, planIds[2]])('missing or cross-product current catalogue plan %s fails before Stripe', async planId => {
    const selected = await subscription('clarity');
    await getDb().update(subscriptions).set({ planId }).where(eq(subscriptions.id, selected.id));
    expect((await request('change-plan', { planId: planIds[1] })).status).toBe(500);
    expect(stripe.retrieve).not.toHaveBeenCalled(); expect(stripe.update).not.toHaveBeenCalled();
  });
  it('invalid plan and invalid change input preserve both products', async () => {
    await subscription('clarity'); await subscription('codea');
    expect((await request('change-plan', { planId: `${prefix}-missing` })).status).toBe(400);
    expect((await request('change-plan', { planId: 10 })).status).toBe(400);
    expect(stripe.retrieve).not.toHaveBeenCalled(); expect(stripe.update).not.toHaveBeenCalled();
  });
  it('same target plan remains a no-op error', async () => {
    await subscription('clarity');
    expect((await request('change-plan', { planId: planIds[0] })).status).toBe(400);
    expect(stripe.retrieve).not.toHaveBeenCalled(); expect(stripe.update).not.toHaveBeenCalled();
  });
  it('shared middleware refuses a missing session instead of reaching billing', async () => {
    await subscription('clarity');
    const response = await nativeFetch(`${origin}/billing/subscription/cancel`, { method: 'POST' });
    expect(response.status).toBe(401); expect(stripe.update).not.toHaveBeenCalled();
  });
});
