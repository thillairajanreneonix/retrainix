#!/usr/bin/env bash
# Build and deploy the web service (API + frontend) and the worker job to Cloud Run.
#   bash infra/deploy.sh            dry run
#   bash infra/deploy.sh --apply    builds in Cloud Build, then deploys both
#
# COST NOTE: Cloud Build bills per build-minute beyond its free daily allowance; this build
# takes a few minutes. The Cloud Run service scales to zero, so it costs nothing while idle
# and is billed per request-second when used. Max 2 instances as a runaway guard.
# 2 vCPU / 2 GiB since 21 Nov 2026: POST /predict (labelling a live camera view) runs the
# labelling model inside the service, and that model alone is a 139 MB file plus its session.
# A worker job execution is billed per vCPU-second and GB-second while it runs and nothing
# while idle: 4 vCPU / 4 GiB (the labelling model and its 139 MB file sit in memory), hard
# stop after 30 minutes, no automatic retries (the worker retries once itself).
#
# The service is PUBLIC (no sign-in) - the MVP has no accounts (plan.md section 2).
# To lock it:  gcloud run services remove-iam-policy-binding $SERVICE_NAME \
#                --member allUsers --role roles/run.invoker --region $GCP_REGION
set -uo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh "$@"

VERSION="$(git describe --tags --always 2>/dev/null || echo dev)-$(date -u +%Y%m%d%H%M)"
KEY_FLAG="$(gemini_key_flag)"
echo "== Gemini route: $([ -n "$KEY_FLAG" ] && echo "API key from Secret Manager" || echo "Vertex AI (no key stored)")"
echo "== Deploying $SERVICE_NAME version $VERSION to $GCP_REGION, apply=$APPLY"

g run deploy "$SERVICE_NAME" --source . --region "$GCP_REGION" \
  --service-account "$API_SA_EMAIL" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --memory 2Gi --cpu 2 --timeout 300 \
  --set-env-vars "$(runtime_env "$VERSION")" $KEY_FLAG \
  --quiet || { echo "== DEPLOY FAILED"; exit 1; }

# The worker is the same image, started as a Cloud Run job: one execution per job document.
IMAGE="<image of the service>"
if [ "$APPLY" = "1" ]; then
  IMAGE="$("$GCLOUD" run services describe "$SERVICE_NAME" --region "$GCP_REGION" --project "$GCP_PROJECT_ID" --format 'value(spec.template.spec.containers[0].image)' </dev/null | tr -d '\r')"
  echo "== Worker image: $IMAGE"
fi
g run jobs deploy "$WORKER_JOB_NAME" --image "$IMAGE" --region "$GCP_REGION" \
  --service-account "$API_SA_EMAIL" \
  --command python --args=-m,app.worker \
  --cpu 4 --memory 4Gi --task-timeout 3600 --max-retries 0 \
  --set-env-vars "$(runtime_env "$VERSION")" $KEY_FLAG \
  --quiet || { echo "== WORKER DEPLOY FAILED"; exit 1; }

# The retrain schedule: Cloud Scheduler calls /internal/tick, which decides per project whether
# a scheduled retrain is due. The call carries an identity token for the app's service account.
# COST NOTE: a Cloud Scheduler job is free within the first three jobs per billing account.
TICK_MINUTES="$(grep -E '^\s+tick_minutes:' config/agents.yaml | head -1 | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
if exists scheduler jobs describe "$SCHEDULER_JOB_NAME" --location "$GCP_REGION"; then VERB=update; else VERB=create; fi
g scheduler jobs "$VERB" http "$SCHEDULER_JOB_NAME" --location "$GCP_REGION" \
  --schedule "*/${TICK_MINUTES:-15} * * * *" --time-zone "Asia/Kolkata" \
  --uri "$SERVICE_URL/internal/tick" --http-method POST \
  --oidc-service-account-email "$API_SA_EMAIL" --oidc-token-audience "$SERVICE_URL" \
  --attempt-deadline 120s --quiet || echo "== SCHEDULER SETUP FAILED (the app still works; scheduled retrains will not fire)"

if [ "$APPLY" = "1" ]; then
  URL="$("$GCLOUD" run services describe "$SERVICE_NAME" --region "$GCP_REGION" --project "$GCP_PROJECT_ID" --format 'value(status.url)' </dev/null)"
  echo "== URL: $URL"
fi
