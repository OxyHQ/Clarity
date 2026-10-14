#!/usr/bin/env bash
# Boot the built SearXNG sidecar image the way the clarity-api task runs it
# (its own entrypoint and user, host networking so 127.0.0.1 is shared, as
# awsvpc shares it inside the task) and fail unless, in every case:
#   - it runs as upstream's unprivileged user `searxng` (uid/gid 977), never root,
#   - /healthz answers 200 (the ECS health check's route),
#   - the settings in effect are Clarity's (packages/searxng/settings.yml), with
#     the placeholder secret replaced, written outside both image VOLUMEs,
#   - a JSON search returns valid JSON for the query asked. Results may be empty
#     (engines answer a CI runner as they like); the server answering is what
#     is asserted, and the counts are printed.
# The cases:
#   1. fresh anonymous volumes (what `docker run` gives: seeded, 977-owned),
#   2. EMPTY root-owned tmpfs mounts at /etc/searxng and /var/cache/searxng,
#   3. EMPTY root-owned bind mounts at the same paths.
# 2 and 3 mimic a runtime (Fargate may) that presents a VOLUME as its own empty
# root-owned directory. A control then puts the settings back on upstream's
# /etc/searxng under case 2 and asserts the container FAILS: proof that the
# root-owned case reproduces the failure this image's layout avoids.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
PORT=8080
BASE="http://127.0.0.1:$PORT"
NAME="clarity-searxng-smoke-$$"
SETTINGS=/var/lib/searxng/config/settings.yml
SCRATCH=$(mktemp -d)

cleanup() {
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  sudo rm -rf "$SCRATCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  docker logs "$NAME" 2>&1 | tail -n 40 || true
  exit 1
}

wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]; then return 1; fi
    sleep 1
  done
  return 1
}

assert_serving() {
  local label="$1"
  wait_healthy || fail "$label: /healthz never answered 200"

  # PID 1 is the granian server, and every uid/gid on it is 977 (real,
  # effective, saved, fs).
  local uids gids cmd
  uids=$(docker exec "$NAME" awk '/^Uid:/{print $2,$3,$4,$5}' /proc/1/status)
  gids=$(docker exec "$NAME" awk '/^Gid:/{print $2,$3,$4,$5}' /proc/1/status)
  cmd=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
  [ "$uids" = "977 977 977 977" ] || fail "$label: PID 1 uids are '$uids', expected 977"
  [ "$gids" = "977 977 977 977" ] || fail "$label: PID 1 gids are '$gids', expected 977"
  # Granian retitles itself to GRANIAN_PROCESS_NAME (`searxng`, set upstream).
  case "$cmd" in searxng*|*granian*) ;; *) fail "$label: PID 1 is '$cmd', expected granian (titled searxng)" ;; esac

  # The settings were written where this image put them, the secret is no
  # longer the placeholder, and nothing was written into either VOLUME.
  docker exec "$NAME" test -s "$SETTINGS" || fail "$label: $SETTINGS missing"
  if docker exec "$NAME" grep -q ultrasecretkey "$SETTINGS"; then
    fail "$label: the placeholder secret_key was not replaced"
  fi
  if docker exec "$NAME" test -e /etc/searxng/settings.yml; then
    fail "$label: settings were written into the /etc/searxng VOLUME"
  fi

  # /config reflects the settings in effect: Clarity's instance name, and
  # DuckDuckGo removed. Upstream's defaults would say otherwise.
  curl -fsS "$BASE/config" -o "$SCRATCH/config.json" || fail "$label: /config did not answer"
  python3 - "$SCRATCH/config.json" "$label" <<'EOF' || fail "$label: the settings in effect are not Clarity's"
