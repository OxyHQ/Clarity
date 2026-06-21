# Clarity

AI-powered search engine by [Oxy](https://oxy.so). Get answers with source citations, deep research, and follow-up questions.

**Live:** [clarity.surf](https://clarity.surf)

## Stack

- **Frontend**: Expo 55 + React Native Web + NativeWind (Tailwind CSS)
- **Backend**: Express + TypeScript + MongoDB + Redis + Socket.IO
- **AI**: Multi-provider abstraction (OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral)
- **Auth**: OxyHQ (@oxyhq/services)
- **Infra**: SST + DigitalOcean (App Platform, Spaces) + Cloudflare

## Monorepo

```
apps/
  app/              # Expo cross-platform app (web + mobile)
  api/              # Express backend API
```

## Development

```bash
bun install
bun run dev:frontend    # Start frontend (Expo)
bun run dev:backend     # Start backend (Express)
```

## Infrastructure

Infrastructure is defined as code in `sst.config.ts` using [SST](https://sst.dev) with DigitalOcean and Cloudflare providers.

```bash
# Set credentials
export DIGITALOCEAN_TOKEN=dop_v1_...
export SPACES_ACCESS_KEY_ID=...
export SPACES_SECRET_ACCESS_KEY=...
export CLOUDFLARE_API_TOKEN=...

# Deploy to a stage
bunx sst deploy --stage production

# Local dev (starts multiplexer)
bunx sst dev
```

### Resources managed by SST

| Resource | Provider | Notes |
|----------|----------|-------|
| API service | DO App Platform | Express backend, 2 instances (prod) |
| Static frontend | DO App Platform | Expo web build |
| File storage | DO Spaces | `bucket-clarity` in ams3 |
| Domains | clarity.surf | api.clarity.surf |

### Shared resources (external)

MongoDB and Valkey (Redis) are shared across all Oxy apps and referenced by cluster name in the App Platform spec. They are **not** created or destroyed by SST.

### Stages

- `production` — live at clarity.surf, retains resources on removal
- Any other stage name — creates isolated environment, removes resources on cleanup

## Key Features

- **Search-first UI** with centered search box and category tabs
- **Deep research mode** with multi-step search, source extraction, and synthesis
- **Source citations** with numbered references
- **Model abstraction** — users see Clarity models, never provider names
- **SSE streaming** with custom events (clarity.research_progress, clarity.reasoning, etc.)
- **Billing** via Stripe with credit-based usage tracking
