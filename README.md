<h1 align="center">Clarity</h1>

<p align="center">
  An AI search engine by Oxy: cited answers, deep research, and agents that keep working after the answer.
</p>

<p align="center">
  <a href="https://clarity.surf"><img alt="clarity.surf" src="https://img.shields.io/badge/live-clarity.surf-440151?style=flat-square"></a>
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.3-440151?style=flat-square&logo=bun&logoColor=white">
  <img alt="Expo" src="https://img.shields.io/badge/Expo-57-440151?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native" src="https://img.shields.io/badge/React%20Native-0.86-440151?style=flat-square&logo=react&logoColor=white">
  <img alt="NativeWind" src="https://img.shields.io/badge/NativeWind-5-440151?style=flat-square&logo=tailwindcss&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-440151?style=flat-square&logo=typescript&logoColor=white">
</p>

<p align="center">
  <b>Search first, then answer.</b><br>
  Every factual claim carries a numbered source. Deep research decomposes the question,<br>
  searches in parallel, extracts, and synthesises, streaming the whole thing as it goes.
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### 🔎 One app, every platform

`packages/frontend` is a single Expo codebase that ships to web, iOS and Android. React Native Web renders the same components in the browser that run on device, so there is no second web build to keep in sync.

It is also the Oxy ecosystem's **NativeWind 5 reference implementation**. When a styling pattern is in question elsewhere, this is the tree to copy from.

</td>
<td valign="top" width="50%">

### 🧠 Models you never have to choose between

Clarity routes across several providers internally, but the surface is deliberately its own: `clarity-fast`, `clarity-pro`, `clarity-pro-max`, `clarity-thinking`.

Provider names and provider model IDs never reach the UI, the API, an error message, or the docs. Errors are sanitised on the way out.

</td>
</tr>
</table>

## Packages

| Package | What it is |
|---|---|
| [`@clarity/frontend`](packages/frontend/) | The Expo app for web, iOS and Android. Expo Router, NativeWind 5, [`@oxyhq/bloom`](https://www.npmjs.com/package/@oxyhq/bloom) for tokens and primitives |
| [`@clarity/backend`](packages/backend/) | The Express 5 API. MongoDB via Mongoose, Redis via ioredis, Socket.IO with the Redis adapter, Stripe for billing, and the multi provider AI layer |
| [`@clarity/shared-types`](packages/shared-types/) | Conversation, message and model DTOs, SSE event payloads, pagination. Built before the other two |

Identity comes from the Oxy platform: [`@oxyhq/services`](https://www.npmjs.com/package/@oxyhq/services) in the app, [`@oxyhq/core`](https://www.npmjs.com/package/@oxyhq/core) on both sides, and [`@oxyhq/contracts`](https://www.npmjs.com/package/@oxyhq/contracts) for shared schemas. See [github.com/OxyHQ/oxy](https://github.com/OxyHQ/oxy).

## Quick start

```bash
bun install
bun run dev            # every workspace at once
```

Or one side at a time:

```bash
bun run dev:frontend   # Expo
bun run dev:backend    # Express, watch mode
```

You will need Node 22, a MongoDB instance, and optionally Redis (the backend degrades gracefully without it). Copy `packages/backend/.env.example` to `packages/backend/.env` and fill it in first. Full setup notes are in [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary><b>All workspace scripts</b></summary>

<br>

```bash
bun run build              # shared-types, then backend, then frontend
bun run build:frontend     # web export
bun run build:backend
bun run build:shared-types
bun run start:frontend
bun run start:backend
bun run lint
bun run web                # Expo on web
bun run ios                # Expo on iOS
bun run android            # Expo on Android
```

The build order is not cosmetic: both the app and the API import `@clarity/shared-types` from `dist/`, so it has to be compiled first.

</details>

<details>
<summary><b>Streaming events</b></summary>

<br>

Responses stream over SSE with named events, so the client can render progress rather than a spinner:

| Event | Fires when |
|---|---|
| `clarity.reasoning` | The model is thinking out loud |
| `clarity.research_progress` | A deep research step starts or finishes |
| `clarity.tool_result` | A tool call returns |
| `clarity.agent` | An agent takes a turn |
| `clarity.approval_request` | An action needs the user to say yes |
| `clarity.approval_result` | That answer comes back |
| `clarity.model_switch` | Routing moves the conversation to another Clarity model |
| `clarity.oxy` | An Oxy service connector emits |
| `clarity.title` | The conversation gets its title |

</details>

<details>
<summary><b>Documentation</b></summary>

<br>

| Document | Covers |
|---|---|
| [`docs/index.mdx`](docs/index.mdx) | Start here |
| [`docs/api-reference.md`](docs/api-reference.md) | REST surface |
| [`docs/chat-api.mdx`](docs/chat-api.mdx) | The streaming chat endpoint |
| [`docs/model-abstraction.mdx`](docs/model-abstraction.mdx) | Why provider names never leak, and how routing works |
| [`docs/memory-system.md`](docs/memory-system.md) | What Clarity remembers between conversations |
| [`docs/proactive-intelligence.md`](docs/proactive-intelligence.md) | Triggers and agents that act without being asked |
| [`docs/oxy-service-connector.mdx`](docs/oxy-service-connector.mdx) | How other Oxy apps register tools that Clarity discovers |
| [`docs/agents.md`](docs/agents.md) | The agent runtime |
| [`docs/oxyhq-auth.md`](docs/oxyhq-auth.md) | Authentication through Oxy |
| [`docs/onboarding.md`](docs/onboarding.md) | First run experience |
| [`docs/developers-portal.md`](docs/developers-portal.md) | Building against Clarity |
| [`docs/deployment.md`](docs/deployment.md) | Shipping it |

Release history lives in [CHANGELOG.md](CHANGELOG.md).

</details>

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Two rules matter more than the rest: a factual claim without a citation is a bug, and a provider name reaching a user is a bug.

<br>

<div align="center">
<sub><a href="https://clarity.surf">clarity.surf</a> · built by <a href="https://oxy.so">Oxy</a></sub>
</div>
