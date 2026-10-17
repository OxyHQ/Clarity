# Clarity product API

Express API for Clarity's own product: search, Jobs, places, market, news,
Experience, notifications, feedback, suggestions, plans, subscriptions and
entitlements — and the capability catalogue through which Clarity's assistant
reaches all of it.

## Runtime ownership

- PostgreSQL/Drizzle: the search index and Jobs, suggestions, feedback,
  notifications, experience, product catalogue, subscriptions and entitlements.
- Alia: Clarity's assistant is an ordinary Alia agent, opened by the frontend
  through `@alia.onl/sdk` under the person's own session and paid by the
  person's Alia credits. Its conversations, memory, credits and telemetry are
  Alia's. This backend never calls Alia.
- Oxy: identity, capability tickets, inference accounting and route authorization.
- Kaana: adapters, provider-key custody and execution/failover within Oxy's
  signed order. Clarity's one inference call is search embeddings on
  `https://kaana.ai/v1`; it never stores provider keys or uses an `oxy.so` alias.

## Capability catalogue

`src/capabilities/` declares what a signed-in person can do in Clarity as
tools (`clarity.catalog.ts`) and serves them on two lanes from this process:

- `POST /_oxy/mcp` on `api.clarity.surf` — Alia, with Oxy capability tickets
  verified live (JWKS signature, then introspection) and audited;
- `/mcp` on `mcp.clarity.surf` — any OAuth MCP client, acting as the
  connection's active account.

Both are mounted before CORS, the body parsers and runtime readiness. The
catalogue registers itself at startup; until Oxy accepts it `/_oxy/mcp`
answers 503 and retries. The effective account comes only from the verified
ticket or OAuth connection. Bump `version` with any tool change.

## Development

```bash
bun run dev
bun run lint
bun run test
bun run build
```

The service does not start without `DATABASE_URL`. `/health/live` proves only
process liveness; `/health/ready` requires PostgreSQL, an attested cutover and
an attestable backend service identity.
All product HTTP routes and Socket.IO handshakes enforce that same gate.

Database scripts:

```bash
bun run db:generate
bun run db:migrate -- --target-database=clarity_ci --phase=pre --dry-run
bun run db:backfill -- --manifest=/absolute/path/manifest.json
bun run db:attest-cutover -- --manifest=/absolute/path/manifest.json \
  --snapshot-hash=<sha256> --confirm=CUTOVER_CLARITY_TO_POSTGRES

# A deployment that never had prior data to migrate attests that instead:
bun run db:attest-fresh-install -- --confirm=FRESH_INSTALL_NO_DATA_TO_MIGRATE
```

See `../../docs/postgres-alia-migration.md` before running any data command.
