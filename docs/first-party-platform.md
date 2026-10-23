# First-party platform authority

Oxy ADR 0049 supersedes Clarity's former exact backend scope tuple, own Files
scope grants and trust based on `tier: internal`. This record describes source
migration, not a deployed release.

Clarity keeps its exact backend application, project owner and workload handle
from `clarity-identity.ts`. The process uses the shared AWS temporary credential
provider and attestation; local role/SSO providers are supported without an ECS
variable gate. Readiness still requires an actual valid token. Retired customer
key environment variables remain rejected. No local service-key fallback exists.

## Receiver first

`resource-auth.ts` uses `OxyServer.introspectResourceToken` on every request. The
shared resource contract distinguishes workload services, external API keys and
human sessions. First-party services carry a verified recipient audience; own
shared sessions carry the original requester and effective account with no
invented application or credential. Keys and external OAuth sessions remain
scoped, even when an app registration is official. Key expiry/audience values
are not fabricated. All lanes preserve ownership, revocation and product rules.

During this explicitly temporary stage, a first-party service can arrive with
Clarity's canonical audience or `oxy-api`. Oxy alone may project an old v1 token
as first-party after signature validation and live verification of its exact
workload binding, application, owner and environment against the finite rollout
cohort. Clarity has no local cohort, brand bypass or token-payload fallback.
External service tokens retain their scoped `oxy-api` lane.

Clarity's manual outbound token calls remain v1 under the preparatory shared
SDK so upgrading the receiver does not change an unmigrated recipient's protocol.
They no longer request or validate scopes. The new `clarityForOxyService` SDK
factory always uses v2 and `oxy-service:01a0648b-8d73-70ad-8e67-1c07ddc5eb6e`.
After all inventoried callers migrate, remove the own `oxy-api` receiver branch
and v1 self-identity compatibility; retain external scoped OAuth/API-key behavior.
Do not deploy that removal ahead of the caller cutover.

## Queued work and accounting

Migration `0058_verified_crawl_authority` is additive and runs before the new
reader. New work persists `caller_authority` and `caller_kind` from the live
principal. Old jobs keep their IDs, account, application, credential, URLs,
status and historical `caller_tier`; that tier never proves authority. Their new
authority defaults to external and kind to legacy, so existing jobs can encounter
external crawl quotas until reconciled. No job is deleted or silently discarded.

Before rollout acceptance, inspect queued/running legacy rows and reconcile only
those whose original credential ID, application and owner match a currently
active workload binding in Oxy's authoritative registry and the reviewed rollout
cohort. Record the row IDs and readback evidence; ambiguous or revoked records
stay external. Never promote rows using application branding, `caller_tier`, or
just a `wl_` prefix. This controlled reconciliation is pending, not implied by the
schema migration; it must precede claims that the existing queue is unaffected.

A shared human session has no application ID. Only the accounting/idempotency
storage key uses the empty string for that absence (as credential attribution
already did); the authenticated principal remains null. The owner account stays
in every key. Request-rate buckets for these sessions use the account dimension,
never a shared empty application bucket. Audit events record `caller_kind` so a
human session cannot appear as an authenticated application. External app IDs are
nonempty in the shared contract.

## Transport and acceptance

Use `clarityForOxyService(oxyServer)` from `@clarity.surf/sdk/server` for own
backend calls and `clarityForOxySession(oxyServices)` for frontend calls. They use
shared origin-bound fetch, refresh and disposal; do not copy bearer tokens or
implement retries around them. External clients keep `new ClarityClient({ apiKey })`.

Acceptance includes SDK → real HTTP → live authority contract → PostgreSQL route
checks: own and external identities, original versus effective account, wrong
account, wrong audience, revocation, session switching, and separate account
idempotency. Exact candidate versions, test results and cutover evidence are
recorded with each delivery commit. No production mutation, SDK publication or
Clarity deployment has occurred in this workstream.

## Source validation, 2026-10-23

The SDK factory foundation is commit `a6deb86`. The receiver was checked with
local candidates `@oxy.so/core` 6.15.1 and `@oxy.so/contracts` 5.7.0 from Oxy's
reader preparation worktree; these filenames identify test artifacts, not a
published compatibility claim. The delivery coordinator must pin their published
replacements before CI/release acceptance. No local tarball references are kept
in manifests or the lockfile.

Validation: 78 backend Vitest suites (655 passed, four skipped), 51 Bun runtime
files (455 passed), 211 SDK tests, backend and SDK builds, backend TypeScript,
Biome (existing warnings only), migration lock analysis, and built backend
entrypoint failure/success checks against the disposable `clarity_ci` database.
Migration 0058 was applied only to that disposable database. The live HTTP suite
includes a same-key cross-account operation test and rejects redirects for both
own and external transports before any credential reaches the other origin.

Catalogue registration, audit and external MCP introspection now use the shared
MCP helpers with an Oxy service transport, which emits v2. The external
connection remains scoped; its receiver process proves its own workload.

Still pending: published dependency pins, authoritative legacy queue reconciliation,
deployment and live canaries,
caller cutover, then removal of the finite v1 bridge. Existing product plan and
account membership rules remain in force throughout these steps.
