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
