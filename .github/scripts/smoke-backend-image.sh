#!/usr/bin/env bash
# Boot the built backend image the way ECS runs it, against a throwaway
# Postgres, and fail unless the production runtime (Bun, PID 1, the image's own
# user and entrypoint) can:
#   1. refuse a boot with no database and exit non-zero, from the image's CMD,
#   2. run the crawler worker's command (oxy-infra's `bun .../worker.js`),
#   3. apply migrations with the exact commands deploy-aws.yml runs,
#   4. serve /health/ready with 200 from the image's default CMD,
#   5. turn SIGTERM (`docker stop`, as ECS does on a rollout) into the graceful
#      shutdown and exit 0.
# A unit suite cannot see any of these: they are properties of the image.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway, EMPTY database named clarity)}"
PORT="${PORT:-3001}"
NAME="clarity-api-smoke-$$"
# The canonical agent (packages/backend/src/lib/clarity-agent-manifest.ts);
# readiness requires it configured and attested.
AGENT_ID=01a0646a-078f-7642-95ef-439952f4f3f9
# Readiness asks only whether the task CAN attest (ECS sets this variable);
# nothing in this smoke calls it. Unroutable on purpose.
CREDENTIALS_URI=http://127.0.0.1:9/no-credentials

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run() { docker run --rm --network host "$@"; }

echo "Runtime: $(run "$IMAGE" bun --version)"

# 1. The image's own CMD, unmodified, with no DATABASE_URL: boot must fail
#    non-zero. The log line proves it got as far as boot — a container that
#    cannot even load the bundle also exits non-zero. 124 is `timeout`.
set +e
output=$(timeout 60 docker run --rm "$IMAGE" 2>&1)
code=$?
set -e
if [ "$code" -eq 0 ] || [ "$code" -eq 124 ] || ! grep -qF 'DATABASE_URL is required' <<<"$output"; then
  printf '%s\n' "$output" | tail -n 20
  echo "::error::the image's CMD exited $code with no DATABASE_URL; it must reach boot and exit non-zero"
  exit 1
fi
echo "The image's CMD exited $code on a failed boot."

# 2. clarity-worker's command (oxy-infra terraform-uswest2/app-clarity.tf), run
#    against no database so it touches nothing: Bun must load the worker
#    bundle and refuse non-zero.
set +e
output=$(timeout 60 docker run --rm "$IMAGE" bun packages/backend/dist/worker.js 2>&1)
code=$?
set -e
if [ "$code" -eq 0 ] || [ "$code" -eq 124 ] || ! grep -qF 'DATABASE_URL is required' <<<"$output"; then
  printf '%s\n' "$output" | tail -n 20
  echo "::error::the worker command exited $code with no DATABASE_URL; it must load and exit non-zero"
  exit 1
fi
echo "The worker command exited $code on a failed boot."

# 3. An empty database needs `all` first: `pre` alone refuses a pre-deploy
#    migration queued behind a post-deploy one (measured). Then the two
#    commands deploy-aws.yml runs, verbatim, which must succeed as no-ops.
run -e DATABASE_URL "$IMAGE" \
  bun packages/backend/dist/db/migrate.js --target-database=clarity --phase=all
for phase in pre post; do
  run -e DATABASE_URL "$IMAGE" \
    bun packages/backend/dist/db/migrate.js --target-database=clarity --phase="$phase"
done
run -e DATABASE_URL -e CLARITY_ALIA_AGENT_ID="$AGENT_ID" "$IMAGE" \
  bun packages/backend/dist/db/attest-fresh-install.js --confirm=FRESH_INSTALL_NO_DATA_TO_MIGRATE

# 4. The image's default CMD serves readiness.
docker run -d --name "$NAME" --network host \
  -e DATABASE_URL -e PORT="$PORT" -e CLARITY_ALIA_AGENT_ID="$AGENT_ID" \
  -e AWS_CONTAINER_CREDENTIALS_FULL_URI="$CREDENTIALS_URI" \
  "$IMAGE" >/dev/null

ready=
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  docker logs "$NAME" || true
  curl -sS "http://127.0.0.1:$PORT/health/ready" || true
  echo "::error::the backend image never answered /health/ready with 200"
  exit 1
fi

# PID 1 must be Bun running the bundle: the entrypoint execs the CMD, so a
# wrapper shell left at PID 1 would swallow the SIGTERM tested below.
pid1=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
case "$pid1" in
  "bun packages/backend/dist/index.js "*) ;;
  *)
    echo "::error::PID 1 is '$pid1', expected 'bun packages/backend/dist/index.js'"
    exit 1
    ;;
esac

# 5. SIGTERM ends in the graceful shutdown and exit 0.
docker stop -t 35 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
logs=$(docker logs "$NAME" 2>&1)
if [ "$exit_code" != 0 ] || ! grep -q 'Graceful shutdown complete' <<<"$logs"; then
  printf '%s\n' "$logs"
  echo "::error::SIGTERM did not end in a graceful exit 0 (exit code $exit_code)"
  exit 1
fi

echo "Backend image smoke passed: failed boots exit non-zero, migrations, /health/ready 200, PID 1 = Bun, graceful SIGTERM"
