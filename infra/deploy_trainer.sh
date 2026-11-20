#!/usr/bin/env bash
# Build and deploy the trainer: the Cloud Run job `retrainix-trainer` that runs `train` jobs.
#   bash infra/deploy_trainer.sh                   dry run
#   bash infra/deploy_trainer.sh --apply           code image (about 2 minutes) + job
#   bash infra/deploy_trainer.sh --apply --base    ALSO rebuild the dependency base first
#                                                  (CPU PyTorch + rfdetr, 10 minutes or more)
#
# Run with --base once, and again only when workers/trainer/Dockerfile.base or
# backend/requirements.txt changes. Re-run without it whenever backend code changes, or a
# training run would use old code.
#
# COST NOTE: Cloud Build bills per build-minute beyond the free daily allowance.
# The job itself costs nothing while idle. One training run is billed per vCPU-second and
# GB-second: 8 vCPU / 16 GiB, hard stop after 3 hours, no automatic retries.
set -uo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh "$@"
BASE=0; for arg in "$@"; do [ "$arg" = "--base" ] && BASE=1; done

REPO="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/cloud-run-source-deploy"
BASE_IMAGE="$REPO/retrainix-trainer-base:latest"
VERSION="$(git describe --tags --always 2>/dev/null || echo dev)-$(date -u +%Y%m%d%H%M)"
IMAGE="$REPO/retrainix-trainer:$VERSION"
TRAINER_JOB_NAME="${TRAINER_JOB_NAME:-retrainix-trainer}"
echo "== Trainer $VERSION, apply=$APPLY, rebuild base=$BASE"

if [ "$BASE" = "1" ]; then
  g builds submit . --region "$GCP_REGION" --config infra/cloudbuild.trainer.yaml \
    --substitutions "_DOCKERFILE=workers/trainer/Dockerfile.base,_IMAGE=$BASE_IMAGE,_BASE_IMAGE=unused,_VERSION=$VERSION" \
    --quiet || { echo "== BASE BUILD FAILED"; exit 1; }
fi

g builds submit . --region "$GCP_REGION" --config infra/cloudbuild.trainer.yaml \
  --substitutions "_DOCKERFILE=workers/trainer/Dockerfile,_IMAGE=$IMAGE,_BASE_IMAGE=$BASE_IMAGE,_VERSION=$VERSION" \
  --quiet || { echo "== TRAINER BUILD FAILED"; exit 1; }

g run jobs deploy "$TRAINER_JOB_NAME" --image "$IMAGE" --region "$GCP_REGION" \
  --service-account "$API_SA_EMAIL" \
  --command python --args=-m,app.worker \
  --cpu 8 --memory 16Gi --task-timeout 10800 --max-retries 0 \
  --set-env-vars "$(runtime_env "$VERSION")" \
  --quiet || { echo "== TRAINER JOB DEPLOY FAILED"; exit 1; }
echo "== done"
