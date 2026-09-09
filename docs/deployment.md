# Deployment

Clarity's backend deployment target is two ECS Fargate services in `us-west-2`:
`clarity-api` serves the API and `clarity-worker` runs crawl and indexing operations. Both use one
immutable ARM64 image from `oxy/clarity` in ECR. AWS resources, including RDS,
ECS, ALB, DNS targets, SSM bindings and IAM, are owned by `oxy-infra`.

The frontend is deployed to a Cloudflare Worker by `.github/workflows/deploy.yml`
and is reachable at `https://clarity.surf`. That workflow remains independent of
the backend workflow. The API origin is `https://api.clarity.surf`.

It is a Worker rather than a Pages project because a Pages project always serves
`<project>.pages.dev` and Cloudflare offers no way to switch that off, which put
a second copy of the app on a hostname that `PRODUCTION_ORIGINS` does not admit.
`packages/frontend/wrangler.toml` declares `workers_dev = false`, the `./dist`
assets, the SPA fallback and `clarity.surf` as a custom domain, so a deploy
cannot disagree with the config. `packages/frontend/worker/index.js` is the
Worker script: the SPA fallback answers any miss with `index.html`, and that
script returns a real 404 for a missing hashed bundle instead of `text/html` a
browser would reject.

`.github/workflows/deploy-aws.yml` runs only after Clarity's `CI` workflow
succeeds for the current `main` commit. It builds one digest-pinned image,
applies `pre` migrations, rolls out and verifies the API, applies `post`
migrations, performs external health checks, then deploys the worker. Concurrent
production rollouts are serialized and never cancelled in progress.

The first empty database is a separate genesis operation from inside the VPC:
run the image migrator once with `--target-database=clarity --phase=all` before
starting either service. Ordinary releases then use the workflow's `pre` and
`post` phases. The workflow deliberately fails if either ECS service is absent
or parked at zero; infrastructure creation and intentional scaling are not
silently treated as successful application deployments.

## Required secrets and bindings

- `DATABASE_URL`: dedicated Clarity PostgreSQL database
- `CLARITY_ALIA_AGENT_ID`: real provisioned Clarity bot/agent record
- `ALIA_API_URL`: Alia product API origin
- `OXY_SERVICE_API_KEY`: exact public client ID of the Clarity backend app
- `OXY_SERVICE_API_SECRET`: Oxy-provisioned SSM secret; its value is never
  checked into source or exposed to the deployment runner
- Stripe secrets only when local product subscription checkout is enabled
- VAPID secrets only when browser push is enabled
- Redis/Valkey only for cache and burst limiting

Provider credentials are forbidden here. They live in Kaana's encrypted
PostgreSQL/KMS custody. A product/service credential is a different identity
boundary and must not be described as a provider key. Kaana's only canonical
signed origin is `https://kaana.ai`; neither Clarity nor Alia may substitute an
`oxy.so` alias.

The exact deployment identity is: project/payer
`01a0646a-078f-7f53-848d-a0f82d9f7fa6`, bot account
`01a0646a-078f-7120-a993-a03c180c81b0`, private Alia agent
`01a0646a-078f-7642-95ef-439952f4f3f9`, backend app
`01a0648b-8d73-70ad-8e67-1c07ddc5eb6e`, and backend credential
`01a0648b-8d74-7240-adba-80707fdfdf9c`. Match primary keys byte for byte and
never discover or rebind them by name, list order or fallback. The public
sign-in app `01a0646a-2382-74a3-a795-788924d55722` remains separate and has
only `user:read`; it must never authenticate backend inference.

## Health contract

- `GET /health/live`: process is running.
- `GET /health/ready`: PostgreSQL is connected, the exact data snapshot has a
  `cutover` attestation, `CLARITY_ALIA_AGENT_ID` matches the canonical agent
  byte for byte, and the exact backend service credential is configured.

The ALB must use `/health/ready` as the readiness/deployment gate. A live
but unattested process is deliberately not production-ready. The same check is
enforced in front of every product HTTP route and every Socket.IO handshake, so
a direct origin cannot bypass load-balancer health.

## Before enabling traffic

1. Provision PostgreSQL and run the genesis `all` migration with the exact
   `clarity` target name from a one-shot task inside the VPC.
2. Complete and reconcile the source inventory/backfill.
3. Reconcile the checked-in bootstrap manifest into Alia: exact bot/agent IDs,
   backend-app binding, `prompts/base.md` hash and exactly the grants `web`,
   `artifacts`, `memory`.
4. Provision the backend service credential into `/oxy/clarity/` in SSM and verify
   its minted token has
   only `user:read` + `inference:invoke`, the fixed backend app/credential IDs,
   and the Clarity project as `ownerAccountId`.
5. Prove an authenticated Clarity turn reaches Alia, Oxy and Kaana with one
   correlation trail.
6. Prove deep research returns progress, tools and citations through the
   translated `clarity.*` stream.
7. Prove a Clarity subscription event updates local product entitlement and
   grants inference credit in Alia exactly once.
8. Attest the exact snapshot using the documented confirmation command.
9. Deploy and verify the running revision, image/spec, health payload and an
   authenticated live request.
10. Once no previous image remains, run and re-run the `post` migrations that
    remove the retired per-conversation agent metadata.

Alia owns channel bot registrations and webhook validation. Clarity exposes
only the allowlisted Telegram/Discord token-check and user-link endpoints used
by its authorization screen. `EXPO_PUBLIC_TELEGRAM_BOT_USERNAME` is an optional
public link and stays blank until that canonical Alia channel bot is provisioned;
it is not a secret and no fallback username is invented.

The application workflow never owns or copies the Oxy credential. Its SSM
binding belongs to `oxy-infra` and Oxy's credential provisioning path. Do not
enable traffic until an operator reads back the live ECS task definition and
SSM metadata, resolves every referenced secret, verifies the running image
digest, and passes the readiness and canary checks above.
