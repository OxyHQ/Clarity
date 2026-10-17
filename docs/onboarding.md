# Developer onboarding

## 1. Read the boundaries

Read the repository `AGENTS.md`, then `docs/index.mdx`. The important split is:
Clarity persists its product in PostgreSQL; its assistant is an ordinary Alia
agent the frontend opens through `@alia.onl/sdk`, reaching Clarity through the
capability catalogue; Oxy and Kaana own inference.

## 2. Install and configure

```bash
bun install
cp packages/backend/.env.example packages/backend/.env
```

Set `DATABASE_URL` to a local PostgreSQL database. The backend's Oxy service
identity is the ECS task role (see `docs/deployment.md`): there is no Oxy key
pair to set, so on a laptop readiness stays unavailable
(`clarity_service_identity_unconfigured`) and the capability catalogue cannot
register. The chat itself needs no backend: the frontend talks to Alia under
your own Oxy session.

## 3. Run

```bash
bun run dev:backend
bun run dev:frontend
```

The backend defaults to port 3001. Useful probes:

```bash
curl http://127.0.0.1:3001/health/live
curl http://127.0.0.1:3001/health/ready
```

`live=200` is not readiness. A fresh local database intentionally reports an
unattested cutover.

## 4. Key files

| Path | Purpose |
| --- | --- |
| `packages/backend/src/db/schema/index.ts` | Drizzle product schema |
| `packages/backend/src/db/*-repository.ts` | Product read/write boundaries |
| `packages/backend/src/capabilities/clarity.catalog.ts` | The capability catalogue: every tool the assistant has in Clarity |
| `packages/backend/src/capabilities/mount.ts` | `/_oxy/mcp` (Alia) and `mcp.clarity.surf/mcp` (OAuth clients) |
| `packages/frontend/components/chat/clarity-conversation.tsx` | The conversation, drawn by `@alia.onl/sdk` |
| `packages/frontend/components/chat/clarity-tool-renderers.tsx` | Catalogue results as Clarity's own cards |

## 5. Validate

```bash
bun run lint            # Biome (lint + format check), whole repo — CI runs `bunx biome ci .`
bun run --filter @clarity/backend test
bun run build:backend
```

For database integration use only a disposable database named `clarity_ci` and
follow `docs/postgres-alia-migration.md`.
