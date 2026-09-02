import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authenticateToken, oxyClient } from '../middleware/auth.js';
import { getPlans, getFeatures, getPlanFeatures, getAllClarityModels, type PlanFeatureData } from '../lib/product-catalogue.js';
import { ensureStripePriceId } from '../lib/stripe-prices.js';
import { getUserEntitlements, invalidateEntitlementsCache } from '../lib/plan-access.js';
import { proxyAliaJson } from '../lib/alia-agent-client.js';
import {
  findActiveSubscription,
  findBillingCustomer,
  setBillingCustomer,
  updateSubscription,
  upsertSubscription,
  type SubscriptionRow,
} from '../db/subscription-repository.js';
import { z } from 'zod';
import { log } from '../lib/logger.js';

const router = Router();
// Database, Stripe and upstream details are logged server-side only.
const getSafeErrorMessage = (_error: unknown, fallback: string): string => fallback;

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not defined');
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-06-24.dahlia',
    });
  }
  return stripeInstance;
}

function getWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}

function serializeSubscription(subscription: SubscriptionRow) {
  return {
    _id: subscription.id,
    userId: subscription.oxyUserId,
    stripeCustomerId: subscription.stripeCustomerId,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    stripePriceId: subscription.stripePriceId,
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    plan: subscription.planSnapshot,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

// Helper to get or create Stripe customer
async function getOrCreateStripeCustomer(userId: string): Promise<string> {
  let customerId = await findBillingCustomer(userId);

  if (customerId) {
    try {
      const customer = await getStripe().customers.retrieve(customerId);
      if (!customer.deleted) return customerId;
    } catch (error: unknown) {
      const isMissing = error instanceof Stripe.errors.StripeInvalidRequestError
        && (error.statusCode === 404 || error.code === 'resource_missing');
      if (!isMissing) throw error;
    }
  }

  // Historical credit-only customers moved to Alia, while Clarity keeps the
  // product-subscription entitlement. Recover their existing Stripe identity
  // by exact metadata before creating a second customer.
  const escapedUserId = userId.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const existing = await getStripe().customers.search({
    query: `metadata['userId']:'${escapedUserId}'`,
    limit: 2,
  });
  if (existing.data.length > 1) {
    throw new Error('Multiple Stripe customers match the Oxy user identity');
  }
  if (existing.data[0]) {
    await setBillingCustomer(userId, existing.data[0].id);
    return existing.data[0].id;
  }

  // Fetch email from Oxy
  let email: string | undefined;
  try {
    const oxyUser = await oxyClient.getUserById(userId);
    email = oxyUser?.email;
  } catch (e: unknown) {
    log.credits.error({ err: e }, 'Failed to fetch user from Oxy');
  }

  const customer = await getStripe().customers.create({
    email,
    metadata: { userId },
  });

  await setBillingCustomer(userId, customer.id);
  log.credits.info({ customerId: customer.id, userId }, 'Created Stripe customer');

  return customer.id;
}

router.get('/packages', async (req: Request, res: Response) => {
  await proxyAliaJson(req, res, '/billing/packages', { requireUser: false });
});

const createCheckoutSchema = z.object({
  packageId: z.string(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/credits', authenticateToken, async (req: Request, res: Response) => {
  const parsed = createCheckoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  await proxyAliaJson(req, res, '/billing/checkout/credits');
});

// Custom credit amount purchase
const MIN_CUSTOM_CREDITS = 100;
const MAX_CUSTOM_CREDITS = 1_000_000;

const customCreditsSchema = z.object({
  credits: z.number().int().min(MIN_CUSTOM_CREDITS).max(MAX_CUSTOM_CREDITS),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/custom-credits', authenticateToken, async (req: Request, res: Response) => {
  const parsed = customCreditsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  await proxyAliaJson(req, res, '/billing/checkout/custom-credits');
});

// Expose the per-credit rate so the frontend can show live pricing
router.get('/credit-price', async (req: Request, res: Response) => {
  await proxyAliaJson(req, res, '/billing/credit-price', { requireUser: false });
});

router.get('/plans', async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const planFilter: Record<string, unknown> = { isActive: true };
    if (product) planFilter.product = product;

    const [dbPlans, rawFeatures, rawPlanFeatures] = await Promise.all([
      getPlans(planFilter),
      getFeatures(),
      getPlanFeatures(),
    ]);
    // Filter features/plan-features client-side (API may return all)
    const allFeatures = rawFeatures.filter(f => f.isActive !== false && f.isVisibleOnPricing !== false);
    const allPlanFeatures = rawPlanFeatures.filter(pf => pf.enabled !== false);

    // Build lookup: planId -> featureId -> PlanFeature mapping
    const pfMap: Record<string, Record<string, PlanFeatureData>> = {};
    for (const pf of allPlanFeatures) {
      if (!pfMap[pf.planId]) pfMap[pf.planId] = {};
      pfMap[pf.planId][pf.featureId] = pf;
    }

    // Load the Clarity product catalogue.
    let modelMap: Record<string, { displayName: string; description?: string }> = {};
    try {
      const clarityModels = await getAllClarityModels();
      for (const m of clarityModels) {
        modelMap[m.id] = { displayName: m.name, description: m.description };
      }
    } catch { /* ignore */ }

    const plans = dbPlans.map(p => {
      const planId = p.planId;
      const planMappings = pfMap[planId] || {};

      // Build feature groups from Feature + PlanFeature collections
      const groupMap = new Map<string, { label: string; description?: string }[]>();

      for (const feat of allFeatures) {
        const mapping = planMappings[feat.featureId];
        if (!mapping) continue;

        const category = feat.category;
        if (!groupMap.has(category)) groupMap.set(category, []);

        groupMap.get(category)!.push({
          label: mapping.displayLabel || feat.label,
          description: mapping.displayDescription || feat.description,
        });
      }

      // Convert to array, preserving category order from features query
      const features: { category: string; items: { label: string; description?: string }[] }[] = [];
      const seenCategories = new Set<string>();
      for (const feat of allFeatures) {
        if (seenCategories.has(feat.category)) continue;
        const items = groupMap.get(feat.category);
        if (items && items.length > 0) {
          features.push({ category: feat.category, items });
          seenCategories.add(feat.category);
        }
      }

      // Insert "Models" group from modelIds (after Credits if present, else at start)
      const modelIds: string[] = p.modelIds || [];
      if (modelIds.length > 0) {
        const modelItems = modelIds
          .map(id => modelMap[id])
          .filter(Boolean)
          .map(m => ({ label: m!.displayName, description: m!.description }));

        if (modelItems.length > 0) {
          const insertAt = features.length > 0 && features[0].category === 'Credits' ? 1 : 0;
          features.splice(insertAt, 0, { category: 'Models', items: modelItems });
        }
      }

      return {
        id: planId,
        name: p.name,
        product: p.product,
        creditsPerMonth: p.creditsPerMonth,
        monthlyPrice: p.monthlyPrice,
        annualPrice: p.annualPrice,
        currency: p.currency,
        features,
        subtitle: p.subtitle,
        creditsLabel: p.creditsLabel,
        isFeatured: p.isFeatured,
        isFree: p.isFree,
        sortOrder: p.sortOrder,
      };
    });
    res.json({ plans });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching plans');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch plans') });
  }
});

