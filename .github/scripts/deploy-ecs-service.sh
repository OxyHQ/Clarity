#!/usr/bin/env bash

set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${SERVICE:?SERVICE is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"

PRE_DEPLOY_TASK_COMMAND_JSON="${PRE_DEPLOY_TASK_COMMAND_JSON:-}"
# Images for the task's OTHER containers, as {"<container>": "<uri@sha256:…>"}.
# oxy-infra declares which containers a task has; the deploy only rolls the
# images of the ones it declares. One not declared yet is named and skipped.
SIDECAR_IMAGES_JSON="${SIDECAR_IMAGES_JSON:-}"
[[ -n "$SIDECAR_IMAGES_JSON" ]] || SIDECAR_IMAGES_JSON='{}'
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

if ! jq -e 'type == "object" and all(.[]; type == "string" and test("@sha256:[0-9a-f]{64}$"))' \
  <<<"$SIDECAR_IMAGES_JSON" >/dev/null; then
  echo "::error::SIDECAR_IMAGES_JSON must map container names to immutable sha256 image digests."
  exit 1
fi
sidecar_images="$(jq -c --slurpfile task "$current_file" '
  with_entries(select(.key as $name | any($task[0].containerDefinitions[]; .name == $name)))
' <<<"$SIDECAR_IMAGES_JSON")"
for missing in $(jq -r --argjson declared "$sidecar_images" 'keys - ($declared | keys) | .[]' <<<"$SIDECAR_IMAGES_JSON"); do
  echo "::warning::$SERVICE declares no container named $missing; its image is not deployed. Declare it in oxy-infra."
done

jq --arg name "$CONTAINER_NAME" --arg image "$IMAGE_URI" --argjson sidecars "$sidecar_images" '
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
    if .name == $name then .image = $image
    elif $sidecars[.name] then .image = $sidecars[.name]
    else . end
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

# `services-stable` only means one deployment is left with the desired count
# running. ECS marks that deployment COMPLETED a little later, and for a service
# with no load balancer (the worker) the old tasks are gone before it does, so
# reading the state once raced it and rolled back healthy deploys. Wait for
# the rollout itself to settle.
rollout_state=""
for _ in $(seq 1 40); do
  live_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE")"
  rollout_state="$(jq -r --arg task "$new_definition" '
    .services[0].deployments[] |
    select(.taskDefinition == $task and .status == "PRIMARY") |
    .rolloutState // empty
  ' <<<"$live_json")"
  [[ "$rollout_state" == IN_PROGRESS ]] || break
  sleep 15
done
live_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$live_json")"
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
