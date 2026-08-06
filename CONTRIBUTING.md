# Contributing to Clarity

Clarity is an AI search engine by Oxy: cited answers, deep research, and agents that keep working after the answer. It doubles as the Oxy NativeWind 5 reference implementation.

**The contribution process lives in the [Oxy organisation CONTRIBUTING guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md)**: reporting an issue, filing a feature request, opening a pull request, code review, licensing. It applies here unchanged. This file layers on top of it the same way `AGENTS.md` files layer, so it is short on purpose: it carries only what is different about this repository.

## The default branch is `master`

Clarity has not been renamed to `main`. Branch from `master`, and target `master` with your pull request.

## Prerequisites

- **Bun.** The package manager for every Oxy repository, never npm or yarn. The pinned version is `packageManager` in the root `package.json`.
- **Node.js 22.** The runtime the backend is built and deployed on. CI pins it alongside bun.
- **MongoDB**, local or remote, to run the backend. The test suite does not need one.
- **Redis**, optional. Caching and rate limiting fall back gracefully without it.

## Setup

```bash
git clone https://github.com/OxyHQ/Clarity.git && cd Clarity
bun install
cp packages/backend/.env.example packages/backend/.env   # fill in your values
bun run dev                                              # every package at once
```

Focused commands:

```bash
bun run dev:backend    # API only
bun run dev:frontend   # Expo app only (runs with --clear --tunnel)
```

`packages/frontend` has its own `.env.example`; copy that too if you are working on the app.

## Layout

A bun workspaces monorepo on the standard Oxy three package shape:

| Package | Stack | Purpose |
| --- | --- | --- |
| `packages/backend` (`@clarity/backend`) | Express + TypeScript | Core API runtime |
| `packages/frontend` (`@clarity/frontend`) | Expo (React Native and Web) | Main app: web, iOS, Android |
| `packages/shared-types` (`@clarity/shared-types`) | TypeScript | Types shared by frontend and backend |

`shared-types` has to be built before either consumer, which is why `build:frontend` and `build:backend` both build it first. Run `bun run build:shared-types` after changing a shared type.

## Tests

```bash
bun run --filter @clarity/backend test
```

Vitest. Place test files next to the source as `*.test.ts`. `packages/backend` is the only package with a suite today, and it mocks its data layer, so nothing needs to be running.

CI runs the following on every pull request, and each line runs locally as written:

```bash
bun run --filter @clarity/backend lint
bun run --filter @clarity/backend test
bun run build:backend
```

## Conventions

Coding standards for this repository are in `AGENTS.md` at the repository root, including the model abstraction rule that keeps provider names and provider model ids out of everything user facing, and the pending migration of the backend client onto `oxyServices.createLinkedClient`. `AGENTS.md` is read directly by Claude Code, Codex, Cursor and Copilot, and it is the file to update when a convention changes.
