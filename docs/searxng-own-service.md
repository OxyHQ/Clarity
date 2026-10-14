# SearXNG as its own ECS service (proposal)

Status: proposal. Nothing here is applied. The infrastructure lives in
`oxy-infra` (`terraform-uswest2/app-clarity.tf`), and every step below that
touches it is an oxy-infra change for its owner to make.

## Where it runs today

SearXNG (`packages/searxng`) is a non-essential sidecar in the `clarity-api`
task. It parses untrusted HTML from arbitrary web pages. Inside that task it
shares everything the API has:

- **The task role.** Every container in a task gets the same
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, and the ECS credentials endpoint
  (169.254.170.2) answers any process in the task, whatever its uid. The role,
  `oxy-clarity-task`, has no IAM policy, but it is not powerless. Oxy's
  attestation (oxy ADR 0026) binds that role to Clarity's application
  (`01a0648b-8d73-70ad-8e67-1c07ddc5eb6e`). The task signs an STS
  `GetCallerIdentity` request with the role's credentials, and Oxy turns it into
  a service token with `user:read` and `inference:invoke`. Code execution in
  SearXNG can therefore mint Clarity's Oxy service token: it can read users and
  spend inference as Clarity. Running SearXNG as a non-root user does not
  change this, because the endpoint is a network endpoint and not a file.
- **The loopback.** It can reach the API on `127.0.0.1:3001` from behind the
  ALB, and the OTel collector on `:4318` when that is enabled.
- **The ENI and the shared `tasks` security group.** RDS and Valkey admit that
  group, and so does port 3000 on every other service in the cluster. SearXNG
  has none of the database or Valkey credentials, which are injected only into
  the `clarity-api` container. It does have the network path.

A separate task with no task role, behind its own security group, removes all
three.

## Proposed shape

