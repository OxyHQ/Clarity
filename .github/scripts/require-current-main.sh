#!/usr/bin/env bash
# Refuses to release DEPLOY_SHA when a newer main commit will release instead.
#
# Until 2026-10 this refused whenever main's head was not DEPLOY_SHA. That
# strands a CI-green commit whenever the commits after it never get a CI run
# of their own (a push made with GITHUB_TOKEN, such as an auto-merge, starts no
# workflow) or theirs failed or was cancelled: nothing newer ever releases, and
# this commit was refused. The rule is now `deploy-scope.sh gate`'s, shared with
# deploy.yml and tested by test-deploy-scope.sh: refuse only when some commit
# after DEPLOY_SHA has a CI push run that is queued, in progress or succeeded
# (that run's deploy carries this commit); otherwise release DEPLOY_SHA as the
# newest CI-tested commit.
#
# Env: DEPLOY_SHA, GITHUB_REPOSITORY, GH_TOKEN (with actions: read).

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
decision="$(mktemp)"
trap 'rm -f -- "$decision"' EXIT

RELEASE_SHA="$DEPLOY_SHA" GITHUB_OUTPUT="$decision" GITHUB_EVENT_NAME=workflow_run \
  bash "$here/deploy-scope.sh" gate
if ! grep -qxF current=true "$decision"; then
  echo "::error::Refusing to deploy $DEPLOY_SHA: a newer main commit has a CI run that will release it."
  exit 1
fi
