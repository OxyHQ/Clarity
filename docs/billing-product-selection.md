# Selecting a product subscription

`POST /billing/subscription/change-plan` resolves the existing exact `planId`
first, then selects the authenticated account's active or trialing subscription
whose recorded product matches that target plan. Multiple candidates for that
product return `409`. A missing or different-product current catalogue plan
fails before price creation, subscription retrieval or update. Existing upgrade,
billing-period and proration behavior is unchanged.

`POST /billing/subscription/cancel` accepts an optional JSON body:

```json
{ "subscriptionId": "the opaque id returned by GET /billing/subscription" }
```

Ownership is part of the database query, before any subscription details or
Stripe operations. Unknown, foreign and terminal IDs produce the same `404`.
Malformed selectors produce `400`. With no selector (including an absent body),
legacy callers are supported only when the account has one nonterminal
subscription. Multiple candidates return `409` instead of choosing by creation
time. The settings screen submits the ID of the subscription it displays.
Successful mutations invalidate all product-specific subscription query keys.

For the stored states `active`, `trialing`, `past_due` and `unpaid`, cancellation
still schedules `cancel_at_period_end: true`; it does not cancel immediately,
change the stored status, refund, or alter proration. `incomplete` participates
in ambiguity detection but returns `409` when selected: Stripe limits updates
in that state to metadata and default source. `canceled` and
`incomplete_expired` are terminal and excluded. `paused` is not a state supported
by the current Clarity database constraint. These distinctions follow the
[Stripe subscription object](https://docs.stripe.com/api/subscriptions/object)
and preserve the existing period-end operation rather than adding a new billing
operation.

This fixes selection within Clarity's existing catalogue. It does not adopt the
new Oxy product-access catalogue or grants, change SDK dependencies, or prove a
real provider cancellation. The public Clarity SDK has no billing namespace;
the relevant client contract is the frontend `useCancelSubscription` hook.