| Piece | Proposal |
|---|---|
| Service | `clarity-searxng`: an ECS Fargate service in `oxy-cluster`, private subnets, `assign_public_ip = false`, `desired_count = 2` across AZs, deployment circuit breaker with rollback. 0.25 vCPU / 512 MB each (the sidecar reserves 256 MB today). |
| Task role | **None.** With no `task_role_arn`, ECS serves no credentials to the task. If a role is ever needed, create a dedicated one with no policies that is never bound to an Oxy application. |
| Execution role | A dedicated `oxy-clarity-searxng-execution`: ECR pull on `oxy/clarity-searxng` only, and logs on the `clarity-searxng/*` stream prefix. No SSM. It does not reuse `oxy-clarity-execution`, which can read Clarity's runtime secrets. |
| Security group | A new `clarity-searxng` SG. Ingress: TCP 8080 only from a new `clarity-api` SG (below). Egress: 443 and 80 to `0.0.0.0/0` (the engines, through NAT, plus ECR and Logs). It is NOT in the shared `tasks` group, so RDS, Valkey and every service's port 3000 drop its traffic. |
| Caller SG | A new `clarity-api` SG with no rules of its own, attached to the `clarity-api` service **in addition** to `tasks`. It exists so the SearXNG SG can name exactly one caller. `tasks` is shared by every service in the cluster, so admitting `tasks` would let all of them in. The crawler worker does not call SearXNG and does not get it. |
| Reachability | Cloud Map, as the cluster already does for CrowdSource and GoWay routing (`service-discovery.tf`): namespace `clarity.internal.oxy.so`, service `searxng`, MULTIVALUE A records with a 15 s TTL. The API's `CLARITY_SEARXNG_URL` becomes `http://searxng.clarity.internal.oxy.so:8080`. |
| Listen address | The image keeps `GRANIAN_HOST=127.0.0.1` as its default, which is right for the sidecar. The service's task definition sets `GRANIAN_HOST=0.0.0.0`, so the image does not change. The security group, not the bind address, is then what limits callers. |
| Health | The same container health check as today (`/healthz` through the venv's Python). Cloud Map registers only healthy tasks. |
| Image | Unchanged: the reviewed `clarity-searxng` recipe, non-root (`searxng`, uid 977), settings outside the image VOLUMEs. `deploy-aws.yml` already builds it and gets its digest. |

### Why Cloud Map and not an internal ALB

- **Cost.** An internal ALB costs about USD 16 a month plus LCUs. Cloud Map
  costs nothing at runtime, and an ALB in front of a single caller buys nothing
  that a health-checked DNS record does not.
- **What an ALB would add.** It could terminate TLS. Today the queries cross
  the VPC in plaintext HTTP (see the trade-offs below), and an ALB with an ACM
  certificate is the simplest way to change that later if it is wanted.
- **Not Service Connect.** It injects a proxy container into every task, and
  this account is close to its Fargate vCPU quota. `service-discovery.tf`
  rejects it for the same reason.

## Trade-offs

- **Isolation (the point).** A SearXNG compromise gets no AWS credentials and
  no Oxy service token. It cannot reach the API's loopback, RDS, Valkey or
  any other service, and it can talk only to the internet.
- **Cost and quota.** About +0.5 vCPU and +1 GB for two tasks. Today the
  sidecar fits inside the API task's existing 512 CPU / 1024 MB.
- **Latency.** Loopback becomes one VPC hop, under a millisecond in-AZ and
  about a millisecond cross-AZ. That is negligible against the 3 s engine
  timeout and the API's 5 s discovery budget.
- **Plaintext in the VPC.** User search terms go from the API to SearXNG over
  HTTP inside the VPC instead of over loopback. The SG limits who can connect,
  but anyone who can capture VPC traffic could read them. If that matters,
  front the service with an internal ALB and TLS, or terminate TLS in the
  container.
- **DNS caching.** Bun caches DNS answers for 30 s by default
  (`BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS`), longer than the 15 s record TTL. A
  replaced task may still be asked for up to about 45 s. Discovery already
  fails open on a timeout, and the circuit breaker plus two tasks keep that
  rare.
- **Independent lifecycle.** SearXNG can be redeployed, scaled or restarted
  without touching the API, and its crashes show up as service events rather
  than inside the API's task. The cost is a second rollout in the deploy.
- **Failure mode unchanged.** `web-discovery.ts` already treats an unreachable
  SearXNG as "no web results", so the API keeps serving either way.

## Migration order

Each step can be reverted on its own until the last one.

1. **oxy-infra:** create the `clarity-api` SG and attach it to the
   `clarity-api` service next to `tasks`. This changes no behaviour.
2. **oxy-infra:** create the `clarity-searxng` SG, the execution role, the
   `clarity.internal.oxy.so` namespace and `searxng` Cloud Map service, the task
   definition (no task role, `GRANIAN_HOST=0.0.0.0`, the image digest the
   sidecar runs now) and the ECS service. Nothing calls it yet.
3. **Verify the boundary.**
   - From a `clarity-api` task (ECS Exec), `curl
     http://searxng.clarity.internal.oxy.so:8080/healthz` answers.
   - From any other service's task, it times out.
   - From a SearXNG task, `169.254.170.2` serves no credentials, and RDS and
     Valkey are unreachable.
4. **oxy-infra:** point `CLARITY_SEARXNG_URL` at
   `http://searxng.clarity.internal.oxy.so:8080` and roll the API. Verify that
   `/v1/search` still returns web-discovered results. Rollback is setting it
   back to `http://127.0.0.1:8080` while the sidecar still exists.
5. **This repo:** in `deploy-aws.yml`, deploy the SearXNG image to the new
   service with its own rollout, before the API (`deploy-ecs-service.sh` with
   `SERVICE=clarity-searxng`), and drop `SIDECAR_IMAGES_JSON` from the API
   deploy.
6. **oxy-infra:** remove the `sidecars` block from `module "clarity_api"`. Only
   this step is not trivially reversible, and it should wait until step 4 has
   run cleanly for a while.

Until step 6, the sidecar shares the API's task role. Until then, the role
must stay without IAM policies, and the Oxy application binding must not gain
any scope beyond `user:read` and `inference:invoke`.
