#!/usr/bin/env bash
# CI complete (ci.yml): green only when every job passed or skipped for a
# reason ci.yml declares. Inputs, from the workflow:
#   RESULTS       toJSON(needs)
#   EVENT_NAME    github.event_name
#   RACE_VERDICT  the Seldon race verdict ('success' / 'failure'), empty when
#                 CI_SELDON_RACE is off
# Exercised on fixtures by .github/scripts/test-ci-complete.sh.
set -euo pipefail

failures=()
result() { jq -r --arg job "$1" '.[$job].result // "missing"' <<<"$RESULTS"; }
said() { jq -r --arg out "$1" '.changes.outputs[$out] // ""' <<<"$RESULTS"; }

# `changes` runs on pull requests and nowhere else.
changes="$(result changes)"
if [ "$EVENT_NAME" = pull_request ]; then
  [ "$changes" = success ] || failures+=("changes did not pass: $changes")
else
  [ "$changes" = skipped ] || failures+=("changes ran on $EVENT_NAME: $changes")
fi

# The race's start: skipped when not needed, never failed. (race-finish is not
# judged: its reapers run on Seldon.)
r="$(result race)"
case "$r" in
  success | skipped) ;;
  *) failures+=("race did not pass: $r") ;;
esac

# A raced family's result, in $family: the verdict when the race ran (and the
# job was not skipped) or its rescue ran; otherwise the job's own, with its twin
# and rescue skipped. Not called in a subshell, so its failures reach the list.
family() {
  local job="$1" own twin rescue raced
  own="$(result "$job")"
  twin="$(result "$job-hosted")"
  rescue="$(result "$job-rescue")"
  raced="$(jq -r '.race.outputs.race // ""' <<<"$RESULTS")"
  if [ "$rescue" != skipped ] || { [ "$raced" = true ] && ! { [ "$own" = skipped ] && [ "$twin" = skipped ]; }; }; then
    family="${RACE_VERDICT:-no verdict}"
    return
  fi
  [ "$twin" = skipped ] || failures+=("$job-hosted ran although the Seldon race did not: $twin")
  family="$own"
}

# job, its `changes` output, its result.
check() {
  local job="$1" filter="$2" r="$3"
  [ "$r" = success ] && return
  if [ "$r" = skipped ] && [ -n "$filter" ] && [ "$EVENT_NAME" = pull_request ] &&
    [ "$changes" = success ] && [ "$(said "$filter")" != true ]; then
    return
  fi
  failures+=("$job did not pass: $r")
}

family lint-and-test
check lint-and-test '' "$family"
check build-backend-image backend "$(result build-backend-image)"
check build-searxng-image searxng "$(result build-searxng-image)"
family build-frontend
check build-frontend frontend "$family"

if [ ${#failures[@]} -gt 0 ]; then
  for failure in "${failures[@]}"; do
    echo "::error::$failure"
  done
  exit 1
fi
echo 'Every job passed, or skipped for a reason ci.yml declares.'
