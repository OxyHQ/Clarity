# Clarity subscription-selection verification

Base: `b1e0054a7734f2e57d46b20d82f593a4be547738` (remote main unchanged at review).
Source scope: repository, billing route, cancellation hook, subscription cache
key prefix, and settings caller. No manifests, migrations, provider adapters,
catalogue policy, releases or deployments changed.

The first five-case RED run observed legacy cancellation choosing the newer
product, an explicit selector ignored, a foreign selector ignored while the
caller's own subscription was changed, a target plan changing the other product,
and duplicate subscriptions accepted. It did **not** show modification of a
foreign account. That initial harness was subsequently expanded and typed;
its historical log is retained, but its original initial file was not frozen.
The final harness and its exact hash are retained with the final GREEN results.

Final local results:

- Real HTTP + PostgreSQL suite: **24 passed**, including both target products,
  account ownership, foreign/unknown selector equivalence, invalid input,
  same-product ambiguity, current-plan inconsistency, all seven database states,
  terminal exclusions, and absent authentication.
- Backend lint/build and frontend build/typecheck: exit 0.
- Existing frontend pure-module tests: 4 suites / 25 passed.
- Backend typecheck: exit 2 solely for the pre-existing Stripe API-version
  literal (`2026-06-24.dahlia` in base, installed Stripe 22.6.2 admits
  `2026-08-26.dahlia`). No new test or selection-code type errors remain.

The published core 3.0 shared authentication middleware is real; only central
`session.validate` is synthetic. Express, plan queries and subscription
repositories are real. Stripe is fully mocked: observations record selected
subscription IDs without making provider requests; product/price creation and
unexpected global fetch are tripwires. No funds, invoices or actual cancellation
are involved. These tests do not verify a live Oxy identity/provider integration.

Local PostgreSQL 17.11 is owned by this agent, PID 3148535, loopback 5558, with
the data directory in `owner.txt`; database is exclusively disposable
`clarity_ci`. `billing-schema.sql` contains seven **literal** statements extracted
from existing migrations 0000 and 0002: plans/subscriptions, relevant checks,
unique constraints and indexes. Those tables have no relevant foreign keys.
No vector extension is installed on that local server, so this is a billing-only
schema fixture, not a claim of full local migration. The existing CI workflow
already provisions pgvector PostgreSQL 17 and runs the complete migrations before
all API tests; it is unchanged. The suite clones these real migrated table
definitions with `LIKE INCLUDING ALL` into its own random schema inside
`clarity_ci`, connects the application through that schema's `search_path`, and
drops only its own schema afterward. This keeps public backfill inventories and
parallel public-table truncation separate. CI results are reported separately in
the PR.

Reproduce against an independently verified disposable database named
`clarity_ci`; use full standard migrations when pgvector is available. For the
local billing-only fixture, apply `billing-schema.sql` to a fresh disposable
database before the focal suite. Never apply this fixture to an existing or real
database.

```bash
bun install --frozen-lockfile --minimum-release-age=0
cd packages/backend
TEST_DATABASE_URL=postgresql://clarity_local@127.0.0.1:5558/clarity_ci \
  bun run test src/routes/__tests__/billing-product-selection.postgres.test.ts
bun run lint
bun x tsc --noEmit
cd ../frontend
bun run test
bun x tsc --noEmit
cd ../..
bun run build:backend
bun run build:frontend
```

The builds can regenerate `public/sitemap.xml`; its generated timestamp-only
change was restored to the base and is not included. `evidence.json` binds
source, installed modules and logs. Logs have ANSI formatting removed; original
hashes refer to retained private verification outputs under the agent evidence
directory. No test suite was omitted to obtain the focal result, and no complete
backend-suite or live-provider claim is made from it.
