<h1 align="center">Clarity</h1>

<p align="center">Oxy's search engine — the web, jobs, news and markets — with its assistant in Alia.</p>

## Architecture

```text
Clarity client (Expo)
  -> Clarity API: search, Jobs, places, market, news, Experience,
     notifications, feedback, plans (PostgreSQL)
  -> Alia, through @alia.onl/sdk, under the person's own Oxy session:
     the Clarity agent's conversation, paid by the person's Alia credits
       -> Clarity's capability catalogue (/_oxy/mcp), under the person's ticket
```

Clarity's assistant is an ordinary public Alia agent owned by Clarity's project
account and confined to Clarity by Oxy. The backend never calls Alia; Alia
reaches Clarity through its capability catalogue. Clarity has no
inference-provider adapters, keys or route selection: its one inference call is
search embeddings on `https://kaana.ai/v1`, never a hostname under `oxy.so`.

## Packages

| Package | Purpose |
| --- | --- |
| `@clarity/frontend` | Expo app for web, iOS and Android |
| `@clarity/backend` | Express product API and capability catalogue (MCP) |
| `@clarity/shared-types` | Jobs, market and news DTOs |
| `@clarity.surf/sdk` | Public SDK for Search, Jobs, Indexing and News |

## Local development

```bash
bun install
cp packages/backend/.env.example packages/backend/.env
bun run dev:backend
bun run dev:frontend
```

The API requires `DATABASE_URL`. It authenticates to Oxy as its attested ECS task role
(`oxy-clarity-task`, oxy ADR 0026) and holds no Oxy key pair — the former
backend credential is retired — so a local checkout cannot reach Oxy as
Clarity. Redis, Stripe and browser-push settings are optional.

```bash
bun run lint            # Biome (lint + format check), whole repo — CI runs `bunx biome ci .`
bun run --filter @clarity/backend test
bun run build:backend
```

The default branch is `main`. Migration and cutover instructions are in
[`docs/postgres-alia-migration.md`](docs/postgres-alia-migration.md); the branch
does not claim any production cutover or deployment.

## Documentation

- [`docs/index.mdx`](docs/index.mdx) — ownership and current architecture
- [`docs/api-reference.md`](docs/api-reference.md) — mounted API surface
- [`docs/assistant.mdx`](docs/assistant.mdx) — the assistant, its catalogue and plan gates
- [`docs/jobs.mdx`](docs/jobs.mdx) — the Clarity Jobs employment vertical
- [`docs/deployment.md`](docs/deployment.md) — fail-closed deployment gates
- [`docs/onboarding.md`](docs/onboarding.md) — developer setup
