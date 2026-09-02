# Clarity frontend

Expo app for web, iOS, and Android. The app presents Clarity product model IDs
and consumes Clarity's API; it does not call inference providers or Kaana
directly.

## Runtime boundaries

- Chat streams from `/v1/chat/completions`. The Clarity API fixes the
  provisioned Alia agent and translates Alia events to `clarity.*` events.
- Conversations, product plans, entitlements, suggestions, feedback, and
  notifications are Clarity PostgreSQL resources.
- Memory, agent audit, trigger execution, inference credits, and inference
  telemetry are Alia resources reached through explicit Clarity API routes.
- Agent permission editing remains unavailable until Alia publishes an
  agent-scoped settings contract; the UI states that limitation instead of
  pretending to save unsupported fields.

## Existing screens

- `app/(app)/index.tsx` — new conversation
- `app/(app)/c/[id]/index.tsx` — conversation
- `app/(app)/history.tsx` — history
- `app/(app)/notifications.tsx` — notification feed
- `app/(app)/settings/*` — account, general, usage, personalization, security,
  and feedback

The API exposes authenticated Alia trigger routes for compatibility, but this
checkout has no trigger-management screen. Webhook delivery uses the Alia URL
returned when a trigger is created.

## Development

```bash
bun run dev:frontend
```

From this package:

```bash
bun start
bun run web
bun run ios
bun run android
```

API configuration lives in `lib/config.ts`; the production product API is
`https://api.clarity.oxy.so`.
