# Existing paid-only catalogue guard

Followup base: `3583f536590cbd4331ed639fd18a07ac13dc9dc0` (Clarity#75).
The preceding selection audit describes that exact commit; evaluate its source
hashes at that commit. This followup has its own source and result manifest.

The existing checkout and change-plan handlers both pass `isFree: false` to
`getPlans`. That function accepted the field but omitted its SQL predicate. The
only runtime change adds the boolean `isFree` predicate alongside `isActive`.
Absent filters preserve the old unfiltered behavior; no catalogue definitions,
pricing, proration, dependency manifests or Stripe API version are changed.

The harness was frozen **before** the runtime edit. `frozen-harness.ts` and the
executed test have the identical SHA-256 recorded in `red-inputs.json` and
`evidence.json`. The RED run on the base catalogue reader failed six of 32
cases; GREEN passed all 32 with exactly the same harness. Eight cases extend
the previously green 24-case selection suite:

- SQL `true`, `false`, absent filter, exact free-ID paid lookup, and conjunction
  with product/active predicates.
- Real HTTP checkout and change-plan reject a free ID with `400`, before
  customer retrieval, checkout creation, price creation, subscription retrieval
  or update. Provider observers prove those calls were not made.
- Paid checkout uses the existing exact price, plan and product with a fully
  mocked provider. The two paid plan-change cases remain green.

The published shared Oxy middleware and SQL repositories are real; central
session validation remains synthetic. All Stripe operations are mocked and
unexpected global fetch is rejected, with a final zero-call assertion. No real
checkout session, payment, invoice, refund or cancellation was created.

The disposable local `clarity_ci` database uses the preceding literal billing
schema plus `billing-customers-schema.sql`, copied verbatim from migration0002.
Each run clones the three migrated tables, with checks/unique constraints/indexes,
into a fresh private schema and drops only that schema. Standard CI already
applies the full pgvector schema; its bootstrap is unchanged.

Local focal suite32, backend lint and build pass. Backend typecheck retains
only the pre-existing Stripe API-version literal mismatch documented in the
preceding audit. No frontend source changed in this followup; frontend validation
at the preceding exact head remains historical evidence, and the new CI run is
reported separately on the PR.

From the repository root, with an independently verified disposable database:

```bash
TEST_DATABASE_URL=postgresql://clarity_local@127.0.0.1:5558/clarity_ci \
  bun run --filter @clarity/backend test src/routes/__tests__/billing-product-selection.postgres.test.ts
cd packages/backend
bun run lint
bun x tsc --noEmit
cd ../..
bun run build:backend
```

To reproduce RED, run the frozen harness at the test path against the base
catalogue source in a separate checkout. Keep the three migrated billing tables
available in disposable `clarity_ci`. Logs have ANSI/trailing whitespace removed;
original hashes refer to retained private outputs. CI/publication/provider-runtime
and global I07/I11 acceptance remain separate from these local results.
