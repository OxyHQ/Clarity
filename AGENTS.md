# Clarity

Clarity is an Expo search product plus an Express product API; its assistant is an ordinary Alia agent.

## Commands

```bash
bun install --frozen-lockfile
bun run lint                                 # Biome check; CI runs bunx biome ci .
bun run lint:fix                             # safe fixes + formatting
bun run --filter @clarity/backend test       # vitest
bun run --filter @clarity/backend test:bun   # unit suite under Bun, the production runtime
bun run build:backend
bun run doctor:oxy && bun run i18n:check     # Oxy dependency and i18n gates
TEST_DATABASE_URL=postgresql://.../clarity_ci bun run check:backend-entrypoints
```

Migrations need an explicit database and phase; run `--dry-run` first:

```bash
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:migrate -- \
  --target-database=clarity_ci --phase=pre --dry-run
```

## Map

- `docs/index.mdx`: architecture and ownership; `docs/assistant.mdx`: Alia agent, capability catalogue, plan gates.
- `docs/jobs.mdx`, `docs/products.mdx`, `docs/product-feeds.mdx`, `docs/oxy-files.md`: verticals and file ownership.
- `docs/postgres-alia-migration.md`: rehearsal, reconciliation, cutover commands.
- `docs/agent-rules/product-boundaries.md`: the full ownership and datastore rules.
- `packages/backend/src/db/schema/index.ts`: schema; `packages/backend/src/capabilities/clarity.catalog.ts`: capability catalogue.

## Conventions

- PostgreSQL/Drizzle is the only datastore: no other driver, fallback, dual write or compatibility reader.
- The backend never calls Alia; Alia reaches Clarity only through the capability catalogue, and a tool's account comes from the verified ticket or OAuth connection, never input. Bump the catalogue `version` on any tool change.
- Canonical IDs come from `packages/backend/src/lib/clarity-identity.ts`, matched byte for byte, never discovered by name or list.
- First-party never asks people for permissions: this app acts for a person with `actingFor` on what oxy's first-party registry declares (oxy ADR 0066); permissions, scopes and consent are only for third parties.
- Jobs index public postings only: no applicant, CV or candidate data, and no commercial signal in ranking (`ranking-contract.test.ts` enforces it; extend it, do not bypass it).
- Search embeddings are the only direct Kaana call (`src/lib/kaana-embeddings.ts`, `https://kaana.ai/v1`); no provider credentials, adapters or routing tables here.
- `jobs` means employment; async crawl or index work is an operation (`/v1/operations/:id`).

Why and the remaining rules: `docs/agent-rules/product-boundaries.md`.

## Boundaries

Never:
- Re-add a Clarity conversation table, stream or backend chat route; Alia owns conversations and the person's credits pay for inference.
- Add a confirmation step to a capability tool; no agent asks for approval.
- Run migrations or integration tests against a database other than a disposable `clarity_ci`.
- Publish to npm from a laptop; merging a version bump publishes it ([npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)).

Ask first: changing an Oxy/Alia/Kaana ownership boundary (see `docs/first-party-platform.md`).

## Testing

Run lint, the backend `test` and `test:bun` suites for backend changes; `architecture-gates.test.ts` is the forbidden-dependency gate. Done means lint and tests green and CI passing. Gate-writing guidance: [gate-writing](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/gate-writing.md).

## PRs and commits

Branch off `main`, open a PR, let CI pass, merge with `gh pr merge <n> --squash`. Format with Biome ([lint and format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md)).

## Secrets

Service tokens and database URLs come from the environment or deploy config; never print or commit them.

## Links

[Oxy engineering standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md), [org standards](https://github.com/OxyHQ/engineering/blob/main/AGENTS.md).

Owner: Clarity maintainers. Last reviewed: 2026-11-11.
