# Contributing to Clarity

## Prerequisites

- **Node.js 22** (use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm))
- **MongoDB** (local or Atlas)
- **Redis** (optional, falls back gracefully)

## Getting Started

```bash
git clone <repo-url> && cd Clarity
bun install              # installs all workspaces
cp packages/backend/.env.example packages/backend/.env   # fill in your values
bun run dev              # starts all services
```

Focused commands:

```bash
bun run dev:backend      # API only
bun run dev:frontend     # Expo app only
```

## Monorepo Structure

This is a **bun workspaces** monorepo (no Turborepo/Nx).

| Package | Stack | Purpose |
| --- | --- | --- |
| `packages/backend` (`@clarity/backend`) | Express + TypeScript | Core API runtime |
| `packages/frontend` (`@clarity/frontend`) | Expo (React Native + Web) | Main app (web + iOS + Android) |
| `packages/shared-types` (`@clarity/shared-types`) | TypeScript | Types shared by frontend + backend |

## Branch Naming

```
feat/short-description
fix/short-description
refactor/short-description
```

Always branch from `main`.

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add trigger scheduling UI
fix: correct token refresh race condition
refactor: extract chat handler into shared module
docs: update deployment guide
test: add integration tests for context graph
chore: bump dependencies
```

## Pull Request Process

1. Create a branch from `main` with the naming convention above.
2. Keep PRs focused -- one feature or fix per PR.
3. Write a descriptive PR summary (what changed and why).
4. Ensure CI passes before requesting review.
5. Request review from at least one team member.

## Code Style

- **TypeScript strict mode** encouraged. Avoid `any` -- use proper types.
- **Frontend styling**: NativeWind (Tailwind). No inline style objects unless necessary.
- **State management**: Zustand stores. Data fetching via TanStack Query.
- **Routing**: expo-router (file-based) in `packages/frontend`.
- Follow existing patterns in the codebase. When in doubt, look at neighboring files.

## Testing

Run API tests before submitting:

```bash
bun run --filter @clarity/backend test
```

Tests use **Vitest**. Place test files next to source as `*.test.ts`.

## Key Conventions

### Model Abstraction (Critical)

Clarity wraps multiple AI providers behind branded model names. **Never expose provider names or model IDs** (OpenAI, Anthropic, `gpt-4o`, `claude-sonnet-4`, etc.) in:

- UI text, error messages, API responses
- Documentation, comments, or marketing copy

Always use Clarity model names: `clarity-v1`, `clarity-fast`, `clarity-v1-pro`, `clarity-v1-thinking`, etc.

### Error Handling

Use `sanitizeMessage()` from `packages/backend/src/lib/errors/sanitize.ts` for all user-facing error messages. This strips any leaked provider names.

### Database

MongoDB with Mongoose. Database name follows `clarity-{NODE_ENV}` convention. Connection URI is shared across the Oxy ecosystem -- the `dbName` is passed to `mongoose.connect()`, not embedded in the URI.
