# Clarity - Project Conventions

## Model Abstraction Architecture

**CRITICAL RULE: Users and developers must ONLY see Clarity-branded model names. Never expose internal provider names.**

### How it works

- **User-facing models**: `clarity-fast`, `clarity-v1`, `clarity-pro`, `clarity-thinking`, `clarity-pro-max`
- **Internal providers**: OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, and others. These are strictly internal and must never be exposed.
- **Routing**: Each Clarity model maps to multiple provider models with automatic fallback (cheapest/free tier first, then progressively more expensive).

### What to NEVER do

- Never show provider names (OpenAI, Anthropic, Google, Groq, etc.) in UI, API responses, error messages, SEO metadata, or documentation
- Never show provider model IDs (gpt-4o, claude-sonnet-4, gemini-2.5-flash, etc.) to users
- Never reference specific provider models in feature descriptions or marketing copy

### What to ALWAYS do

- Use Clarity model names: `clarity-v1`, `clarity-fast`, `clarity-pro`, `clarity-thinking`, etc.
- Use `sanitizeMessage()` from `packages/backend/src/lib/errors/sanitize.ts` for all user-facing error messages
- When displaying analytics/model usage, resolve to Clarity model names via `getClarityModel()` and skip entries that can't be resolved

### Key files

- `packages/backend/src/internal/providers/lib/clarity-models.ts` - Clarity model definitions
- `packages/backend/src/internal/providers/lib/generate-model-mappings.ts` - Provider routing config
- `packages/backend/src/routes/v1/models.ts` - Public models API (returns only Clarity models)
- `packages/backend/src/lib/errors/sanitize.ts` - Error message sanitization (strips provider names)
- `packages/backend/src/internal/` - All provider logic (internal only, CORS-restricted)

## MongoDB Database Naming

All Oxy ecosystem apps share the same MongoDB cluster on DigitalOcean. Each app uses its own database named `{appName}-{NODE_ENV}` (e.g., `clarity-production`). The `dbName` is passed to `mongoose.connect()`, not embedded in `MONGODB_URI`.

## Monorepo Structure

- `packages/frontend/` (`@clarity/frontend`) - Main Expo app (React Native + Web)
- `packages/backend/` (`@clarity/backend`) - Express backend API
- `packages/shared-types/` (`@clarity/shared-types`) - TypeScript types shared by frontend and backend (conversation/message/model DTOs, SSE event payloads, pagination). Imported via `@clarity/shared-types` on both sides. MUST NOT expose internal provider names — only Clarity-branded model identities.

## Tech Stack

- **Frontend**: Expo 55, React Native 0.83, TypeScript, NativeWind (Tailwind), Reanimated v4, Zustand, TanStack Query
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Socket.IO
- **Auth**: `@oxyhq/core ^3.11.0`, `@oxyhq/services ^11.1.0`, `@oxyhq/bloom ^0.19.1`, `@oxyhq/contracts ^0.3.0` (OxyProvider, useAuth, OxySignInButton)
- **Routing**: expo-router (file-based)

## Search-First Architecture

Clarity is an AI-powered search engine by Oxy. Key principles:
- **Always search first**: The AI searches the web before answering factual questions
- **Source citations**: Every factual claim includes numbered source references [1], [2], etc.
- **Deep research mode**: Multi-step research with decomposition, parallel search, extraction, synthesis
- **Follow-up suggestions**: After each answer, suggest 3 related follow-up questions
- **SSE streaming**: All search responses stream via Server-Sent Events with custom events (clarity.research_progress, clarity.reasoning, clarity.tool_result, clarity.title, clarity.follow_ups, clarity.source_card)

## Oxy SDK Conventions

