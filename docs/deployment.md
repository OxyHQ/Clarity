# Deployment

Clarity's backend deployment target is two ECS Fargate services in `us-west-2`:
`clarity-api` serves the API and `clarity-worker` runs crawl and indexing operations. Both use one
immutable ARM64 image from `oxy/clarity` in ECR. AWS resources, including RDS,
ECS, ALB, DNS targets, SSM bindings and IAM, are owned by `oxy-infra`.

The frontend is deployed to a Cloudflare Worker by `.github/workflows/deploy.yml`
and is reachable at `https://clarity.surf`. That workflow remains independent of
the backend workflow. Like it, it runs only after Clarity's `CI` workflow
succeeds on a push to `main`, and only when something the web build reads
(`packages/frontend`, `packages/shared-types`, `packages/sdk`, the root
manifests and config, or the workflow itself) changed since the last commit it
deployed (`.github/scripts/deploy-scope.sh`). The API origin is
`https://api.clarity.surf`.

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
succeeds on a push to `main`, and releases that commit unless a newer `main`
commit has a CI run of its own that will release it instead
(`require-current-main.sh`). It builds one digest-pinned image,
applies `pre` migrations, rolls out and verifies the API, applies `post`
migrations, performs external health checks, then deploys the worker. Concurrent
production rollouts are serialized and never cancelled in progress.

The first empty database is a separate genesis operation from inside the VPC:
run the image migrator once with `--target-database=clarity --phase=all` before
starting either service. Ordinary releases then use the workflow's `pre` and
`post` phases. The workflow deliberately fails if either ECS service is absent
or parked at zero; infrastructure creation and intentional scaling are not
silently treated as successful application deployments.

The image runs on Bun: `packages/backend/Dockerfile` builds and runs on
`oven/bun:1.4.3-slim`, its CMD is `bun packages/backend/dist/index.js`, the
migrator one-shots in `deploy-aws.yml` run `bun packages/backend/dist/db/migrate.js`,
and `clarity-worker`'s command in oxy-infra (`terraform-uswest2/app-clarity.tf`)
runs `bun packages/backend/dist/worker.js`. CI's `Build backend image` job boots
the built ARM64 image against Postgres (`.github/scripts/smoke-backend-image.sh`)
and `check:backend-entrypoints` executes the built bundles under Bun. The image
has no Node: its `node` is a symlink to Bun. To return to Node, revert the change
that made the switch; the restored Node image still carries Bun, so the
worker's `bun` command keeps working across that revert.

The runtime user `bun` (uid 1000) can write nothing under `/app`. The code and
`node_modules` are root-owned, and the only file any command writes is the
migrator's scratch journal under `os.tmpdir()` (`/tmp`). The same smoke asserts
this with `find -writable` and with `docker diff` after the migrator, the worker
and the API have run. It also asserts that the runtime `node_modules` carries
no Expo, React Native or devDependency.

The SearXNG sidecar image (`packages/searxng`) runs as upstream's `searxng`
user (uid 977). It keeps its settings in `/var/lib/searxng`, outside the
image's VOLUMEs, so a runtime that mounts a VOLUME as an empty root-owned
directory cannot stop it from starting. CI's `Build SearXNG image` job
(`.github/scripts/smoke-searxng-image.sh`) proves this on fresh, root-owned
tmpfs and root-owned bind-mounted volumes. Moving it out of the API's task is
proposed in `docs/searxng-own-service.md`.

## Required secrets and bindings

Every runtime secret lives only in SSM Parameter Store under `/oxy/clarity/`
(SecureString) or the oxy-infra-owned `/oxy/_shared/`, and the task definitions
read it at task start. Its owner sets or rotates it with
`aws ssm put-parameter --overwrite` (oxy-infra runbook 46); GitHub holds only CI
tokens, and no workflow writes SSM. A new secret is written to SSM FIRST, then
named in the task definition: a task naming a missing parameter fails at start.

