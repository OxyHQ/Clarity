# API reference

The source of truth is the mounted routers in `packages/backend/src/index.ts`.
Examples below require an Oxy user session unless marked public.
Except for health, the account-event webhook and the two MCP lanes, every route
remains `503` until the PostgreSQL snapshot has been attested and the process can
attest its Oxy service identity.

## SDK favicon resolution

`@clarity.surf/sdk` exports two browser-independent helpers:

- `resolveFaviconUrl(pageUrlOrHostname, size?)` builds the canonical favicon
  service URL for a page.
- `resolveFaviconForImageUrl(resourceUrl, size?)` returns that URL only when an
  already-discovered image is the conventional root `/favicon.ico`; otherwise
  it returns `null`.

Both helpers discard credentials, paths, queries and fragments before building
the provider request. Only the normalized hostname is sent. Consumers handling
private documents, such as email clients, should pass only the individual image
resource URL to `resolveFaviconForImageUrl`; no message, sender or recipient data
is needed.

## Public and health

- `GET /`
- `GET /health`, `GET /health/live`, `GET /health/ready`
- `GET /notifications/vapid-public-key`

## Capability catalogue (MCP)

- `POST /_oxy/mcp` on `api.clarity.surf` — Alia, with an Oxy capability ticket
  (`Authorization: Capability <ticket>`), verified live and audited.
- `/mcp` and `/.well-known/oauth-protected-resource` on `mcp.clarity.surf` — any
  OAuth MCP client, with Oxy as the authorization server.

The tools, their account rule and the plan-feature gates are in
[Clarity's assistant](assistant). There is no chat endpoint: the conversation is
the person's, in Alia.

## Search platform and Jobs

Credentialed `/v1` routes (an `oxy_sk` resource credential, not a user session):

- **Internal and external callers.** Oxy's introspection says whether the caller
  is one of Oxy's own applications (`tier: internal`) or not (`external`). An
  internal caller passes every `clarity:*` scope check and has no quota — only
  the technical ceilings (`INTERNAL_QUOTAS`: requests per minute, concurrent
  fetches, pages per crawl); a crawl it queues remembers that (`caller_tier`), so
  the worker charges it the same way. Scopes and the sandbox quotas plus staff
  grants are the external lane. What a person may do — their plan, their
  credits — is the calling product's to enforce, not Clarity's.

- `POST /v1/search`, `GET /v1/news`, `GET /v1/documents/:id`, `GET /v1/documents/by-url`
  — when the index cannot fill a search's first page (and no type or date
  filter is set), the rest comes from the public web through the SearXNG
  sidecar (`packages/searxng`, `CLARITY_SEARXNG_URL`). Those pages are
  recorded as `discovered` documents, ranked below every indexed match, and
  `POST /v1/resolve` crawls a `discovered` URL like an unknown one.
- `POST /v1/resolve` (`clarity:index`) — the page when Clarity has fetched it
  (found by its canonical, requested or final URL); otherwise it queues the
  crawl and, with `waitMs` (≤ 10 000), waits for that crawl and answers as soon
  as it ends. A URL the ended crawl could not fetch is `failed`; one still
  crawling is `queued` with its `operationId` (202). Repeated and overlapping
  requests reuse pending work within the same account and application and
  prioritize those queued/retry pages ahead of historical bulk work, without
  changing their retry schedule. A mixed
  response retains fetched documents even when active-crawl capacity is full:
  unqueued URLs return `throttled` with
  `error: { code: 'active_crawl_quota_exceeded', retryable: true }` and no
  `operationId`. Retry those URLs when capacity frees; this differs from a
  terminal fetch `failed`. An entirely unqueued, unavailable batch still returns
  HTTP 429. Explicit idempotency keys bind the missing subset actually enqueued;
  `/v1/index/urls` retains its exact operation-key semantics.
- `POST /v1/index/urls`, `POST /v1/resolve`, `/v1/sites…`, `GET /v1/usage`, `GET /v1/quotas`
- `GET /favicons/:host` — public, no credential (an `<img>` sends none): the
  site's favicon, one per host, fetched by the worker and served by Clarity
  with a week's cache. Hosts are registered as their pages are crawled or
  discovered; an unknown host is registered on request and answers 404 until
  fetched. Documents and search results carry `faviconUrl` pointing here once
  the icon is stored; the SDK's `resolveFaviconUrl(host)` builds the same URL.
