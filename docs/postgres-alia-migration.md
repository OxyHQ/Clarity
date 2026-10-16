# PostgreSQL and Alia cutover

Status: code-complete migration candidate, not a production cutover. Runtime
readiness is deliberately closed until the steps below produce real evidence.

## Resulting ownership

Clarity code and deployment configuration contain no second datastore and no
local inference runtime. Product tables are PostgreSQL/Drizzle. The assistant is
an ordinary Alia agent; its conversations, credits and telemetry are Alia's, and
Clarity's own historical conversations are not migrated (owner decision
2026-10-16). Provider credentials are migrated separately into Kaana custody and
are never copied into a Clarity file, environment variable or table.

## Schema and transactions

The schema covers suggestions, plans/features/plan features, the legacy
credit-package catalogue retained for reconciliation, feedback, notifications,
push/web-push registrations, product subscriptions, billing customer mapping,
per-record backfill receipts and cutover state. Source `_id` values are copied
verbatim into text primary keys; public product IDs remain separate columns. A
legacy plan's `modelIds` is not imported: plans unlock power levels through the
plan features `power-level-<level>` (see [Clarity's assistant](assistant)).

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
After the new application revision is healthy and no previous image is serving,
apply and re-run the `post` phase:

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
  exact target count and ID-set hash equal the source;
- `discarded`: counted in the inventory and not carried over — the legacy
  conversation and message collections.

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

## Cutover attestation

After reviewing the exact snapshot hash:

```bash
DATABASE_URL=postgresql://... \
bun run --filter @clarity/backend db:attest-cutover -- \
  --manifest=/approved/export/manifest.json \
  --snapshot-hash=<exact-inventory-sha256> \
  --confirm=CUTOVER_CLARITY_TO_POSTGRES
```

Only a matching `reconciled` row can become `cutover`. Until then
`/health/ready` returns `503`, every product HTTP route returns `503`, and
Socket.IO rejects the handshake.

## Production blockers

- live source database/collection inventory and exact export are not available
  in this repository;
- the production PostgreSQL database and `DATABASE_URL` are not proven
  provisioned;
- source now targets the declared `api.clarity.surf` product API, but no DNS
  answer or deployed production revision has been observed for that origin;
- the declarations accept the backend service credential from the production
  platform's managed secret store, but no read-back proves that the live app
  has it;
- external migration receipts for historical credits/usage/memory/agent data
  and a live receipt proving Clarity reached Kaana's credential-backed route do
  not yet exist; this is not a claim that Kaana's custody store itself is absent.

Do not delete source data, enable traffic or mark the PR production-ready until
all blockers are replaced with dated, exact evidence.


## Read-only production observation — 2026-09-13

The Alia web-search incident confirmed that `api.clarity.surf` resolves to the
production load balancer but returns HTTP 503. Both `clarity-api` and
`clarity-worker` have desired/running counts `0/0`. Deployment run
`34526130360` built main `18419cdbcf048b509b513a58f6a26d518f9aafff` but refused
rollout because desiredCount was zero.

The required SSM bindings exist and two isolated tasks reached the production
PostgreSQL database using the tested immutable image. The schema is provisioned,
but `clarity_runtime_state` and `clarity_backfill_receipts` are empty; counts
are also zero for conversations, messages, search documents and search chunks.
This resolves the older provisioning/DNS uncertainty above, but does not satisfy
the source reconciliation or runtime/billing receipt gates. No production
capacity or attestation was changed.

The vault and the examined S3 final inventories of the historical source did
not provide a Clarity source manifest. A connection probe to the historical source endpoint timed
out. These observations do not establish that the source was empty. Recovery
requires locating its authoritative inventory/export and reconciling it before
attestation, then restoring the indexed corpus and proving real search results.
See the [Alia incident record](https://github.com/OxyHQ/Alia/blob/main/docs/runbooks/clarity-search-2026-09-13.md)
for task IDs, image identity and the correction to the former search canary's
false success assertion.
