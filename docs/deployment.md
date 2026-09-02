# Deployment

No production deployment is performed or asserted by this migration branch.

## Required secrets and bindings

- `DATABASE_URL`: dedicated Clarity PostgreSQL database
- `CLARITY_ALIA_AGENT_ID`: real provisioned Clarity bot/agent record
- `ALIA_API_URL`: Alia product API origin
- Stripe secrets only when local product subscription checkout is enabled
- VAPID secrets only when browser push is enabled
- Redis/Valkey only for cache and burst limiting

Provider credentials are forbidden here. They live in Kaana's encrypted
PostgreSQL/KMS custody. A product/service credential is a different identity
boundary and must not be described as a provider key.

## Health contract

- `GET /health/live`: process is running.
- `GET /health/ready`: PostgreSQL is connected, the exact data snapshot has a
  `cutover` attestation, and the configured `CLARITY_ALIA_AGENT_ID` hashes to
  the exact agent identity recorded by that snapshot.

App Platform must use `/health/ready` as the readiness/deployment gate. A live
but unattested process is deliberately not production-ready. The same check is
enforced in front of every product HTTP route and every Socket.IO handshake, so
a direct origin cannot bypass load-balancer health.

## Before enabling traffic

1. Provision PostgreSQL and run all `pre` migrations with an exact target name.
2. Complete and reconcile the source inventory/backfill.
3. Provision the Clarity Oxy bot account and Alia agent; record their real IDs
   in the deployment secret system, never the repository.
4. Prove an authenticated Clarity turn reaches Alia, Oxy and Kaana with one
   correlation trail.
5. Prove deep research returns progress, tools and citations through the
   translated `clarity.*` stream.
6. Prove a Clarity subscription event updates local product entitlement and
   grants inference credit in Alia exactly once.
7. Attest the exact snapshot using the documented confirmation command.
8. Deploy and verify the running revision, image/spec, health payload and an
   authenticated live request.

Alia owns channel bot registrations and webhook validation. Clarity exposes
only the allowlisted Telegram/Discord token-check and user-link endpoints used
by its authorization screen. `EXPO_PUBLIC_TELEGRAM_BOT_USERNAME` is an optional
public link and stays blank until that canonical Alia channel bot is provisioned;
it is not a secret and no fallback username is invented.

The checked-in DigitalOcean/SST declarations are desired configuration, not
evidence that any live app currently matches them.
