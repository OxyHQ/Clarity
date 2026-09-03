<h1 align="center">Clarity</h1>

<p align="center">Oxy's cited-answer and deep-research product, powered by a named Alia agent.</p>

## Architecture

```text
Clarity client
  -> Clarity API (Oxy auth, product IDs, PostgreSQL product state)
  -> Clarity bot/agent in Alia (conversation runtime, tools, search, citations)
  -> Oxy inference edge (identity, billing, exact route authorization/order)
  -> Kaana (provider execution and failover within Oxy's signed order)
```

Clarity has no inference-provider adapters, keys, route selection or local inference
billing. Its backend is PostgreSQL/Drizzle only. Product plans and entitlements
remain Clarity data; inference credits and telemetry come from Alia. Kaana is
the sole hosted inference data plane and its only canonical signed origin is
`https://kaana.ai`, never a hostname under `oxy.so`.

## Packages

| Package | Purpose |
| --- | --- |
| `@clarity/frontend` | Expo app for web, iOS and Android |
| `@clarity/backend` | Express product API and Alia agent proxy |
| `@clarity/shared-types` | Conversation, model and streaming DTOs |

## Local development

```bash
bun install
cp packages/backend/.env.example packages/backend/.env
bun run dev:backend
bun run dev:frontend
```

The API requires `DATABASE_URL`, the byte-exact canonical
`CLARITY_ALIA_AGENT_ID`, and Clarity's dedicated Oxy backend credential. The
credential secret is a provider-managed DigitalOcean App Platform secret; it
is never stored in the repository, a user bearer or an inference-provider key.
Redis, Stripe and browser-push settings are optional.

```bash
bun run --filter @clarity/backend lint
bun run --filter @clarity/backend test
bun run build:backend
```

The default branch is `master`. Migration and cutover instructions are in
[`docs/postgres-alia-migration.md`](docs/postgres-alia-migration.md); the branch
does not claim any production cutover or deployment.

## Documentation

- [`docs/index.mdx`](docs/index.mdx) — ownership and current architecture
- [`docs/api-reference.md`](docs/api-reference.md) — mounted API surface
- [`docs/chat-api.mdx`](docs/chat-api.mdx) — chat and SSE translation
- [`docs/model-abstraction.mdx`](docs/model-abstraction.mdx) — exact product IDs
- [`docs/deployment.md`](docs/deployment.md) — fail-closed deployment gates
- [`docs/onboarding.md`](docs/onboarding.md) — developer setup
