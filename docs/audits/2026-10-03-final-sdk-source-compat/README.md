# Clarity candidate SDK compatibility

The accepted billing selection source at `10d880c6` is preserved. Source `dcb8bfd79921b3db5755f1bdb4fe9d1f28013a3b` migrates obsolete Bloom Button variants to the published 6.2.1 appearance/tone contract. The local Oxy candidate is `dca175d22`; these are not final registry locks.

The mapping follows Bloom `src/button/types.ts` and `docs/coherent-system-migration.mdx`: primary → solid/accent, secondary → outline/neutral, destructive → solid/danger, ghost → subtle, text/link → plain, outline → outline. Conditional plan emphasis keeps solid/accent for featured plans and outline/neutral otherwise. ConfirmationDialog exposes a tone internally; both destructive callers explicitly pass danger. Click handlers, disabled/loading conditions, text, and selected product IDs are preserved.

The initial typecheck reported 36 obsolete variant/type errors. After migration, strict frontend TypeScript, all 25 tests in four files, and Expo web export pass. The test suite covers existing product behavior; it is not a screenshot or native device check. Candidate manifests and the exact local lock are saved under `candidate-install`, separate from the production dependency files. No billing, authentication, agent routing, or provider semantics changed. Registry installation, final locks, visual device acceptance and deployment remain pending.

Commands: root shared build; `bunx --no-install tsc --noEmit -p packages/frontend/tsconfig.json`; `bun run --cwd packages/frontend test`; `EXPO_NO_DOTENV=1 bun run --cwd packages/frontend build`. The source and logs are hashed in `proof.json`.
