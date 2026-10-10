import type Stripe from 'stripe';

/**
 * The Stripe API version Clarity sends on every request (the `Stripe-Version`
 * header). It decides the shape of every object Stripe returns, so changing it
 * changes billing behaviour: bump it only as its own change, after reading
 * Stripe's changelog for every version in between.
 */
export const STRIPE_API_VERSION = '2026-06-24.dahlia';

/**
 * stripe-node types `apiVersion` as its own latest version only
 * (`Stripe.LatestApiVersion`, which a minor SDK release moves: stripe 22.6
 * made it 2026-08-26.dahlia). Stripe's documented way to keep an older pinned
 * version is to override that type, and this is the one place that does it.
 * The widening to `string` is what lets one version literal be asserted as
 * another; the value is still `STRIPE_API_VERSION`.
 */
export const stripeApiVersion = STRIPE_API_VERSION as string as Stripe.LatestApiVersion;
