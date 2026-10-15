# ============================================
# Clarity API - Production Dockerfile
# ============================================
# Multi-stage build on one pinned Bun image: installs, the bundle and the
# runtime all use oven/bun:1.4.3-slim (Debian bookworm/glibc, the libc the
# Node image had), at the version `packageManager` and CI pin. One image serves
# the API (`clarity-api`), the crawler worker (`clarity-worker`, whose command
# oxy-infra sets) and every one-shot the deploy runs (the migrator).
#
# The API ran on node:22-bookworm-slim until 2026-10, with Bun copied in beside
# it. Bun runs the same esbuild bundle (ESM, platform=node) unchanged.
#
# Rolling back to Node is reverting the PR that made this change: it restores
# the node:22-bookworm-slim runtime AND the `node` migrator commands in
# .github/workflows/deploy-aws.yml, which must always name a runtime this image
# ships. The worker command in oxy-infra (terraform-uswest2/app-clarity.tf)
# runs `bun` and survives that revert: the Node runtime it restores still
# copies Bun in at /usr/local/bin/bun.
#
# The base image is pinned by digest: the digest is what the build uses, and the
# tag beside it is only for the reader (oven/bun:1.4.3-slim, resolved
# 2026-10-13; a multi-arch index that includes linux/arm64). A re-pushed tag
# cannot change the image. Bumping it means a new digest, which changes this
# file, so the reviewed-image pin fails until the owner re-reviews.

# --- Stage 1: Builder ---
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS builder

WORKDIR /build

# Copy root workspace files (bunfig pins the hoisted linker for Docker).
# EVERY workspace manifest must be here, including the ones this image never
# builds: `bun.lock` describes the whole workspace, so with `frontend` and `sdk`
# missing the resolved set differs from the lockfile and `--frozen-lockfile`
# refuses to install. Only the manifests are copied, not their sources.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/frontend/package.json ./packages/frontend/

# Install all dependencies (including devDependencies for build).
# --ignore-scripts: no dependency lifecycle script runs. Measured on this
# lockfile (2026-10-13): Bun's default allowlist ran only esbuild's
# `postinstall` (four esbuild copies), which checks and links the platform
# binary that esbuild finds through its @esbuild/linux-* package anyway;
# @swc/core and core-js were already blocked. The bundle builds the same
# without them, and CI's image build proves it on every change here.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy shared-types + API source, plus the SDK's canonical contracts the API
# bundles from source (see packages/backend/build.ts).
COPY packages/shared-types/ ./packages/shared-types/
COPY packages/sdk/src/vocabularies.ts ./packages/sdk/src/vocabularies.ts
COPY packages/sdk/src/experience.ts ./packages/sdk/src/experience.ts
COPY packages/backend/ ./packages/backend/

# Build shared-types first (backend imports its compiled declarations),
# then build the API.
RUN bun run --filter @clarity/shared-types build && \
    bun run --filter @clarity/backend build

# --- Stage 2: Production dependencies ---
# Only the API's closure (--filter): the frontend's Expo / React Native tree is
# never loaded by the server and used to be most of this image. Same image as
# the runtime, so anything native is installed for the Bun and libc that run it.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS production-deps

WORKDIR /app

# Copy root workspace files; the lockfile needs every workspace manifest here
# for the same reason as the builder stage above.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/frontend/package.json ./packages/frontend/

# Install production dependencies only.
# --omit=peer: @oxy.so/core and @oxy.so/protocol declare Expo / React Native
# peers (expo-secure-store, expo-modules-core, async-storage), and the frontend
# puts those in the lockfile, so without it this stage installed the whole
# Expo / React Native tree after all: 823 package directories and 573 MB,
# against 220 and 120 MB with it (measured 2026-10-13). The smaller set is a
# strict subset at identical versions; every package the API bundle imports is
# in it, and the bundle only names those peers in "not React Native" errors.
# --ignore-scripts: the only lifecycle script left in this closure is
# esbuild's `postinstall` (esbuild is a dependency for build.ts; the bundle
# never imports it), so nothing the runtime loads needs one.
RUN bun install --frozen-lockfile --production --omit=peer --ignore-scripts --filter @clarity/backend

# --- Stage 3: Production Runtime ---
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS runtime

# curl serves the image health check below; ca-certificates gives outbound TLS
# (Stripe, Oxy, Alia, crawled sites) the system trust store as well.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Everything under /app is owned by root and read-only to the runtime user, so
# a compromised process cannot rewrite the code it or the next command runs.
# Nothing in the API, the worker or the migrator writes under /app: the only
# file writes are the migrator's scratch journal (`mkdtemp` under
# `os.tmpdir()`, i.e. /tmp, which the base image ships 1777). CI's image smoke
# asserts both: no path under /app is writable by the runtime user, and the
# container layer shows no change under /app after the API, the worker and the
# migrator have run.
COPY --from=production-deps /app/ ./

# Copy built output from builder
COPY --from=builder /build/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /build/packages/backend/dist ./packages/backend/dist
COPY --from=builder /build/packages/backend/drizzle ./packages/backend/drizzle

# Run as the image's own unprivileged user, uid/gid 1000 (`bun`).
USER bun

ENV NODE_ENV=production
EXPOSE 3001

# Local image health check. ECS/ALB uses the same live endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/health/live || exit 1

# The image's entrypoint execs this command, so Bun is PID 1 and receives
# SIGTERM itself; src/index.ts registers the graceful-shutdown handler. Every
# command that overrides this one (the migrator in deploy-aws.yml, the worker in
# oxy-infra) names `bun` too. The base image puts a `node` on PATH, but it is a
# symlink to bun (/usr/local/bun-node-fallback-bin/node): there is no Node in
# this image, so `node <file>` would run Bun while claiming otherwise.
CMD ["bun", "packages/backend/dist/index.js"]