const createSubscriptionSchema = z.object({
  planId: z.string(),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, billingPeriod, successUrl, cancelUrl } = createSubscriptionSchema.parse(req.body);
    const userId = req.user!.id;

    const matchingPlans = await getPlans({ planId, isActive: true, isFree: false });
    const plan = matchingPlans[0];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    const existingSubscription = await findActiveSubscription(userId, plan.product);

    if (existingSubscription) {
      return res.status(409).json({
        error: 'You already have an active subscription for this product. Please cancel it first or manage it from the billing page.',
      });
    }

    const customerId = await getOrCreateStripeCustomer(userId);

    let stripePriceId: string;
    try {
      stripePriceId = await ensureStripePriceId(getStripe, plan.planId, billingPeriod);
    } catch (err: unknown) {
      log.credits.error({ err, planId: plan.planId, billingPeriod }, 'Failed to ensure Stripe price for checkout');
      return res.status(500).json({ error: 'Failed to configure plan pricing' });
    }

    const lineItem = { price: stripePriceId, quantity: 1 };

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [lineItem],
      mode: 'subscription',
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, planId: plan.planId, billingPeriod, product: plan.product },
      subscription_data: { metadata: { userId, planId: plan.planId, billingPeriod, product: plan.product } },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    log.credits.error({ err: error }, 'Error creating subscription checkout');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create subscription checkout') });
  }
});

