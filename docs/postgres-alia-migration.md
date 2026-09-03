# PostgreSQL and Alia cutover

Status: code-complete migration candidate, not a production cutover. Runtime
readiness is deliberately closed until the steps below produce real evidence.

## Resulting ownership

Clarity code and deployment configuration contain no second datastore and no
local inference runtime. Product tables are PostgreSQL/Drizzle. Chat calls the
fixed Clarity agent in Alia. Credits and inference telemetry are read from
Alia. Provider credentials are migrated separately into Kaana custody and are
never copied into a Clarity file, environment variable or table.

## Schema and transactions

The schema covers conversations/messages, suggestions, plans/features/plan
features, the legacy credit-package catalogue retained for reconciliation,
feedback, notifications, push/web-push registrations, product subscriptions,
billing customer mapping, per-record backfill receipts and cutover state.

Conversation metadata plus full message replacement is one PostgreSQL
transaction. Messages reference the exact `(oxy_user_id, conversation_id)` and
cascade on conversation delete. Source `_id` values are copied verbatim into
text primary keys; public product IDs remain separate columns.

## Migrations

Every SQL migration has exactly one `oxy:deploy-phase` marker. Always name the
target database:

```bash
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:migrate -- \
  --target-database=clarity_rehearsal --phase=pre --dry-run
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:migrate -- \
  --target-database=clarity_rehearsal --phase=pre
```

Re-run the apply command; it must report no migrations to apply.
After the new application revision is healthy and no previous image can write
the retired per-conversation agent metadata, apply and re-run the `post` phase:

```bash
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:migrate -- \
  --target-database=clarity_rehearsal --phase=post --dry-run
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:migrate -- \
  --target-database=clarity_rehearsal --phase=post
```

## Source inventory and backfill manifest

The Clarity migrator does not contain or connect to the old datastore. An
operator with source authority exports newline-delimited extended JSON plus a
small manifest. The manifest must enumerate every live source collection, not
only collections represented by old model files.

For each collection it records exact row count and SHA-256 of the sorted source
ID set. Each collection has one disposition:

- `clarity-postgres`: bounded relative JSONL file, byte count and file hash,
  mapped to exactly one required Clarity target table;
- `external`: Alia, Kaana, Oxy or an approved archive, with a receipt whose
  exact target count and ID-set hash equal the source.

The source inventory itself is content-bound by `inventorySha256`. Files are
restricted to the manifest directory, the manifest is capped at 1 MiB, data
files at 2 GiB and individual rows at 4 MiB. Changed files, duplicate IDs,
counts-only matches, missing tables and external ID mismatches fail closed.
Each file is hashed from the same bounded byte stream that is parsed, inside a
transaction for that collection; a byte/hash/ID/count mismatch rolls back its
rows and receipts together. Symlinks cannot escape the manifest directory.

```bash
DATABASE_URL=postgresql://... bun run --filter @clarity/backend db:backfill -- \
  --manifest=/approved/export/manifest.json
```

The importer is idempotent. Every source record and canonical content hash gets
an append-only receipt in the same transaction as its target insert. A changed
rerun or a pre-existing unreceipted target row fails. On success it reconciles
exact receipt ID sets and exact target counts, then records status `reconciled`.

## Cutover evidence

The manifest also carries dated receipt IDs for:

1. the real Clarity Alia agent answering an authenticated product turn;
2. the same turn reaching Oxy inference;
3. the same turn reaching an attested Kaana route;
4. a subscription event granting Alia inference credit exactly once.

The manifest stores only SHA-256 of the real agent ID. The deployment secret
must hash to that value. After reviewing the exact snapshot hash:

```bash
DATABASE_URL=postgresql://... \
CLARITY_ALIA_AGENT_ID=01a0646a-078f-7642-95ef-439952f4f3f9 \
bun run --filter @clarity/backend db:attest-cutover -- \
  --manifest=/approved/export/manifest.json \
  --snapshot-hash=<exact-inventory-sha256> \
  --confirm=CUTOVER_CLARITY_TO_POSTGRES
```

Only a matching `reconciled` row with the same agent-ID hash can become
`cutover`. Until then `/health/ready` returns `503`, every product HTTP route
returns `503`, and Socket.IO rejects the handshake. Changing the canonical
agent or backend service configuration also closes those gates.

## Production blockers

- live source database/collection inventory and exact export are not available
  in this repository;
- DigitalOcean PostgreSQL and `DATABASE_URL` are not proven provisioned;
- source now targets the declared `api.clarity.surf` product API, but no DNS
  answer or deployed App Platform revision has been observed for that origin;
- the canonical bot/agent/backend-app IDs are pinned, but no dated evidence
  proves Alia has reconciled the manifest, prompt hash, app binding and exact
  `web`/`artifacts`/`memory` grants;
- the declarations accept the backend service credential as a
  DigitalOcean-managed secret, but no read-back proves that the live app has it;
- the pre-existing Codea/Cowork developer authorization endpoints remain
  explicit `410` responses until a canonical Oxy application-delegation
  replacement is designed; this migration does not claim that flow works;
- the Oxy inference edge dependency used by Alia is still an external rollout
  dependency;
- external migration receipts for historical credits/usage/memory/agent data
  and a live receipt proving Clarity reached Kaana's credential-backed route do
  not yet exist; this is not a claim that Kaana's custody store itself is absent;
- no production Stripe dual-webhook credit-grant test or deployed revision was
  observed.

Do not delete source data, enable traffic or mark the PR production-ready until
all blockers are replaced with dated, exact evidence.
