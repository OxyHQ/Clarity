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
# A second service rolled onto the SAME image at the same time as $SERVICE:
# after the pre-deploy task, before the post-deploy task. Clarity uses it for
# clarity-worker. The worker used to roll in its own step after the API's whole
# deploy, post-migration included — ~300s on top of the API's, and a window in
# which the OLD worker ran against a schema its post-migration had already
# narrowed. Rolling both between pre and post removes both. Either rollout
# failing rolls BOTH back, so the two never end on different releases.
COMPANION_SERVICE="${COMPANION_SERVICE:-}"
COMPANION_CONTAINER_NAME="${COMPANION_CONTAINER_NAME:-$COMPANION_SERVICE}"

if [[ ! "$IMAGE_URI" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::IMAGE_URI must use an immutable sha256 digest."
  exit 1
fi

if ! jq -e 'type == "object" and all(.[]; type == "string" and test("@sha256:[0-9a-f]{64}$"))' \
  <<<"$SIDECAR_IMAGES_JSON" >/dev/null; then
  echo "::error::SIDECAR_IMAGES_JSON must map container names to immutable sha256 image digests."
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# Registers a revision of <service> derived from the one it RUNS, with
# <container> on $IMAGE_URI (and any declared sidecar on its digest). Leaves
# <service>'s previous definition, new definition and desired count in
# $work_dir/<service>.{previous,new,desired} and its describe output in .json.
prepare_service() {
  local service="$1" container="$2"
  local json current desired container_count sidecar_images
  json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$service")"
  if [[ "$(jq '.failures | length' <<<"$json")" != 0 ]] ||
     [[ "$(jq '.services | length' <<<"$json")" != 1 ]]; then
    echo "::error::ECS service $service does not exist. Provision it in oxy-infra first."
    return 1
  fi
  current="$(jq -r '.services[0].taskDefinition // empty' <<<"$json")"
  desired="$(jq -r '.services[0].desiredCount // empty' <<<"$json")"
  if [[ -z "$current" ]] || ! [[ "$desired" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::$service must have a task definition and positive desiredCount."
    return 1
  fi

  aws ecs describe-task-definition \
    --task-definition "$current" \
    --query taskDefinition \
    >"$work_dir/$service.current-td.json"

  container_count="$(jq --arg name "$container" \
    '[.containerDefinitions[] | select(.name == $name)] | length' "$work_dir/$service.current-td.json")"
  if [[ "$container_count" != 1 ]]; then
    echo "::error::Expected exactly one container named $container in $service."
    return 1
  fi

  sidecar_images="$(jq -c --slurpfile task "$work_dir/$service.current-td.json" '
    with_entries(select(.key as $name | any($task[0].containerDefinitions[]; .name == $name)))
  ' <<<"$SIDECAR_IMAGES_JSON")"
  # Sidecars belong to the primary service's task; a companion that does not
  # declare them is not missing anything.
  if [[ "$service" == "$SERVICE" ]]; then
    for missing in $(jq -r --argjson declared "$sidecar_images" 'keys - ($declared | keys) | .[]' <<<"$SIDECAR_IMAGES_JSON"); do
      echo "::warning::$service declares no container named $missing; its image is not deployed. Declare it in oxy-infra."
    done
  fi

  jq --arg name "$container" --arg image "$IMAGE_URI" --argjson sidecars "$sidecar_images" '
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
  ' "$work_dir/$service.current-td.json" >"$work_dir/$service.rendered-td.json"

  aws ecs register-task-definition \
    --cli-input-json "file://$work_dir/$service.rendered-td.json" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text >"$work_dir/$service.new"
  printf '%s\n' "$current" >"$work_dir/$service.previous"
  printf '%s\n' "$desired" >"$work_dir/$service.desired"
  printf '%s\n' "$json" >"$work_dir/$service.json"
}

# Points <service> at its new definition and waits for the rollout to settle.
rollout_service() {
  local service="$1"
  local new_definition desired_count live_json rollout_state live_definition running_count
  new_definition="$(<"$work_dir/$service.new")"
  desired_count="$(<"$work_dir/$service.desired")"

  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$service" \
    --task-definition "$new_definition" \
    >/dev/null
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$service"

  # `services-stable` only means one deployment is left with the desired count
  # running. ECS marks that deployment COMPLETED a little later, and for a service
  # with no load balancer (the worker) the old tasks are gone before it does, so
  # reading the state once raced it and rolled back healthy deploys. Wait for
  # the rollout itself to settle.
  rollout_state=""
  for _ in $(seq 1 40); do
    live_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$service")"
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
    echo "::error::$service did not complete the requested rollout."
    return 1
  fi
  echo "Rolled $service to $new_definition"
}

run_one_shot() {
  local label="$1"
  local command_json="$2"
  local network_json task_arn task_json exit_code new_definition

  [[ -z "$command_json" ]] && return 0
  if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' \
    <<<"$command_json" >/dev/null; then
    echo "::error::$label command must be a non-empty JSON string array."
    return 1
  fi

  new_definition="$(<"$work_dir/$SERVICE.new")"
  network_json="$(jq -c '.services[0].networkConfiguration' "$work_dir/$SERVICE.json")"
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

services=("$SERVICE")
[[ -n "$COMPANION_SERVICE" ]] && services+=("$COMPANION_SERVICE")

# Every service that update-service has touched goes back to what it ran.
rollback() {
  local service
  for service in "${services[@]}"; do
    [[ -f "$work_dir/$service.touched" ]] || continue
    echo "::warning::Rolling $service back to $(<"$work_dir/$service.previous")."
    aws ecs update-service \
      --cluster "$CLUSTER" \
      --service "$service" \
      --task-definition "$(<"$work_dir/$service.previous")" \
      >/dev/null || true
  done
}

prepare_service "$SERVICE" "$CONTAINER_NAME"
if [[ -n "$COMPANION_SERVICE" ]]; then
  prepare_service "$COMPANION_SERVICE" "$COMPANION_CONTAINER_NAME"
fi

# A failed pre-deploy task leaves every service on its previous revision.
run_one_shot pre-deploy "$PRE_DEPLOY_TASK_COMMAND_JSON"

pids=()
for service in "${services[@]}"; do
  : >"$work_dir/$service.touched"
  rollout_service "$service" &
  pids+=("$!")
done
# Wait for EVERY rollout even after one fails, so the rollback never races an
# update-service still in flight.
rollout_failed=false
for pid in "${pids[@]}"; do
  wait "$pid" || rollout_failed=true
done
if [[ "$rollout_failed" == true ]]; then
  echo "::error::Rolling ${services[*]} back: a rollout did not complete."
  rollback
  exit 1
fi

if ! run_one_shot post-deploy "$POST_DEPLOY_TASK_COMMAND_JSON"; then
  rollback
  exit 1
fi

for service in "${services[@]}"; do
  echo "Deployed $service at $(<"$work_dir/$service.new") using $IMAGE_URI"
done
