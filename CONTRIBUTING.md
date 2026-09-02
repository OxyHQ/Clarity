# Contributing to Clarity

The organisation-wide process is in the
[Oxy contribution guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md).
Clarity targets `master`.

## Prerequisites

- Bun from the root `packageManager` field
- Node.js 22
- PostgreSQL for the backend
- Redis only when exercising cache/rate-limit behavior

```bash
bun install
cp packages/backend/.env.example packages/backend/.env
bun run dev:backend
```

Build shared types before a consumer after changing a shared contract.

## Required checks

```bash
bun run --filter @clarity/backend lint
bun run --filter @clarity/backend test
bun run build:backend
```

CI also starts a disposable PostgreSQL database, dry-runs and applies all `pre`
migrations twice, then runs repository integration tests. Never point those
tests at a database other than the explicitly named `clarity_ci` database.

Read `AGENTS.md` before changing auth, persistence, model IDs or chat. Do not
add direct inference dependencies or a second datastore.
