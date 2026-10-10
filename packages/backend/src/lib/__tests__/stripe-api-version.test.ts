import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION, stripeApiVersion } from '../stripe-api-version.js';

describe('Stripe API version pin', () => {
  it('pins the version Clarity was built against, not the SDK default', () => {
    // A bump changes the shape of every Stripe object billing reads. It has to
    // be a deliberate, reviewed change, never a side effect of an SDK upgrade.
    expect(STRIPE_API_VERSION).toBe('2026-06-24.dahlia');
    expect(stripeApiVersion).toBe(STRIPE_API_VERSION);
  });

  it('is the version a client built with it sends to Stripe', () => {
    const stripe = new Stripe('sk_test_not_a_real_key', { apiVersion: stripeApiVersion });
    expect(stripe.getApiField('version')).toBe('2026-06-24.dahlia');
  });
});
