# Clarity product API

Express API for Clarity-owned state and the fixed Alia agent boundary.

## Runtime ownership

- PostgreSQL/Drizzle: conversations, messages, suggestions, feedback,
  notifications, product catalogue, subscriptions and entitlements.
- Alia: agent execution, tools, research, citations, credits and telemetry.
- Oxy: identity, inference accounting and exact route authorization/order.
- Kaana: adapters, provider-key custody and execution/failover within Oxy's
  signed order.

Kaana is the only hosted inference data plane and its only canonical signed
origin is `https://kaana.ai`. Clarity never stores provider keys, addresses
Kaana directly or uses an `oxy.so` alias for it. Its Oxy backend credential is
a product-service identity, not a provider credential.

The two chat entry points use the same handler:

- `POST /clarity/search`
- `POST /v1/chat/completions`

Only an authenticated Oxy user can invoke product chat. Clarity does not
forward that bearer: it calls Alia with its exact backend service credential
and `X-Oxy-User-Id`. The separate internal-trigger route remains `503` because
machine-triggered product work has no approved requester contract.

Memory, agent audit, authenticated triggers and the two channel-link endpoints
used by Clarity are fixed, allowlisted proxies into Alia. They never accept a
caller-supplied upstream URL. Alia returns its own webhook URL and validates
webhook tokens, signatures and source IPs at that origin; Clarity does not
forward webhook ingestion.

## Development

```bash
bun run dev
bun run lint
bun run test
bun run build
```

The service does not start without `DATABASE_URL`. `/health/live` proves only
process liveness; `/health/ready` requires PostgreSQL, an attested cutover, the
canonical Alia agent and the exact backend service configuration.
All product HTTP routes and Socket.IO handshakes enforce that same gate.

Database scripts:

```bash
bun run db:generate
bun run db:migrate -- --target-database=clarity_ci --phase=pre --dry-run
bun run db:backfill -- --manifest=/absolute/path/manifest.json
bun run db:attest-cutover -- --manifest=/absolute/path/manifest.json \
  --snapshot-hash=<sha256> --confirm=CUTOVER_CLARITY_TO_POSTGRES
```

See `../../docs/postgres-alia-migration.md` before running any data command.