- `GET /v1/operations/:id`, `POST /v1/operations/:id/cancel` — asynchronous
  crawl/index work. This namespace used to be `/v1/jobs`; `jobs` now means
  employment everywhere, and `ResolveResult.jobId` is `operationId`.
- `POST /v1/jobs/search`, `GET /v1/jobs/:id`, `GET /v1/jobs/by-url`,
  `POST /v1/jobs/:id/report`, `GET /v1/jobs/stats` — employment search
  (`clarity:search`).
- `POST /v1/jobs/ingest` — the publisher boundary (`clarity:index`). A
  structured `JobPosting` payload requires a verified site for the URL's host.
- `GET/POST /v1/jobs/feeds`, `DELETE /v1/jobs/feeds/:id` (`clarity:index`) —
  the keyless public boards, aggregators and RSS feeds Clarity polls for
  listings (kinds and identifiers in `docs/jobs.mdx`). Sources are rows, not a
  hardcoded list, none holds a credential, and robots.txt is honoured.

## Market data

Credentialed `/v1` routes under their own scope, `clarity:market`:

- `GET /v1/market/quote/:asset?currency=usd` — one cryptocurrency quote with
  every chart range in the answer. `source` says which upstream produced the
  number and `updatedAt` when it produced it; both are part of the contract, not
  decoration.
- `GET /v1/market/capability` — what the surface can and cannot answer.

The scope is deliberately not `clarity:search`: quotes are neither indexed by
Clarity nor billable as searches, and no consumer should need a corpus-search
credential to read a price. A person's agent reads quotes through the
catalogue's `getMarketQuotes`.

Crypto comes from CoinGecko and FairCoin from the FairCoin explorer, both public
and keyless, so no provider credential is held here. **Equities are not served.**
Stocks, indices, ETFs and sector aggregates need a licensed equity feed; asking
for one returns `asset_not_found` rather than the nearest-named coin. Quotes are
cached in Redis for a minute, so a page read by many people costs one upstream
call.

The Finance page reads the same module through a PUBLIC door, because a quote is
public information in the same way a job posting is and a browser holding a user
session has no resource credential to present:

- `GET /market/quotes?assets=bitcoin,faircoin&currency=usd` — up to eight assets
  in one request, each with its own outcome. One upstream being down for FairCoin
  returns FairCoin's error beside Bitcoin's price rather than failing the batch.
- `GET /market/capability` — the same statement of what is and is not served.

Both carry no credential and no user identity; burst protection is keyed by
address in its own bucket, so reading Finance never rate-limits Jobs. The public
door answers SUMMARIES — a price with its provenance and no chart history — since
a card draws no chart and a coin's full daily series is thousands of points. The
two are separate types (`MarketQuoteSummary`, `MarketQuote`) so that a door which
does not serve history can never be mistaken for an asset that has none.

Discover reads news the same way: `GET /news?limit=30` is the public door onto
the module behind `GET /v1/news`, with no credential, no user identity and its
own per-address bucket. Both return clustered stories when there are any; until
a clustering pass fills `clarity_news_stories`, every indexed page recognised as
a `NewsArticle` is served as a story of one, in the same shape.
A story whose article states no publication date has `null` dates, never the
crawl time. `languages=es,en` (or `language=es`) filters by primary subtag; the
public door falls back to every language when those have no news.

The unauthenticated portal surface behind `clarity.surf/jobs` mirrors the read
routes at `POST /jobs/search`, `GET /jobs/:id`, `GET /jobs/by-url`,
`POST /jobs/:id/report` and `GET /jobs/stats`. It
carries no user identity by
design, so searching or viewing a listing never discloses a named user to an
employer. See [Clarity Jobs](jobs) for the ranking contract, lifecycle policy
and deduplication rules.

## Product persistence

- suggestions: list, welcome, create, update, delete, search and usage under
  `/suggestions`; list, welcome, create and search read the language from the
  body's `language` (`xx-YY`, default `en-US`)
- notifications and push registrations under `/notifications`
- feedback under `/feedback`
- product plans, subscriptions, portal, webhook and entitlements under
  `/billing`; `/billing/entitlements` answers `{ features, planId }`
- `GET /v1/me` — the signed-in person (`id`, `email`, `name`)

These resources use Clarity PostgreSQL. Credits, credit checkout and
transactions, usage analytics, memory, the agent audit, triggers and channel
bots are Alia's and are used in Alia; Clarity has no route for any of them.
