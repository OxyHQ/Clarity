# Product boundaries

The full ownership and datastore rules moved here from `AGENTS.md`. Each is checkable and enforced by review or by the gates named inline.

- PostgreSQL/Drizzle is the only Clarity datastore. Do not add another database
  driver, fallback, connection string, compatibility reader, or dual write.
- Clarity owns its product: search and indexing, Jobs, places, market, news,
  Experience, suggestions, notifications, feedback, the plan catalogue,
  subscriptions and entitlements.
- Alia owns the assistant: the Clarity agent (prompt, character, families,
  feature gates), its conversations, memory, deep research, credits
  and checkout, usage, audit, triggers and channel bots. **The backend never
  calls Alia** — no proxy, no relay of a person as a header, no agent id, no
  product-paid chat. Never re-add a Clarity conversation table, a Clarity stream
  or a backend chat route. Clarity's interface IS the product, so the search page
  is Clarity's own (`components/chat-page-content.tsx`), drawn over Alia's
  conversation runtime (`useConversationThread` from `@alia.onl/sdk`, opened with
  Clarity's agent, `hooks/useChatConversation.ts`) under the person's own
  session — the runtime owns streaming and storage, Clarity owns every pixel.
- Alia reaches Clarity only through the capability catalogue
  (`packages/backend/src/capabilities/`): one tool per person action, calling
  the same use case as its route. The account a tool acts as comes ONLY from
  the verified ticket (`effectiveAccountId`) or OAuth connection
  (`activeAccountId`); input never names an account. Both MCP lanes mount
  before CORS, body parsers and readiness. Bump the catalogue `version` with
  any tool change. What has no tool is written in `capabilities/exclusions.ts`.
- Plans unlock Alia features through feature gates: catalogue `features` answered
  from plan features (`deep-research`, `power-level-<level>`). The person's Alia
  credits pay for inference; Clarity never does.
- No agent asks for approval; never add a confirmation step to a tool.
- Oxy authorizes and orders exact inference routes. Kaana owns adapters,
  provider credentials and execution/failover within that signed order. No
  provider credential, adapter, routing table or direct provider endpoint
  belongs here.
- The canonical IDs live in `packages/backend/src/lib/clarity-identity.ts`.
  Match them byte for byte; do not trim, normalize, discover by name/list/order,
  or accept client rebinding. The backend token must identify the exact backend
  app, workload handle and project owner; own authority never depends on scopes
  (`docs/first-party-platform.md`).
- Clarity Jobs indexes PUBLIC job postings. No applicant tracking, CV store,
  candidate profile or application data in Jobs, and no route that could disclose a
  named user to an employer — Jobs catalogue tools never receive the effective
  account. Never present Clarity as the employer or source of a listing it only
  indexed.
- Clarity Experience owns user-published personal work history, edited through
  the user session from Clarity or Mention. Keep its storage and APIs separate
  from Jobs, search, ranking and employer-facing candidate discovery.
- No commercial signal — payment, subscription tier, ad spend, licensing tier,
  Mercaria or Mention engagement — may reach job ranking, in any weighting.
  `src/search/jobs/__tests__/ranking-contract.test.ts` enforces this
  structurally; extend it rather than working around it.
- `jobs` means employment. Asynchronous crawl/index work is an *operation*
  (`clarity.operations`, `/v1/operations/:id`).

Search embeddings are the one direct Kaana call: `@kaana.ai/sdk` to
`https://kaana.ai/v1` with the `kaana.ai` service token, only when
`CLARITY_EMBEDDINGS_ENABLED=true` (`src/lib/kaana-embeddings.ts`). Never a
hand-built Kaana URL, `/internal/`, or an `oxy.so` inference route.

Platform credentials such as Stripe, VAPID, Valkey and Oxy identity are not
inference-provider credentials. Keep that distinction in architecture gates.