- **Versions**: `@oxyhq/core ^3.11.0`, `@oxyhq/services ^11.1.0`, `@oxyhq/bloom ^0.19.1`, `@oxyhq/contracts ^0.3.0` (transitive via core). **3.11.0 / services 11.1.0:** self-sovereign identity layer (did:web, signed records, export, domain verify) + "Sign in with Oxy" (shared-keychain SSO + cross-device QR/deep-link handoff via `Commons by Oxy`). **Accounts is now keyless "Accounts by Oxy"** (management-only; identity creation moved to Commons). `@oxyhq/services ^11.0.0` was a packaging-only major — deps moved to peerDependencies; app must declare TanStack Query peers.
- **Media**: avatars/images resolve ONLY through `oxyServices.getFileDownloadUrl(id, variant)` + bloom's variant-aware `<Avatar source={fileId} variant="thumb">`. Never hardcode `cloud.oxy.so` or `/media/` URLs.
- **Display names**: render `name.displayName` directly (core 3.10 fixes the type under node resolution). No local name fallbacks.
- **Backend auth**: `@oxyhq/core/server` only — `createOxyAuthMiddleware`/`getRequiredOxyUserId`/`authSocket`. No local `requireAuth`, bearer parsers, or token-decoding middleware.
- **Socket.IO (CRITICAL)**: Socket.IO server MUST use `io.use(oxy.authSocket())` for authenticated namespaces + per-event ownership checks. Previously unauthenticated — this was a critical security fix; do not regress.
- **Backend client (flagged follow-up)**: bespoke axios client (17+ call sites) should be migrated to `oxyServices.createLinkedClient({ baseURL })`. Do not add new local token providers or auth interceptors while this is pending.

## Oxy Auth / Session Contract

- Frontend auth/session state belongs to `OxyProvider` with a registered `clientId`; SDK cold boot owns `/__oxy/sso-callback`, stored-session restore, FedCM/silent restore, and SSO bounce.
- Do not add local SSO helpers, callback routes, token providers, auth interceptors, manual `Authorization` plumbing, refresh retries, or app-local session invalidation.
- Backend APIs use `@oxyhq/core/server` (`createOxyAuthMiddleware`, `createOptionalOxyAuth`, `createOxyRateLimit`, `requireOxyAuth`, `getRequiredOxyUserId`, `authSocket`) and must not define local `AuthRequest`, `requireAuth`, `getUserId`, bearer parsers, or token-decoding middleware.
- Bearer-authenticated writes do not fetch app-local CSRF tokens; CSRF remains for ambient cookie credentials and cookie-only writes.

## Oxy Service Connector Protocol

Clarity integrates with Oxy ecosystem apps (and future third-party services) via the **Oxy Service Connector** — a manifest-driven protocol where apps register tool definitions that Clarity auto-discovers and exposes to the AI.

### How it works

1. **Service manifests** are stored in MongoDB (`OxyService` model). Each defines the service's tools, events, and optional context endpoint.
2. **`buildOxyServiceTools()`** reads manifests at chat time, generates AI SDK `tool()` wrappers with Zod schemas (via `jsonSchemaToZod()`), and forwards the user's OxyHQ JWT to the service API.
3. **Events** flow from services to Clarity via `POST /webhooks/oxy/:serviceId` with HMAC signature verification. Events trigger notifications, context updates, or autonomous agent sessions.
4. **Context endpoints** (optional) provide brief user summaries injected into the system prompt at chat start.

### Adding a new service

Insert an `OxyService` document — zero changes to Clarity's codebase needed:
```json
{
  "serviceId": "oxy-notes",
  "displayName": "Notes",
  "tools": [{ "name": "searchNotes", "endpoint": { "method": "GET", "path": "/notes/search" }, ... }]
}
```

### Key files

- `packages/backend/src/models/oxy-service.ts` - OxyService Mongoose model (manifest schema)
- `packages/backend/src/lib/tools/oxy-services.ts` - Tool builder (`buildOxyServiceTools`, `callOxyService`, `getOxyServiceContext`, `getOxyServicePromptFragment`)
- `packages/backend/src/routes/oxy-service-events.ts` - Event webhook endpoint
- `packages/backend/src/scripts/seed-oxy-services.ts` - Seed script for email service manifest
- `packages/backend/src/routes/v1/chat-completions.ts` - Integration point (~line 615)

### Patterns to follow

- Same `safeExecute()` + cache pattern as `integrations.ts` and `mcp.ts`
- Same `jsonSchemaToZod()` from `mcp-schema.ts` for runtime schema conversion
- Auth: forward `req.accessToken` (user's OxyHQ JWT) — no OAuth needed for first-party
- Tool naming: `oxy_{serviceId}__{toolName}` (e.g., `oxy_inbox__searchEmails`)
