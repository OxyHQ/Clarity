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

The receiver-only checkpoint is `fc6f60c` (rebased onto SDK 0.10.0). Its legacy
outbound producers remain unchanged for a reader-first rollout. The subsequent
producer source uses protocol 2 exclusively: Kaana's shared SDK factory,
Mercaria's public catalogue factory, the shared Oxy transport for domain checks,
the shared signed account-events feed, and the temporary workload activity
publisher. No producer requests or validates OAuth scopes. Exact Clarity project,
application and workload identity checks remain where the account-event and
catalogue clients previously required them; they inspect the shared v2 mint and
never manually forward its bearer.

Deploy the compatible Oxy API and Clarity reader first. Reconcile held legacy
lineage using reviewed live provenance. Then deploy Mercaria's canonical
receiver before enabling the new Clarity catalogue caller. Public catalogue
reads retain their anonymous fallback when workload minting is unavailable;
a receiver's denial is not retried anonymously. The embedding queue still owns
its retry schedule (`maxRetries: 0`), preserving its existing cost/backoff rules.

After all inventoried producers and queued work migrate, remove the own `oxy-api`
receiver branch and the finite central v1 cohort. Inventory scheduled and one-shot
launch definitions as well as running ECS services: an old image can still start
later. Retain external scoped OAuth/API-key behavior. Do not deploy removal ahead
of caller cutover. SDK publication alone changes no running producer.

## Queued work and accounting

Migration `0058_verified_crawl_authority` is additive and runs before the new
reader. New work persists `caller_authority` and `caller_kind` from the live
principal. Old jobs keep their IDs, account, application, credential, URLs,
status and historical `caller_tier`; that tier never proves authority. Their new
authority defaults to external and kind to legacy; these rows remain held until
reviewed reconciliation, without charging an external quota. No job is deleted
or silently discarded.

The new worker temporarily holds unclassified lineage (`caller_kind = legacy` or
an unknown authority/kind combination): it neither claims queued pages, recovers
expired held leases, charges usage nor creates recrawls from that lineage.
Existing row IDs, statuses, cursors, attempts, leases and due times remain intact.
Classified jobs continue normally. Recrawl grouping includes authority/kind, so
matching owner/application/credential tuples cannot merge different provenance.

Before rollout, inventory ALL historical lineage as well as active jobs. Reconcile
own rows only after the original credential, application and owner match the live
active workload binding, reviewed finite cohort and production environment. Mark
those rows `first_party` / `service`. A reviewed live external lineage whose raw-key
versus signed-service origin cannot be recovered may use `external` /
`reconciled_legacy_external`; this retains normal external quotas and that explicit
audit marker instead of fabricating credential kind. Revoked, ambiguous or owner-
mismatched credentials remain unclassified and held. A `wl_` prefix, application
branding or historical `caller_tier` is never evidence.

Operational order: apply additive 0058; reconcile reviewed tuples in bounded
batches with row-count/readback evidence; roll the readers/workers; stop every old
writer; run a catch-up pass for legacy rows admitted during the roll; verify zero
unresolved **eligible** queued lineage before declaring the queue migrated.
Held revoked/unknown work must be reported separately, never silently released or
deleted. Completed lineage must also be classified because later recrawls inherit
it. Only a subsequent reviewed source change removes this temporary hold after
old writers and legacy lineage are accounted for. No reconciliation or production
write is performed by this source commit.

The root's 2026-10-23 read-only census found 41,933 active Mention-workload jobs
and 37 queued jobs under a revoked customer credential. The latter stay held;
they must never be resumed merely by assigning an external marker. Fresh registry
and owner-tuple evidence is kept in organization scratch
`first-party-root/clarity-authority/registry-log.json`; re-read it before cutover.

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

The temporary hold passed 27 PostgreSQL worker/quota tests, including unchanged
legacy leases/attempts/usage, classified external quotas, own queue progress and
completed-lineage recrawl catch-up. Backend/frontend typechecks and backend
build passed. Both frontend linked-client hooks now dispose their subscriptions.

Producer source checkpoint: 42 targeted producer/identity tests, 34 existing
architecture/queue/ranking tests and 11 composed HTTP/PG authority tests pass.
Backend source/test typecheck passes with candidate core7, Kaana factory and
Mercaria0.7. All59 migrations apply to a fresh disposable database. Production
build and registry-pinned rerun remain pending; candidate overrides were removed
before preserving this checkpoint.
