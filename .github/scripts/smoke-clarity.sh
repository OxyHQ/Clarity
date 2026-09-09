#!/usr/bin/env bash

set -euo pipefail

: "${CLARITY_API_URL:?CLARITY_API_URL is required}"

live_file="$(mktemp)"
ready_file="$(mktemp)"
trap 'rm -f "$live_file" "$ready_file"' EXIT

curl --fail --silent --show-error --max-time 15 \
  "$CLARITY_API_URL/health/live" >"$live_file"
curl --fail --silent --show-error --max-time 15 \
  "$CLARITY_API_URL/health/ready" >"$ready_file"

jq -e '.status == "alive"' "$live_file" >/dev/null
jq -e '.ready == true or .status == "ready"' "$ready_file" >/dev/null
