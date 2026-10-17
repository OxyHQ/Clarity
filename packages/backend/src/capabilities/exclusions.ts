/**
 * The Clarity routes that have NO catalogue tool, each with the reason. A route
 * added to a person-facing router either becomes a tool or is written down
 * here, so the boundary of what an agent can do is one file to review.
 * `catalog.test.ts` holds that no excluded route's action slipped into the
 * catalogue under another name.
 */
export const EXCLUDED_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  // Indexing, sites and operations are a PUBLISHER's machine surface, authorised
  // by an `oxy_sk` resource credential with its own scopes and quotas, owned by
  // an account that verified a domain — not something a person does by asking.
  'POST /v1/index/urls': 'publisher indexing (clarity:index credential)',
  'POST /v1/resolve': 'publisher indexing (clarity:index credential)',
  'GET /v1/sites': 'site management (clarity:sites:manage credential)',
  'POST /v1/sites': 'site management (clarity:sites:manage credential)',
  'POST /v1/sites/:id/crawls': 'site management (clarity:sites:manage credential)',
  'GET /v1/operations/:id': 'publisher indexing (clarity:index credential)',
  'POST /v1/operations/:id/cancel': 'publisher indexing (clarity:index credential)',
  'POST /v1/jobs/ingest': 'publisher boundary for a verified site (clarity:index credential)',
  'GET /v1/jobs/feeds': 'job feed administration (clarity:index credential)',
  'POST /v1/jobs/feeds': 'job feed administration (clarity:index credential)',
  'DELETE /v1/jobs/feeds/:id': 'job feed administration (clarity:index credential)',
  'GET /v1/usage': 'a credential’s metered usage, not a person’s',
  'GET /v1/quotas': 'a credential’s quota, not a person’s',
  // Device registration belongs to the device that holds the token.
  'POST /notifications/push-token': 'device push registration',
  'DELETE /notifications/push-token': 'device push registration',
  'POST /notifications/web-push-subscription': 'browser push registration',
  'DELETE /notifications/web-push-subscription': 'browser push registration',
  // Money moves through Stripe Checkout and the billing portal, in the person's
  // own browser; an agent never starts, changes or cancels a subscription.
  'POST /billing/checkout/subscription': 'payment: Stripe Checkout in the person’s browser',
  'POST /billing/subscription/cancel': 'subscription change: the person, in Clarity',
  'POST /billing/subscription/change-plan': 'subscription change: the person, in Clarity',
  'POST /billing/portal': 'payment: Stripe billing portal',
  // A bulk erasure of the public profile is the person's own settings action;
  // `deleteExperience` removes one entry at a time.
  'DELETE /api/experience': 'bulk erasure of the public profile',
  // The suggestion pool feeds the composer's autocomplete; it is the app's UI,
  // not a person's action.
  'POST /suggestions/create': 'composer suggestions (app UI)',
  'PATCH /suggestions/:id': 'composer suggestions (app UI)',
  'DELETE /suggestions/:id': 'composer suggestions (app UI)',
});
