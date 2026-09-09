# API reference

The source of truth is the mounted routers in `packages/backend/src/index.ts`.
Examples below require an Oxy user session unless marked public.
Except for health, every route remains `503` until the PostgreSQL snapshot and
exact Clarity Alia agent identity have been attested.

## Public and health

- `GET /`
- `GET /health`, `GET /health/live`, `GET /health/ready`
- `GET /v1/models`, `GET /v1/models/:modelId`
- `GET /models/stats`, `GET /models/stats/:modelId`
- `GET /notifications/vapid-public-key`

## Chat

- `POST /v1/chat/completions`
- `POST /clarity/search`

Both call the same fixed Clarity agent in Alia. Clarity authenticates the human
at its edge, then calls Alia with the dedicated Clarity backend service token
and `X-Oxy-User-Id`. The browser bearer is never forwarded. Client-provided
agent IDs, modes, skills, MCP servers, fallback/reasoning controls and
system/tool roles are rejected.

## Search platform and Jobs

Credentialed `/v1` routes (an `oxy_sk` resource credential, not a user session):

- `POST /v1/search`, `GET /v1/news`, `GET /v1/documents/:id`, `GET /v1/documents/by-url`
- `POST /v1/index/urls`, `POST /v1/resolve`, `/v1/sites…`, `GET /v1/usage`, `GET /v1/quotas`
- `GET /v1/operations/:id`, `POST /v1/operations/:id/cancel` — asynchronous
  crawl/index work. This namespace used to be `/v1/jobs`; `jobs` now means
  employment everywhere, and `ResolveResult.jobId` is `operationId`.
- `POST /v1/jobs/search`, `GET /v1/jobs/:id`, `GET /v1/jobs/by-url`,
  `POST /v1/jobs/:id/report`, `GET /v1/jobs/stats`, `GET /v1/jobs/capability` —
  employment search (`clarity:search`).
- `POST /v1/jobs/ingest` — the publisher boundary (`clarity:index`). A
  structured `JobPosting` payload requires a verified site for the URL's host.
- `GET/POST /v1/jobs/feeds`, `DELETE /v1/jobs/feeds/:id` (`clarity:index`) —
  the keyless public boards and RSS feeds Clarity polls for listings. Sources
  are rows, not a hardcoded list, and none holds a credential.

## Market data

Credentialed `/v1` routes under their own scope, `clarity:market`:

- `GET /v1/market/quote/:asset?currency=usd` — one cryptocurrency quote with
  every chart range in the answer. `source` says which upstream produced the
  number and `updatedAt` when it produced it; both are part of the contract, not
  decoration.
- `GET /v1/market/capability` — what the surface can and cannot answer.

The scope is deliberately not `clarity:search`: quotes are neither indexed by
Clarity nor billable as searches, and neither consumer — Clarity's Finance page
or Alia's tool layer — should need a corpus-search credential to read a price.

Crypto comes from CoinGecko and FairCoin from the FairCoin explorer, both public
and keyless, so no provider credential is held here. **Equities are not served.**
Stocks, indices, ETFs and sector aggregates need a licensed equity feed; asking
for one returns `asset_not_found` rather than the nearest-named coin. Quotes are
cached in Redis for a minute, so a page read by many people costs one upstream
call.

The unauthenticated portal surface behind `clarity.surf/jobs` mirrors the read
routes at `POST /jobs/search`, `GET /jobs/:id`, `GET /jobs/by-url`,
`POST /jobs/:id/report`, `GET /jobs/stats` and `GET /jobs/capability`. It
carries no user identity by
design, so searching or viewing a listing never discloses a named user to an
employer. See [Clarity Jobs](jobs) for the ranking contract, lifecycle policy
and deduplication rules.

## Product persistence

- conversations: list, get, create/save, vote and delete under `/conversations`
- suggestions: list, welcome, create, update, delete, search and usage under `/suggestions`
- notifications and push registrations under `/notifications`
- feedback under `/feedback`
- product plans, subscriptions, portal, webhook and entitlements under `/billing`

These resources use Clarity PostgreSQL.

## Alia-owned accounting

- `/credits` and `/credits/usage`
- `/analytics/usage`, `/analytics/models`, `/analytics/credits`
- credit-package/custom-credit checkout and `/billing/transactions`

These routes delegate the authenticated user with Clarity's backend service
identity. Clarity does not maintain a
second inference balance or telemetry ledger.

## Alia-owned product runtime

- memory profile, search, import/export and settings under `/memory`
- agent audit summary, threats and export under `/audit`
- authenticated trigger CRUD, executions and manual runs under `/triggers`
- public token check and authenticated account link for the allowlisted
  Telegram/Discord channel bots under `/bots`

These are explicit, path-by-path proxies and require an Oxy user session. Alia
returns its own webhook URL so token, HMAC and source-IP validation happens at
the owning edge without losing request metadata in an intermediary. Clarity does not
store a second memory, audit or automation ledger, and exposes no catch-all
channel-webhook endpoint. Stripe product billing remains on its dedicated
`/billing/webhook` route.

## Compatibility removals

`POST /v1/resolve-model` and `POST /v1/report-usage` return `410`. Routing and
usage reporting are internal to Alia/Oxy/Kaana. Old Clarity-local developer
keys are not accepted; machine/service agent calls remain fail closed until the
Oxy/Alia delegation contract is provisioned.
