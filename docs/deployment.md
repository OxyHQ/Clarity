# Deployment

No production deployment is performed or asserted by this migration branch.

The frontend is deployed to Cloudflare Pages by `.github/workflows/deploy.yml`
and is currently reachable at `https://clarity.surf`. The App Platform and SST
declarations cover only the product API at `https://api.clarity.surf`; they do
not declare a second frontend or an unused Spaces bucket.

## Required secrets and bindings

- `DATABASE_URL`: dedicated Clarity PostgreSQL database
- `CLARITY_ALIA_AGENT_ID`: real provisioned Clarity bot/agent record
- `ALIA_API_URL`: Alia product API origin
- `OXY_SERVICE_API_KEY`: exact public client ID of the Clarity backend app
- `OXY_SERVICE_API_SECRET`: provider-managed DigitalOcean App Platform secret;
  its value is never checked into source or supplied as a plain deployment value
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

App Platform must use `/health/ready` as the readiness/deployment gate. A live
but unattested process is deliberately not production-ready. The same check is
enforced in front of every product HTTP route and every Socket.IO handshake, so
a direct origin cannot bypass load-balancer health.

## Before enabling traffic

1. Provision PostgreSQL and run all `pre` migrations with an exact target name.
2. Complete and reconcile the source inventory/backfill.
3. Reconcile the checked-in bootstrap manifest into Alia: exact bot/agent IDs,
   backend-app binding, `prompts/base.md` hash and exactly the grants `web`,
   `artifacts`, `memory`.
4. Populate the backend service secret in DigitalOcean App Platform and verify
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

Both checked-in deployment declarations mark `OXY_SERVICE_API_SECRET` as a
provider-managed `SECRET` without embedding its value. That declaration does
not prove the live app has been populated. Do not enable traffic until an
operator reads back the secret binding metadata and the readiness/canary checks
above pass.