router.get('/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const subscription = await findActiveSubscription(req.user!.id, product);
    res.json({ subscription: subscription ? serializeSubscription(subscription) : null });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching subscription');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch subscription') });
  }
});

router.post('/subscription/cancel', authenticateToken, async (req: Request, res: Response) => {
  try {
    const subscription = await findActiveSubscription(req.user!.id);

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    const updated = await updateSubscription(subscription.stripeSubscriptionId, { cancelAtPeriodEnd: true });

    res.json({ message: 'Subscription will be canceled at end of billing period', subscription: updated ? serializeSubscription(updated) : null });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error canceling subscription');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to cancel subscription') });
  }
});

const changePlanSchema = z.object({
  planId: z.string(),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
});

router.post('/subscription/change-plan', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, billingPeriod } = changePlanSchema.parse(req.body);
    const userId = req.user!.id;

    // Find existing active subscription
    const subscription = await findActiveSubscription(userId);

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Find target plan
    const targetPlans = await getPlans({ planId, isActive: true, isFree: false });
    const targetPlan = targetPlans[0];
    if (!targetPlan) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    // Guard: same plan + same billing period
    if (subscription.planId === planId && subscription.billingPeriod === billingPeriod) {
      return res.status(400).json({ error: 'You are already on this plan' });
    }

    // Look up current plan for sortOrder comparison
    const currentPlans = await getPlans({ planId: subscription.planId });
    const currentPlan = currentPlans[0];
    if (!currentPlan) {
      return res.status(500).json({ error: 'Current plan not found' });
    }

    const isUpgrade = targetPlan.sortOrder > currentPlan.sortOrder;
    const isAnnual = billingPeriod === 'annual';

    let targetPriceId: string;
    try {
      targetPriceId = await ensureStripePriceId(getStripe, targetPlan.planId, billingPeriod);
    } catch (err: unknown) {
      log.credits.error({ err, planId: targetPlan.planId, billingPeriod }, 'Failed to ensure Stripe price');
      return res.status(500).json({ error: 'Failed to configure plan pricing' });
    }

    // Retrieve Stripe subscription to get item ID
    const stripeSubscription = await getStripe().subscriptions.retrieve(subscription.stripeSubscriptionId);
    const itemId = stripeSubscription.items.data[0]?.id;
    if (!itemId) {
      return res.status(500).json({ error: 'Could not find subscription item' });
    }

    // If pending cancellation, undo it first
    if (stripeSubscription.cancel_at_period_end) {
      await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    }

    // Update the Stripe subscription
    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{ id: itemId, price: targetPriceId }],
      proration_behavior: isUpgrade ? 'always_invoice' : 'none',
      metadata: {
        ...stripeSubscription.metadata,
        planId: targetPlan.planId,
        billingPeriod,
        product: targetPlan.product,
      },
    });

    // Update local subscription document
    const price = isAnnual ? targetPlan.annualPrice : targetPlan.monthlyPrice;
    const updatedSubscription = await updateSubscription(subscription.stripeSubscriptionId, {
      planId: targetPlan.planId,
      billingPeriod,
      cancelAtPeriodEnd: false,
      stripePriceId: targetPriceId,
      planSnapshot: {
      planId: targetPlan.planId,
      name: targetPlan.name,
      product: targetPlan.product,
      creditsPerMonth: targetPlan.creditsPerMonth,
      price,
      currency: targetPlan.currency,
      billingPeriod,
      },
    });
    if (!updatedSubscription) throw new Error('Subscription disappeared during plan change');

    invalidateEntitlementsCache(userId);

    const direction = isUpgrade ? 'upgrade' : 'downgrade';
    log.credits.info({ userId, from: currentPlan.planId, to: targetPlan.planId, direction, billingPeriod }, 'Plan changed');
    res.json({ message: 'Plan changed successfully', subscription: serializeSubscription(updatedSubscription), direction });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    log.credits.error({ err: error }, 'Error changing plan');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to change plan') });
  }
});

