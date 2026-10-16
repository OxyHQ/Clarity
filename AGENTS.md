# Clarity

> Universal standards live in `~/AGENTS.md`, Oxy-wide gotchas in `~/Oxy/AGENTS.md`. Documentation belongs in `docs/`, history in git, status in issues. This file holds only RULES, commands and pointers. **Budget: under 8 KB.**

Clarity is an Expo product plus an Express product API. Its assistant is an
ordinary Alia agent (Alia ADR 0020): `docs/assistant.mdx`.

## Hard boundaries

- PostgreSQL/Drizzle is the only Clarity datastore. Do not add another database
  driver, fallback, connection string, compatibility reader, or dual write.
- Clarity owns its product: search and indexing, Jobs, places, market, news,
  Experience, suggestions, notifications, feedback, the plan catalogue,
  subscriptions and entitlements.
- Alia owns the assistant: the Clarity agent (prompt, character, families,
  ceiling, feature gates), its conversations, memory, deep research, credits
  and checkout, usage, audit, triggers and channel bots. **The backend never
  calls Alia** — no proxy, no relay of a person as a header, no agent id, no
  product-paid chat. Never re-add a Clarity conversation table or a Clarity
  chat UI; the frontend draws every conversation with `@alia.onl/sdk`
  (`AliaChatContent agent={CLARITY_AGENT}`), under the person's own session.
- Alia reaches Clarity only through the capability catalogue
  (`packages/backend/src/capabilities/`): one tool per person action, calling
  the same use case as its route. The account a tool acts as comes ONLY from
  the verified ticket (`effectiveAccountId`) or OAuth connection
  (`activeAccountId`); input never names an account. Both MCP lanes mount
  before CORS, body parsers and readiness. Bump the catalogue `version` with
  any tool change. What has no tool is written in `capabilities/exclusions.ts`.
- Plans unlock Alia features through feature gates: catalogue `features` answered
  from plan features (`deep-research`, `power-level-<level>`). The person's Alia
  credits pay for inference; Clarity never does.
- No agent asks for approval; never add a confirmation step to a tool.
- Oxy authorizes and orders exact inference routes. Kaana owns adapters,
  provider credentials and execution/failover within that signed order. No
  provider credential, adapter, routing table or direct provider endpoint
  belongs here.
- The canonical IDs live in `packages/backend/src/lib/clarity-identity.ts`.
  Match them byte for byte; do not trim, normalize, discover by name/list/order,
  or accept client rebinding. The backend token must identify the exact backend
  app, workload handle, project owner and the exact scope set listed there.
- Clarity Jobs indexes PUBLIC job postings. No applicant tracking, CV store,
  candidate profile or application data in Jobs, and no route that could disclose a
  named user to an employer — Jobs catalogue tools never receive the effective
  account. Never present Clarity as the employer or source of a listing it only
  indexed.
- Clarity Experience owns user-published personal work history, edited through
  the user session from Clarity or Mention. Keep its storage and APIs separate
  from Jobs, search, ranking and employer-facing candidate discovery.
- No commercial signal — payment, subscription tier, ad spend, licensing tier,
  Mercaria or Mention engagement — may reach job ranking, in any weighting.
  `src/search/jobs/__tests__/ranking-contract.test.ts` enforces this
  structurally; extend it rather than working around it.
- `jobs` means employment. Asynchronous crawl/index work is an *operation*
  (`clarity.operations`, `/v1/operations/:id`).

Search embeddings are the one direct Kaana call: `@kaana.ai/sdk` to
`https://kaana.ai/v1` with the `kaana.ai` service token, only when
`CLARITY_EMBEDDINGS_ENABLED=true` (`src/lib/kaana-embeddings.ts`). Never a
hand-built Kaana URL, `/internal/`, or an `oxy.so` inference route.

Platform credentials such as Stripe, VAPID, Valkey and Oxy identity are not
inference-provider credentials. Keep that distinction in architecture gates.

## Commands

npm releases: only Actions → Release packages (`release-packages.yml`, Oxy's shared
workflow, OIDC); a package's gates are its `prepublishOnly`. Never publish from a laptop —
`~/Oxy/docs/npm-releases.md`.

```bash
bun install --frozen-lockfile
bun run lint            # Biome: lint + format check (CI: bunx biome ci .)
bun run lint:fix        # apply Biome safe fixes + formatting; `bun run format` formats only
bun run --filter @clarity/backend test
bun run --filter @clarity/backend test:bun   # unit suite under Bun, the production runtime
bun run build:backend
TEST_DATABASE_URL=postgresql://.../clarity_ci bun run check:backend-entrypoints
```

Database commands require an explicit database and phase:

```bash
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:migrate -- \
  --target-database=clarity_ci --phase=pre --dry-run
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:migrate -- \
  --target-database=clarity_ci --phase=pre
```

Use only a disposable database named `clarity_ci` for repository integration
tests. See `docs/postgres-alia-migration.md` for backfill and cutover commands.

## Pointers

- `docs/index.mdx` — current architecture and ownership.
- `docs/assistant.mdx` — the Alia agent, the capability catalogue, plan gates.
- `docs/jobs.mdx` — Jobs vertical: extraction, projection, lifecycle, dedupe,
  ranking contract, ingestion boundary and portal.
- `docs/postgres-alia-migration.md` — rehearsal, reconciliation and cutover.
- `docs/oxy-files.md` — images are Clarity-owned Oxy files (ADR 0041); only
  `src/files/oxy-files.ts` calls Oxy Files, and its scopes are never agent scopes.
- `packages/backend/src/db/schema/index.ts` — product schema.
- `packages/backend/src/capabilities/clarity.catalog.ts` — the capability catalogue.
- `packages/backend/src/search/jobs/` — Jobs extraction, projection and search.
- `packages/backend/src/__tests__/architecture-gates.test.ts` — forbidden
  dependency/config regression gate.
