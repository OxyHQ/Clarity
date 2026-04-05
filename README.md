# Clarity

AI-powered search engine by [Oxy](https://oxy.so). Get answers with source citations, deep research, and follow-up questions.

**Live:** [clarity.surf](https://clarity.surf)

## Stack

- **Frontend**: Expo 55 + React Native Web + NativeWind (Tailwind CSS)
- **Backend**: Express + TypeScript + MongoDB + Redis + Socket.IO
- **AI**: Multi-provider abstraction (OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral)
- **Auth**: OxyHQ (@oxyhq/services)
- **Deploy**: Cloudflare Pages (frontend) + DigitalOcean (backend)

## Monorepo

```
apps/
  app/              # Expo cross-platform app (web + mobile)
  api/              # Express backend API
  clarity-gateway/  # Model routing gateway
```

## Development

```bash
bun install
bun run dev:app    # Start frontend (Expo)
bun run dev:api    # Start backend (Express)
```

## Deploy

Frontend auto-deploys to Cloudflare Pages on push to `master`.

Backend deploys to DigitalOcean via `.do/app.yaml`.

## Key Features

- **Search-first UI** with centered search box and category tabs
- **Deep research mode** with multi-step search, source extraction, and synthesis
- **Source citations** with numbered references
- **Model abstraction** — users see Clarity models, never provider names
- **SSE streaming** with custom events (clarity.research_progress, clarity.reasoning, etc.)
- **Billing** via Stripe with credit-based usage tracking
