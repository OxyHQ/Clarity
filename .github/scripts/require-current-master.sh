#!/usr/bin/env bash

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"

git fetch --no-tags --depth=1 origin master
current_master="$(git rev-parse origin/master)"
if [[ "$DEPLOY_SHA" != "$current_master" ]]; then
  echo "::error::Refusing to deploy stale commit $DEPLOY_SHA; origin/master is $current_master."
  exit 1
fi
