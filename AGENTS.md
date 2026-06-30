# Clarity — AI-Powered Search Engine

AI search engine by Oxy; also the NativeWind 5 reference implementation (`packages/frontend` mirrors Mention frontend patterns).

## Monorepo Structure

```
packages/
  frontend/       @clarity/frontend     Expo app (React Native + Web) — NW5 reference
  backend/        @clarity/backend      Express backend API
  shared-types/   @clarity/shared-types Conversation/message/model DTOs, SSE event payloads, pagination
```

`shared-types` must NOT expose internal provider names — only Clarity-branded model identities.

## MongoDB Database Naming

Database name is `{appName}-{NODE_ENV}` (e.g., `clarity-production`). Pass `dbName` to `mongoose.connect()` — do NOT embed it in `MONGODB_URI`.

## Model Abstraction (CRITICAL)

Users and developers must ONLY see Clarity-branded model names. Never expose internal provider names or model IDs.

- **User-facing**: `clarity-fast`, `clarity-v1`, `clarity-pro`, `clarity-thinking`, `clarity-pro-max`
- **Never show**: provider names (OpenAI, Anthropic, Google, etc.) or provider model IDs in UI, API responses, errors, SEO, or docs
- Use `sanitizeMessage()` from `packages/backend/src/lib/errors/sanitize.ts` for all user-facing errors
- Analytics: resolve via `getClarityModel()` and skip entries that can't resolve

Key files:
- `packages/backend/src/internal/providers/lib/clarity-models.ts` — model definitions
- `packages/backend/src/internal/providers/lib/generate-model-mappings.ts` — provider routing
- `packages/backend/src/routes/v1/models.ts` — public models API (Clarity names only)
- `packages/backend/src/lib/errors/sanitize.ts` — strips provider names from errors
- `packages/backend/src/internal/` — all provider logic (internal, CORS-restricted)

## Search-First Architecture

- **Always search first** before answering factual questions
- **Source citations**: numbered references [1], [2], etc. for every factual claim
- **Deep research mode**: multi-step decomposition, parallel search, extraction, synthesis
- **Follow-up suggestions**: 3 related questions after each answer
- **SSE streaming**: all responses stream with custom events (`clarity.research_progress`, `clarity.reasoning`, `clarity.tool_result`, `clarity.title`, `clarity.follow_ups`, `clarity.source_card`)

## Oxy Service Connector

Same manifest-driven protocol as Alia. Apps register tool definitions in MongoDB → Clarity auto-discovers and exposes them to the AI.

Key files:
- `packages/backend/src/models/oxy-service.ts`
- `packages/backend/src/lib/tools/oxy-services.ts` (`buildOxyServiceTools`, `callOxyService`, `getOxyServiceContext`, `getOxyServicePromptFragment`)
- `packages/backend/src/routes/oxy-service-events.ts`
- `packages/backend/src/routes/v1/chat-completions.ts` (~line 615)
- Tool naming: `oxy_{serviceId}__{toolName}` (e.g. `oxy_inbox__searchEmails`)
- Auth: forward `req.accessToken` (user's OxyHQ JWT) — no OAuth needed for first-party services

## Backend Client (Pending Migration)

Backend uses a bespoke axios client (17+ call sites). Target pattern is `oxyServices.createLinkedClient({ baseURL })`. Do not add new local token providers or auth interceptors while this migration is pending.