- `DATABASE_URL`: dedicated Clarity PostgreSQL database
- No Oxy key pair. Both ECS services run the dedicated `oxy-clarity-task` role
  and attest it (oxy ADR 0026): the task signs an STS `GetCallerIdentity`
  request, Oxy replays it and mints the service token. That token carries the
  workload's stable handle `wl_1553bb11eb957512b3cdc956` as `credentialId`, and
  it is the only value `clarity-service-auth.ts` accepts. The former backend
  credential `01a0648b-8d74-7240-adba-80707fdfdf9c` and its
  `/oxy/clarity/OXY_SERVICE_API_*` pair are retired: a process that still
  receives `OXY_SERVICE_API_SECRET` fails readiness, and a leftover
  `OXY_SERVICE_API_KEY` must still be exactly the backend client id. A local
  checkout has no role to attest and cannot reach Oxy as Clarity.
- Stripe secrets only when local product subscription checkout is enabled
- VAPID secrets only when browser push is enabled
- Redis/Valkey only for cache and burst limiting

Provider credentials are forbidden here. They live in Kaana's encrypted
PostgreSQL/KMS custody. A product/service credential is a different identity
boundary and must not be described as a provider key. Kaana's only canonical
signed origin is `https://kaana.ai`; neither Clarity nor Alia may substitute an
`oxy.so` alias.

The exact deployment identity is: project account
`01a0646a-078f-7f53-848d-a0f82d9f7fa6`, backend app
`01a0648b-8d73-70ad-8e67-1c07ddc5eb6e`, and backend task role
`arn:aws:iam::237343248947:role/oxy-clarity-task`. Match primary keys byte for
byte and never discover or rebind them by name, list order or fallback. The
public sign-in app `01a0646a-2382-74a3-a795-788924d55722` remains separate and
has only `user:read`. The backend's token carries exactly `user:read`,
`inference:invoke` (search embeddings), `catalogs:write` with the application
capability `catalog:clarity`, `capabilities:read` and `capability-audit:write`;
`clarity-service-auth.ts` refuses any other set. The Clarity agent is Alia's
(see [Clarity's assistant](assistant)); no deployment value names it.

## Health contract

- `GET /health/live`: process is running.
- `GET /health/ready`: PostgreSQL is connected, the data snapshot has a
  `cutover` or `fresh_install` attestation, and the process can attest its
  backend service identity.

The ALB must use `/health/ready` as the readiness/deployment gate. A live
but unattested process is deliberately not production-ready. The same check is
enforced in front of every product HTTP route and every Socket.IO handshake, so
a direct origin cannot bypass load-balancer health.

## Hosts

- `api.clarity.surf` — the API, and `POST /_oxy/mcp` (Alia's lane onto the
  capability catalogue).
- `mcp.clarity.surf` — the public OAuth MCP (`/mcp`,
  `/.well-known/oauth-protected-resource`), served by the same `clarity-api`
  service. It needs its own ACM certificate (validated in the `clarity.surf`
  Cloudflare zone), a listener certificate on the shared HTTPS listener, the
  host header on Clarity's listener rule, and a DNS-only CNAME, all in
  oxy-infra. The service refuses (421) an MCP request that reaches it on any
  other host.

## Before enabling traffic

1. Provision PostgreSQL and run the genesis `all` migration with the exact
   `clarity` target name from a one-shot task inside the VPC.
2. Complete and reconcile the source inventory/backfill, or attest a fresh
   install.
3. Grant the backend application its five scopes and `catalog:clarity`, and
   verify a minted token's scope set, app, credential handle and owner.
4. Deploy, then confirm in the API log that the capability catalogue registered
   (`Clarity internal MCP bound to its catalogue registration`).
5. Verify the running revision, image/spec, health payload and an
   authenticated live request.
6. Once no previous image remains, run and re-run the `post` migrations.

The application workflow never owns or copies the Oxy credential. Its SSM
binding belongs to `oxy-infra` and Oxy's credential provisioning path. Do not
enable traffic until an operator reads back the live ECS task definition and
SSM metadata, resolves every referenced secret, verifies the running image
digest, and passes the readiness and canary checks above.
