# Clarity

> Universal standards live in `~/AGENTS.md`, Oxy-wide gotchas in `~/Oxy/AGENTS.md`. Documentation belongs in `docs/`, history in git, status in issues. This file holds only RULES, commands and pointers. **Budget: under 8 KB.**

Clarity is an Expo product plus an Express product API. The assistant is one
named Alia bot/agent. Chat flows `Clarity -> Alia -> Oxy inference -> Kaana`.

## Hard boundaries

- PostgreSQL/Drizzle is the only Clarity datastore. Do not add another database
  driver, fallback, connection string, compatibility reader, or dual write.
- Clarity owns product state: conversations, suggestions, notifications,
  feedback, plan catalogue, subscriptions and entitlements.
- Alia owns the agent runtime, tools, search/deep research, memory, citations,
  inference credits and inference telemetry.
- Kaana owns inference routing, adapters and provider credentials. No provider
  credential, adapter, routing table or direct provider endpoint belongs here.
- Preserve the public product IDs in
  `packages/backend/src/lib/clarity-models.ts`. Map by exact ID, never name,
  array position, or sort order.
- Never invent `CLARITY_ALIA_AGENT_ID`. Missing provisioning must fail closed.
- A service credential is not a user session or an Alia agent identity.
  Service-triggered agent work stays unavailable until the canonical delegated
  contract is implemented and provisioned.

Platform credentials such as Stripe, VAPID, Valkey and Oxy identity are not
inference-provider credentials. Keep that distinction in architecture gates.

## Commands

```bash
bun install --frozen-lockfile
bun run --filter @clarity/backend lint
bun run --filter @clarity/backend test
bun run build:backend
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
- `docs/chat-api.mdx` — user-session chat and streaming boundary.
- `docs/postgres-alia-migration.md` — rehearsal, reconciliation and cutover.
- `packages/backend/src/db/schema/index.ts` — product schema.
- `packages/backend/src/lib/alia-agent-client.ts` — fixed-agent proxy.
- `packages/backend/src/__tests__/architecture-gates.test.ts` — forbidden
  dependency/config regression gate.
