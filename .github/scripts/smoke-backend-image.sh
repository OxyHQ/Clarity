#!/usr/bin/env bash
# Boot the built backend image the way ECS runs it, against a throwaway
# Postgres, and fail unless the production runtime (Bun, PID 1, the image's own
# user and entrypoint) can:
#   0. run as `bun` (uid 1000) with NO path under /app writable by it, a
#      writable os.tmpdir(), and a node_modules without the frontend's Expo /
#      React Native tree or any devDependency,
#   1. refuse a boot with no database and exit non-zero, from the image's CMD,
#   2. run the crawler worker's command (oxy-infra's `bun .../worker.js`),
#   3. apply migrations with the exact commands deploy-aws.yml runs,
#   4. serve /health/ready with 200 from the image's default CMD,
#   5. turn SIGTERM (`docker stop`, as ECS does on a rollout) into the graceful
#      shutdown and exit 0.
# The migrator, the worker and the API also leave NO change under /app in their
# container's layer (`docker diff`): /app is root-owned because nothing writes
# there, and this is what keeps that true.
# A unit suite cannot see any of these: they are properties of the image.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway, EMPTY database named clarity)}"
PORT="${PORT:-3001}"
NAME="clarity-api-smoke-$$"
WORKER="clarity-worker-smoke-$$"
MIGRATOR="clarity-migrator-smoke-$$"
# The canonical agent (packages/backend/src/lib/clarity-agent-manifest.ts);
# readiness requires it configured and attested.
AGENT_ID=01a0646a-078f-7642-95ef-439952f4f3f9
# Readiness asks only whether the task CAN attest (ECS sets this variable);
# nothing in this smoke calls it. Unroutable on purpose.
CREDENTIALS_URI=http://127.0.0.1:9/no-credentials

cleanup() { docker rm -f "$NAME" "$WORKER" "$MIGRATOR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run() { docker run --rm --network host "$@"; }

# Fails if the container's layer shows any change under /app; prints the whole
# diff either way, so what each command writes is on record.
assert_no_app_writes() {
  local container="$1" label="$2" changes app
  changes=$(docker diff "$container")
  printf '%s writes (docker diff):\n%s\n' "$label" "${changes:-  (none)}"
  app=$(awk '$2 == "/app" || index($2, "/app/") == 1' <<<"$changes")
  if [ -n "$app" ]; then
    echo "::error::$label changed files under /app, which is root-owned and must stay read-only:"
    printf '%s\n' "$app"
    exit 1
  fi
}

echo "Runtime: $(run "$IMAGE" bun --version)"

# Control: `docker diff` must see a write the runtime user CAN make, or an
# empty diff below would prove nothing.
docker run --name "$MIGRATOR" "$IMAGE" sh -c 'echo probe > /tmp/diff-control'
if ! docker diff "$MIGRATOR" | grep -qx 'A /tmp/diff-control'; then
  docker diff "$MIGRATOR"
  echo "::error::docker diff did not report a file the container wrote; the /app write checks would be blind"
  exit 1
fi
docker rm "$MIGRATOR" >/dev/null

# 0. The runtime user, what it can write, and what ships in node_modules.
identity=$(run "$IMAGE" id -un):$(run "$IMAGE" id -u)
if [ "$identity" != bun:1000 ]; then
  echo "::error::the image runs as '$identity', expected bun:1000"
  exit 1
fi
writable=$(run "$IMAGE" find /app -writable -print)
if [ -n "$writable" ]; then
  printf '%s\n' "$writable" | head -n 20
  echo "::error::the runtime user can write $(wc -l <<<"$writable") paths under /app; it must write none"
  exit 1
fi
not_root=$(run "$IMAGE" find /app '(' ! -user root -o ! -group root ')' -print)
if [ -n "$not_root" ]; then
  printf '%s\n' "$not_root" | head -n 20
  echo "::error::paths under /app are not owned by root:root"
  exit 1
fi
# The direct attempt too, so the check above cannot pass by finding nothing.
if run "$IMAGE" sh -c 'echo tampered >> packages/backend/dist/index.js' 2>/dev/null; then
  echo "::error::the runtime user could append to the API bundle"
  exit 1
fi
run "$IMAGE" bun -e '
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  fs.writeFileSync(path.join(dir, "probe"), "ok");
  fs.rmSync(dir, { recursive: true });
  console.log(`os.tmpdir() ${os.tmpdir()} is writable by the runtime user`);
'
present=$(run "$IMAGE" sh -c '
  for p in expo react-native react metro @expo @react-native typescript vitest drizzle-kit @swc/core @biomejs/biome pino-pretty; do
    [ -e "node_modules/$p" ] && echo "$p"
  done; true')
if [ -n "$present" ]; then
  echo "::error::the runtime node_modules ships frontend or dev packages: $(tr '\n' ' ' <<<"$present")"
  exit 1
fi
for p in express drizzle-orm postgres socket.io stripe zod; do
  run "$IMAGE" test -f "node_modules/$p/package.json" || {
    echo "::error::the runtime node_modules lacks $p, which the API bundle imports"
    exit 1
  }
done
echo "Runtime node_modules: $(run "$IMAGE" sh -c 'ls node_modules | wc -l') entries, $(run "$IMAGE" du -sh node_modules | cut -f1)"

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
docker run --name "$MIGRATOR" --network host -e DATABASE_URL "$IMAGE" \
  bun packages/backend/dist/db/migrate.js --target-database=clarity --phase=all
assert_no_app_writes "$MIGRATOR" "The migrator (--phase=all)"
docker rm "$MIGRATOR" >/dev/null
for phase in pre post; do
  docker run --name "$MIGRATOR" --network host -e DATABASE_URL "$IMAGE" \
    bun packages/backend/dist/db/migrate.js --target-database=clarity --phase="$phase"
  assert_no_app_writes "$MIGRATOR" "The migrator (--phase=$phase)"
  docker rm "$MIGRATOR" >/dev/null
done
run -e DATABASE_URL -e CLARITY_ALIA_AGENT_ID="$AGENT_ID" "$IMAGE" \
  bun packages/backend/dist/db/attest-fresh-install.js --confirm=FRESH_INSTALL_NO_DATA_TO_MIGRATE

# The worker's command against the migrated database: it must stay up (an
# empty queue just polls) and write nothing under /app.
docker run -d --name "$WORKER" --network host \
  -e DATABASE_URL -e CLARITY_WORKER_ID=ci-smoke "$IMAGE" \
  bun packages/backend/dist/worker.js >/dev/null
sleep 15
if [ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" != true ]; then
  docker logs "$WORKER" 2>&1 | tail -n 40
  echo "::error::the worker exited within 15 s against a migrated database"
  exit 1
fi
assert_no_app_writes "$WORKER" "The worker (15 s)"
docker rm -f "$WORKER" >/dev/null

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

assert_no_app_writes "$NAME" "The API (to readiness)"

# 5. SIGTERM ends in the graceful shutdown and exit 0.
docker stop -t 35 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
logs=$(docker logs "$NAME" 2>&1)
if [ "$exit_code" != 0 ] || ! grep -q 'Graceful shutdown complete' <<<"$logs"; then
  printf '%s\n' "$logs"
  echo "::error::SIGTERM did not end in a graceful exit 0 (exit code $exit_code)"
  exit 1
fi

echo "Backend image smoke passed: bun:1000 with /app read-only and root-owned, no Expo/RN/dev packages, failed boots exit non-zero, migrations, worker up, nothing written under /app, /health/ready 200, PID 1 = Bun, graceful SIGTERM"
