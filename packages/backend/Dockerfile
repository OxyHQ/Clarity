# ============================================
# Clarity API - Production Dockerfile
# ============================================
# Multi-stage build: Bun for installs, Node for runtime

# --- Stage 1: Builder ---
FROM node:22-bookworm-slim AS builder

# Bun comes from its own published image at the version `packageManager` and CI
# pin. The previous `curl | bash` install failed OPEN: a failed download left
# `bash` reading nothing and exiting 0, `ln -s` happily created a dangling
# symlink, and the build only died four lines later with `bun: not found`.
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /build

# Copy root workspace files (bunfig pins the hoisted linker for Docker)
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared-types/package.json ./packages/shared-types/

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy shared-types + API source
COPY packages/shared-types/ ./packages/shared-types/
COPY packages/backend/ ./packages/backend/

# Build shared-types first (backend imports its compiled declarations),
# then build the API.
RUN bun run --filter @clarity/shared-types build && \
    bun run --filter @clarity/backend build

# --- Stage 2: Production Runtime ---
FROM node:22-bookworm-slim AS runtime

# curl serves the image health check below; Bun installs production deps.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared-types/package.json ./packages/shared-types/

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# Copy built output from builder
COPY --from=builder /build/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /build/packages/backend/dist ./packages/backend/dist
COPY --from=builder /build/packages/backend/drizzle ./packages/backend/drizzle

# Allow non-root user to write temp files
RUN chown -R node:node /app

# Security hardening: Run as non-root user
USER node

ENV NODE_ENV=production
EXPOSE 3001

# Local image health check. ECS/ALB uses the same live endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/health/live || exit 1

CMD ["node", "packages/backend/dist/index.js"]