router.get('/transactions', authenticateToken, async (req: Request, res: Response) => {
  await proxyAliaJson(req, res, '/billing/transactions');
});

router.post('/portal', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { returnUrl } = req.body;
    const userId = req.user!.id;

    const customerId = await getOrCreateStripeCustomer(userId);

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error creating portal session');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create billing portal session') });
  }
});

// Entitlements: returns allowed models + feature flags for the current user
router.get('/entitlements', authenticateToken, async (req: Request, res: Response) => {
  try {
    const entitlements = await getUserEntitlements(req.user!.id);
    res.json(entitlements);
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching entitlements');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch entitlements') });
  }
});

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.status(400).send('Missing stripe-signature');

  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) return res.status(500).send('Webhook secret not configured');

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: unknown) {
    log.credits.error({ err }, 'Webhook verification failed');
    return res.status(400).send(`Webhook Error: ${getSafeErrorMessage(err, 'Invalid webhook payload')}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
    }
    res.json({ received: true });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error handling webhook');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to process webhook') });
  }
});

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Credit purchases are created and fulfilled by Alia. This endpoint only
  // mirrors Clarity product subscriptions for local product entitlements.
  if (session.mode === 'subscription' && session.subscription) {
    log.credits.info({ subscriptionId: session.subscription }, 'checkout.session.completed, fetching and syncing');
    const stripeSubscription = await getStripe().subscriptions.retrieve(session.subscription as string);
    await handleSubscriptionUpdate(stripeSubscription);
  }
}

async function handleSubscriptionUpdate(stripeSubscription: Stripe.Subscription) {
  const customerId = stripeSubscription.customer as string;
  const metadata = stripeSubscription.metadata;

  const userId = metadata?.userId;
  if (!userId) throw new Error(`Subscription ${stripeSubscription.id} has no userId metadata`);
  await setBillingCustomer(userId, customerId);

  // Match plan by metadata (set via subscription_data.metadata in checkout)
  const planId = metadata?.planId;
  const resolvedPlans = await getPlans({ planId });
  const plan = resolvedPlans[0];
  if (!plan) {
    throw new Error(`Plan not found for subscription ${stripeSubscription.id}, planId: ${planId}`);
  }

  const isAnnual = metadata?.billingPeriod === 'annual';
  const price = isAnnual ? plan.annualPrice : plan.monthlyPrice;

  // Stripe API 2025+: period fields are on subscription items
  const item = stripeSubscription.items.data[0];
  const periodStart = item?.current_period_start;
  const periodEnd = item?.current_period_end;

  await upsertSubscription({
    oxyUserId: userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSubscription.id,
    stripePriceId: stripeSubscription.items.data[0]?.price.id ?? '',
    status: stripeSubscription.status,
    currentPeriodStart: periodStart ? new Date(periodStart * 1000) : new Date(),
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
    planId: plan.planId,
    billingPeriod: isAnnual ? 'annual' : 'monthly',
    planSnapshot: {
      planId: plan.planId,
      name: plan.name,
      product: plan.product,
      creditsPerMonth: plan.creditsPerMonth,
      price,
      currency: plan.currency,
      billingPeriod: isAnnual ? 'annual' : 'monthly',
    },
  });
  invalidateEntitlementsCache(userId);
}

async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription) {
  const subscription = await updateSubscription(stripeSubscription.id, { status: 'canceled' });
  if (subscription) invalidateEntitlementsCache(subscription.oxyUserId);
}

function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subDetails = invoice.parent?.subscription_details;
  if (!subDetails?.subscription) return null;
  return typeof subDetails.subscription === 'string'
    ? subDetails.subscription
    : subDetails.subscription.id;
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  log.credits.info({ subscriptionId }, 'Invoice payment succeeded');
  const stripeSubscription = await getStripe().subscriptions.retrieve(subscriptionId);
  await handleSubscriptionUpdate(stripeSubscription);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  log.credits.error({ subscriptionId, invoiceId: invoice.id }, 'Invoice payment failed');
  const subscription = await updateSubscription(subscriptionId, { status: 'past_due' });
  if (subscription) invalidateEntitlementsCache(subscription.oxyUserId);
}

export default router;
