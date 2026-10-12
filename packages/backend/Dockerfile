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

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy shared-types + API source, plus the SDK's vocabulary module the API
# bundles from source (see packages/backend/build.ts).
COPY packages/shared-types/ ./packages/shared-types/
COPY packages/sdk/src/vocabularies.ts ./packages/sdk/src/vocabularies.ts
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

# Install production dependencies only
RUN bun install --frozen-lockfile --production --filter @clarity/backend

# --- Stage 3: Production Runtime ---
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS runtime

# curl serves the image health check below; ca-certificates gives outbound TLS
# (Stripe, Oxy, Alia, crawled sites) the system trust store as well.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The non-root user owns /app (it writes temp files there) and everything
# copied into it. Each COPY sets the owner itself: a trailing `chown -R`
# rewrote every file into a second layer and shipped node_modules twice.
# `bun` is the image's own unprivileged user, uid/gid 1000 like Node's `node`.
RUN chown bun:bun /app

COPY --from=production-deps --chown=bun:bun /app/ ./

# Copy built output from builder
COPY --from=builder --chown=bun:bun /build/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder --chown=bun:bun /build/packages/backend/dist ./packages/backend/dist
COPY --from=builder --chown=bun:bun /build/packages/backend/drizzle ./packages/backend/drizzle

# Security hardening: Run as non-root user
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