import json, sys
config = json.load(open(sys.argv[1]))
names = {e['name'] for e in config['engines']}
assert config['instance_name'] == 'Clarity', config['instance_name']
assert 'duckduckgo' not in names, 'duckduckgo is enabled'
print(sys.argv[2] + ': settings in effect are Clarity\'s (' + str(len(names)) + ' engines, no duckduckgo)')
EOF

  # The request /v1/search makes. Upstream's defaults serve no JSON (403).
  local code
  code=$(curl -sS -o "$SCRATCH/search.json" -w '%{http_code}' --max-time 30 \
    "$BASE/search?q=clarity&format=json") || fail "$label: the JSON search request failed"
  [ "$code" = 200 ] || fail "$label: JSON search answered HTTP $code"
  python3 - "$SCRATCH/search.json" "$label" <<'EOF' || fail "$label: the JSON search did not return a valid answer"
import json, sys
body = json.load(open(sys.argv[1]))
assert body['query'] == 'clarity', body.get('query')
assert isinstance(body['results'], list)
unresponsive = body.get('unresponsive_engines', [])
print(f"{sys.argv[2]}: JSON search answered: {len(body['results'])} results, "
      f"{len(unresponsive)} unresponsive engines {unresponsive}")
EOF

  # Non-root skips the entrypoint's update-ca-certificates: the trust store
  # the base image built must still load for this user.
  docker exec "$NAME" /usr/local/searxng/.venv/bin/python -c '
import ssl
n = len(ssl.create_default_context().get_ca_certs())
assert n > 100, n
print(f"CA certificates loaded as the runtime user: {n}")
' || fail "$label: the CA trust store does not load for the runtime user"

  docker rm -f -v "$NAME" >/dev/null
  echo "$label: passed"
}

# The image's own user, not just a USER line that a runtime could override.
image_user=$(docker inspect -f '{{.Config.User}}' "$IMAGE")
[ "$image_user" = "searxng:searxng" ] || fail "image USER is '$image_user', expected searxng:searxng"

# 1. Fresh anonymous volumes.
docker run -d --name "$NAME" --network host "$IMAGE" >/dev/null
assert_serving "fresh volumes"

# 2. Empty root-owned tmpfs at both VOLUME paths.
root_tmpfs=(
  --mount type=tmpfs,destination=/etc/searxng,tmpfs-mode=0755
  --mount type=tmpfs,destination=/var/cache/searxng,tmpfs-mode=0755
)
docker run -d --name "$NAME" --network host "${root_tmpfs[@]}" "$IMAGE" >/dev/null
owner=$(docker exec "$NAME" stat -c %u:%g /etc/searxng)
[ "$owner" = "0:0" ] || fail "root-owned tmpfs: /etc/searxng is $owner, the case did not apply"
assert_serving "root-owned tmpfs volumes"

# 3. Empty root-owned bind mounts at both VOLUME paths.
sudo install -d -m 0755 -o root -g root "$SCRATCH/etc" "$SCRATCH/cache"
docker run -d --name "$NAME" --network host \
  -v "$SCRATCH/etc:/etc/searxng" -v "$SCRATCH/cache:/var/cache/searxng" \
  "$IMAGE" >/dev/null
owner=$(docker exec "$NAME" stat -c %u:%g /etc/searxng)
[ "$owner" = "0:0" ] || fail "root-owned bind mounts: /etc/searxng is $owner, the case did not apply"
assert_serving "root-owned bind-mounted volumes"

# Control: upstream's layout (settings in the /etc/searxng VOLUME) under case 2
# must fail, or cases 2 and 3 prove nothing.
set +e
output=$(timeout 60 docker run --rm --network host "${root_tmpfs[@]}" \
  -e __SEARXNG_CONFIG_PATH=/etc/searxng \
  -e __SEARXNG_DATA_PATH=/var/cache/searxng \
  -e SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml \
  "$IMAGE" 2>&1)
code=$?
set -e
if [ "$code" -eq 0 ] || [ "$code" -eq 124 ]; then
  printf '%s\n' "$output" | tail -n 20
  echo "::error::control: upstream's settings path on a root-owned volume did not fail (exit $code); the root-owned cases do not reproduce the failure"
  exit 1
fi
echo "control: upstream's settings path on a root-owned volume exits $code, as on a runtime that mounts it root-owned"

echo "SearXNG image smoke passed: uid 977 under fresh, root-owned tmpfs and root-owned bind volumes; /healthz, Clarity's settings, JSON search, CA store"
