# Clarity frontend

Expo app for web, iOS, and Android. It calls Clarity's API for Clarity's own
product and Alia, through `@alia.onl/sdk`, for the conversation. It never calls
inference providers or Kaana directly.

## Runtime boundaries

- The search page is Clarity's own: the landing, the composer and its modes, the
  answer with its sources and citations, research progress, reasoning and the
  power level (`components/chat-page-content.tsx`, `components/chat-interface.tsx`).
  The conversation under it is Alia's: `useConversationThread` from
  `@alia.onl/sdk` (`hooks/useChatConversation.ts`, configured by
  `components/chat/clarity-chat-runtime.tsx`) streams and stores it with
  Clarity's agent, an ordinary public Alia agent confined to Clarity
  (`lib/clarity-agent.ts`), under the person's own Oxy session; the person's
  Alia credits pay for it. History is Alia's list of conversations with that
  agent (`useConversations({ agentId })`).
- The app's one "Ask" sheet (`components/chat/clarity-ask-provider.tsx`) opens
  Alia or Clarity's agent from anywhere.
- Clarity's catalogue tools draw with Clarity's own cards, keyed `clarity:<tool>`
  (`components/chat/clarity-tool-renderers.tsx`). A locked feature gate
  (`deep_research`, `power_level.<level>`, `attachments.*`) opens the subscribe
  screen.
- Plans, subscriptions, suggestions, feedback, notifications, experience, jobs,
  news and market quotes are Clarity's, from Clarity's API.
- Credits and usage, memory, channel bots and the agent audit are Alia's and are
  managed in Alia (`components/settings/alia-settings-links.tsx`).

## Existing screens

- `app/(app)/index.tsx` — Clarity's search page; the first search creates the conversation
- `app/(app)/c/[id]/index.tsx` — a conversation
- `app/(app)/history.tsx` — the conversations with Clarity's agent
- `app/(app)/discover.tsx`, `jobs/*`, `finance.tsx` — Discover, Jobs, Finance
- `app/(app)/notifications.tsx` — notification feed
- `app/(app)/settings/*` — account, general, billing, experience and feedback

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
`https://api.clarity.surf`. This source declaration does not prove that DNS or
a production API deployment exists.
