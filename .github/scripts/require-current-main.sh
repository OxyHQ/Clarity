#!/usr/bin/env bash

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"

git fetch --no-tags --depth=1 origin main
current_main="$(git rev-parse origin/main)"
if [[ "$DEPLOY_SHA" != "$current_main" ]]; then
  echo "::error::Refusing to deploy stale commit $DEPLOY_SHA; origin/main is $current_main."
  exit 1
fi
