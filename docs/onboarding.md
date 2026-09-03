# Developer onboarding

## 1. Read the boundaries

Read the repository `AGENTS.md`, then `docs/index.mdx`. The important split is:
Clarity persists product state in PostgreSQL; its assistant runs as one Alia
agent; Oxy and Kaana own inference.

## 2. Install and configure

```bash
bun install
cp packages/backend/.env.example packages/backend/.env
```

Set `DATABASE_URL` to a local PostgreSQL database and the canonical
`CLARITY_ALIA_AGENT_ID` byte for byte. Chat additionally needs the fixed backend
`OXY_SERVICE_API_KEY` and an untracked `OXY_SERVICE_API_SECRET`; without them
readiness remains unavailable.

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
| `packages/backend/src/lib/alia-agent-client.ts` | Authenticated fixed-agent proxy and SSE translation |
| `packages/backend/src/lib/clarity-models.ts` | Exact Clarity ID to Alia profile mapping |
| `packages/backend/src/routes/v1/chat-completions.ts` | Public compatibility endpoint |
| `packages/frontend/hooks/useStreamingChat.ts` | Clarity SSE consumer |

## 5. Validate

```bash
bun run --filter @clarity/backend lint
bun run --filter @clarity/backend test
bun run build:backend
```

For database integration use only a disposable database named `clarity_ci` and
follow `docs/postgres-alia-migration.md`.
