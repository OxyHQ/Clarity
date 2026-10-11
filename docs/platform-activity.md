# Ecosystem activity

Each deployed API process publishes bounded activity aggregates to Oxy, whether
or not anyone has opened the dashboard. HTTP middleware observes requests and
completed responses, including errors; the shared outgoing observer covers fetch
and Node HTTP clients. Requests and responses have independent directions.
Socket.IO application events and observed raw WebSocket messages are counted
separately from HTTP. Ping/pong frames and Socket.IO acknowledgements are not
application events.

The publisher sends only service identities, infrastructure regions, coarse edge
PoPs, direction, scope, category and aggregate counts. It never sends payloads,
paths, query strings, IPs, user IDs, credentials or socket IDs. A Cloudflare PoP
is a network ingress location, not a visitor's physical location.

`OXY_ECOSYSTEM_ACTIVITY_ENABLED=true` explicitly enables the deployed producer; it is disabled by default. Keep it false in local environments, even when using AWS storage.

`AWS_REGION` supplies the process location. Publication authenticates with the
same Clarity service token as every other Oxy call, which deployed tasks obtain
by attesting their ECS task role rather than from `OXY_SERVICE_API_SECRET`. Enabled producer configuration is validated before
listening. Each process registers a fresh instance, refreshes its lease,
and removes it during graceful shutdown. Crashed instances disappear when their
lease expires. Oxy broadcasts authoritative snapshots over Socket.IO.

Counters describe observed application operations, not network bytes. Direct
object-storage downloads, media transports, database wire protocols and third
party runtime internals require instrumentation at their owning services.

## Web traffic

Oxy measures the `clarity.surf` frontend's traffic keylessly, from Cloudflare's
own analytics (see OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`). The
frontend Worker holds no Oxy activity secret and runs no activity code; it only
fixes asset 404s ahead of the ASSETS binding.

The `OXY_EDGE_ACTIVITY_*` Worker bindings were never provisioned and nothing
reads them now. An operator who finds one on a deployment can delete it.

## Package versions

Core and contracts are aligned through workspace overrides so browser and server packages share one version. The frontend Worker's asset handling is checked by `scripts/frontend-worker.test.mjs` (`node --test`).
