# Clarity product API

Express API for Clarity-owned state and the fixed Alia agent boundary.

## Runtime ownership

- PostgreSQL/Drizzle: conversations, messages, suggestions, feedback,
  notifications, product catalogue, subscriptions and entitlements.
- Alia: agent execution, tools, research, citations, credits and telemetry.
- Oxy: identity and inference accounting.
- Kaana: inference routing, adapters and provider-key custody.

The two chat entry points use the same handler:

- `POST /clarity/search`
- `POST /v1/chat/completions`

Only a direct authenticated Oxy user session can currently invoke chat. The
internal service route returns `503` until an explicit service-to-agent
delegation contract exists.

Memory, agent audit, authenticated triggers and the two channel-link endpoints
used by Clarity are fixed, allowlisted proxies into Alia. They never accept a
caller-supplied upstream URL. Alia returns its own webhook URL and validates
webhook tokens, signatures and source IPs at that origin; Clarity does not
relay webhook ingestion.

## Development

```bash
bun run dev
bun run lint
bun run test
bun run build
```

The service does not start without `DATABASE_URL`. `/health/live` proves only
process liveness; `/health/ready` requires PostgreSQL, an attested cutover and
the exact configured Alia agent whose hash was recorded during reconciliation.
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
