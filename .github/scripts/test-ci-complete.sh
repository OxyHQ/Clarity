#!/usr/bin/env bash
# Fixture tests for ci-complete.sh (CI complete in ci.yml): each case is a
# `needs` result set, the event and the race verdict, and whether the gate
# must pass. The ones that must fail matter most: a gate that cannot fail
# proves nothing.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-complete.sh"
failed=0

# needs JSON from "job=result" words; `changes` and `race` outputs via env.
needs() {
  local json='{}' word job res
  for word in "$@"; do
    job="${word%%=*}"
    res="${word#*=}"
    json="$(jq --arg j "$job" --arg r "$res" '.[$j] = {result: $r, outputs: {}}' <<<"$json")"
  done
  json="$(jq --arg f "${FRONTEND:-true}" --arg b "${BACKEND:-true}" --arg s "${SEARXNG:-true}" \
    'if .changes.result == "success" then .changes.outputs = {frontend: $f, backend: $b, searxng: $s} else . end' <<<"$json")"
  jq --arg race "${RACED:-}" 'if $race != "" then .race.outputs = {race: $race} else . end' <<<"$json"
}

# expect pass|fail, name, event, verdict, needs words...
expect() {
  local want="$1" name="$2" event="$3" verdict="$4" got
  shift 4
  if RESULTS="$(needs "$@")" EVENT_NAME="$event" RACE_VERDICT="$verdict" bash "$script" >/dev/null 2>&1; then
    got=pass
  else
    got=fail
  fi
  if [ "$got" = "$want" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name: wanted $want, got $got"
    failed=1
  fi
}

S=skipped
all_hosted_pr=(changes=success race=$S lint-and-test=success lint-and-test-hosted=$S lint-and-test-rescue=$S
  build-backend-image=success build-searxng-image=success build-frontend=success build-frontend-hosted=$S build-frontend-rescue=$S)
push=(changes=$S race=$S lint-and-test=success lint-and-test-hosted=$S lint-and-test-rescue=$S
  build-backend-image=success build-searxng-image=success build-frontend=success build-frontend-hosted=$S build-frontend-rescue=$S)

expect pass 'pull request, all hosted, all passed' pull_request '' "${all_hosted_pr[@]}"
expect pass 'push, all passed' push '' "${push[@]}"
expect pass 'dispatch, all passed' workflow_dispatch '' "${push[@]}"
expect fail 'push with changes running' push '' "${push[@]}" changes=success
expect fail 'lint-and-test failed' pull_request '' "${all_hosted_pr[@]}" lint-and-test=failure
expect fail 'lint-and-test cancelled without the race' pull_request '' "${all_hosted_pr[@]}" lint-and-test=cancelled
expect fail 'an image failed' pull_request '' "${all_hosted_pr[@]}" build-backend-image=failure
expect fail 'race start failed' pull_request '' "${all_hosted_pr[@]}" race=failure
FRONTEND=false BACKEND=false SEARXNG=false expect pass 'filtered jobs skipped by their filters' pull_request '' \
  "${all_hosted_pr[@]}" build-frontend=$S build-backend-image=$S build-searxng-image=$S
expect fail 'frontend skipped although its filter said yes' pull_request '' "${all_hosted_pr[@]}" build-frontend=$S
expect fail 'push with a skipped image' push '' "${push[@]}" build-backend-image=$S
expect fail 'lint-and-test skipped' pull_request '' "${all_hosted_pr[@]}" lint-and-test=$S
expect fail 'twin ran without the race' pull_request '' "${all_hosted_pr[@]}" lint-and-test-hosted=success

# The race.
RACED=true expect pass 'raced, Seldon lane cancelled, twin won' pull_request success \
  "${all_hosted_pr[@]}" race=success lint-and-test=cancelled lint-and-test-hosted=success
RACED=true expect pass 'raced, twin cancelled, Seldon won' pull_request success \
  "${all_hosted_pr[@]}" race=success build-frontend-hosted=cancelled
RACED=true expect fail 'raced, verdict failed' pull_request failure \
  "${all_hosted_pr[@]}" race=success lint-and-test=cancelled lint-and-test-hosted=failure
RACED=true expect fail 'raced, no verdict' pull_request '' \
  "${all_hosted_pr[@]}" race=success lint-and-test=cancelled lint-and-test-hosted=success
RACED=false expect pass 'race started, not needed' pull_request success "${all_hosted_pr[@]}" race=success
RACED=false expect fail 'race not needed but a twin ran' pull_request success \
  "${all_hosted_pr[@]}" race=success build-frontend-hosted=success
RACED=true FRONTEND=false expect pass 'raced, frontend filtered out' pull_request success \
  "${all_hosted_pr[@]}" race=success build-frontend=$S

# The rescue.
expect pass 'Seldon lane failed, rescue passed' pull_request success \
  "${all_hosted_pr[@]}" lint-and-test=failure lint-and-test-rescue=success
expect fail 'Seldon lane failed, rescue failed' pull_request failure \
  "${all_hosted_pr[@]}" lint-and-test=failure lint-and-test-rescue=failure
expect pass 'merge_group rescue passed' merge_group success \
  changes=$S race=$S lint-and-test=failure lint-and-test-hosted=$S lint-and-test-rescue=success \
  build-backend-image=success build-searxng-image=success build-frontend=success build-frontend-hosted=$S build-frontend-rescue=$S

exit "$failed"
