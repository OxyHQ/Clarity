# ============================================
# Clarity API - Production Dockerfile
# ============================================
# Multi-stage build: Bun for installs, Node for runtime

# --- Stage 1: Builder ---
FROM node:22-bookworm-slim AS builder

# Install Bun
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /var/lib/apt/lists/*

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

# Install curl for health checks and Bun for dependency install
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

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

# Allow non-root user to write temp files
RUN chown -R node:node /app

# Security hardening: Run as non-root user
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Health check for orchestrators (k8s, DO App Platform)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health/live || exit 1

CMD ["node", "packages/backend/dist/index.js"]
