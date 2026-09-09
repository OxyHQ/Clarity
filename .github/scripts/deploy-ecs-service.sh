#!/usr/bin/env bash

set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${SERVICE:?SERVICE is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"

PRE_DEPLOY_TASK_COMMAND_JSON="${PRE_DEPLOY_TASK_COMMAND_JSON:-}"
POST_DEPLOY_TASK_COMMAND_JSON="${POST_DEPLOY_TASK_COMMAND_JSON:-}"

if [[ ! "$IMAGE_URI" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::IMAGE_URI must use an immutable sha256 digest."
  exit 1
fi

service_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE")"
if [[ "$(jq '.failures | length' <<<"$service_json")" != 0 ]] ||
   [[ "$(jq '.services | length' <<<"$service_json")" != 1 ]]; then
  echo "::error::ECS service $SERVICE does not exist. Provision it in oxy-infra first."
  exit 1
fi

current_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")"
desired_count="$(jq -r '.services[0].desiredCount // empty' <<<"$service_json")"
if [[ -z "$current_definition" ]] || ! [[ "$desired_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::$SERVICE must have a task definition and positive desiredCount."
  exit 1
fi

current_file="$(mktemp)"
rendered_file="$(mktemp)"
trap 'rm -f "$current_file" "$rendered_file"' EXIT

aws ecs describe-task-definition \
  --task-definition "$current_definition" \
  --query taskDefinition \
  >"$current_file"

container_count="$(jq --arg name "$CONTAINER_NAME" \
  '[.containerDefinitions[] | select(.name == $name)] | length' "$current_file")"
if [[ "$container_count" != 1 ]]; then
  echo "::error::Expected exactly one container named $CONTAINER_NAME."
  exit 1
fi

jq --arg name "$CONTAINER_NAME" --arg image "$IMAGE_URI" '
  del(
    .taskDefinitionArn,
    .revision,
    .status,
    .requiresAttributes,
    .compatibilities,
    .registeredAt,
    .registeredBy
  ) |
  .containerDefinitions |= map(
    if .name == $name then .image = $image else . end
  )
' "$current_file" >"$rendered_file"

new_definition="$(aws ecs register-task-definition \
  --cli-input-json "file://$rendered_file" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

run_one_shot() {
  local label="$1"
  local command_json="$2"
  local network_json task_arn task_json exit_code

  [[ -z "$command_json" ]] && return 0
  if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' \
    <<<"$command_json" >/dev/null; then
    echo "::error::$label command must be a non-empty JSON string array."
    return 1
  fi

  network_json="$(jq -c '.services[0].networkConfiguration' <<<"$service_json")"
  if [[ "$network_json" == null ]]; then
    echo "::error::$SERVICE has no network configuration for $label."
    return 1
  fi

  task_arn="$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$new_definition" \
    --network-configuration "$network_json" \
    --overrides "$(jq -cn --arg name "$CONTAINER_NAME" --argjson command "$command_json" \
      '{containerOverrides: [{name: $name, command: $command}]}')" \
    --query 'tasks[0].taskArn' \
    --output text)"
  if [[ -z "$task_arn" || "$task_arn" == None ]]; then
    echo "::error::ECS did not start the $label task."
    return 1
  fi

  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"
  task_json="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn")"
  exit_code="$(jq -r --arg name "$CONTAINER_NAME" \
    '.tasks[0].containers[] | select(.name == $name) | .exitCode // empty' <<<"$task_json")"
  if [[ "$exit_code" != 0 ]]; then
    echo "::error::$label task failed with exit code ${exit_code:-missing}."
    return 1
  fi
}

rollback() {
  echo "::warning::Rolling $SERVICE back to $current_definition."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$current_definition" \
    >/dev/null || true
}
trap 'rollback; rm -f "$current_file" "$rendered_file"' ERR

run_one_shot pre-deploy "$PRE_DEPLOY_TASK_COMMAND_JSON"

aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --task-definition "$new_definition" \
  >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

live_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE")"
live_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$live_json")"
rollout_state="$(jq -r --arg task "$new_definition" '
  .services[0].deployments[] |
  select(.taskDefinition == $task and .status == "PRIMARY") |
  .rolloutState // empty
' <<<"$live_json")"
running_count="$(jq -r '.services[0].runningCount // 0' <<<"$live_json")"

if [[ "$live_definition" != "$new_definition" ]] ||
   [[ "$rollout_state" != COMPLETED ]] ||
   (( running_count < desired_count )); then
  echo "::error::$SERVICE did not complete the requested rollout."
  false
fi

run_one_shot post-deploy "$POST_DEPLOY_TASK_COMMAND_JSON"

trap - ERR
echo "Deployed $SERVICE at $new_definition using $IMAGE_URI"
