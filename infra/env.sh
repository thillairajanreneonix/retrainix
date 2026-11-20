#!/usr/bin/env bash
# Shared, non-secret deployment values. Sourced by every script in /infra.
# Secrets never go here - they live in Secret Manager.

export GCP_PROJECT_ID="${GCP_PROJECT_ID:-desktop-application-515217}"
export GCP_REGION="${GCP_REGION:-asia-south1}"          # Mumbai; fallback asia-southeast1
export GCS_BUCKET="${GCS_BUCKET:-retrainix-data-${GCP_PROJECT_ID}}"
export SERVICE_NAME="${SERVICE_NAME:-retrainix}"
export WORKER_JOB_NAME="${WORKER_JOB_NAME:-retrainix-worker}"
export TRAINER_JOB_NAME="${TRAINER_JOB_NAME:-retrainix-trainer}"
export SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-retrainix-tick}"
export GEMINI_KEY_SECRET="${GEMINI_KEY_SECRET:-gemini-api-key}"
# The service's stable address (project number + region). It is the audience the scheduler's
# identity token is issued for, and what /internal/tick checks.
export SERVICE_URL="${SERVICE_URL:-https://retrainix-801692371835.asia-south1.run.app}"
export API_SA_NAME="${API_SA_NAME:-retrainix-api}"
export API_SA_EMAIL="${API_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
export GEMINI_LOCATION="${GEMINI_LOCATION:-global}"     # both models 404 at asia-south1 (20 Nov)
export GEMINI_MODEL_BULK="${GEMINI_MODEL_BULK:-gemini-3.8-flash}"
export GEMINI_MODEL_HARD="${GEMINI_MODEL_HARD:-gemini-3.1-pro-preview}"

# gcloud is not on every shell's PATH on the build PC.
if command -v gcloud >/dev/null 2>&1; then
  GCLOUD="gcloud"
else
  GCLOUD="${LOCALAPPDATA//\\//}/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"
fi
export GCLOUD

# Every script is a dry run unless called with --apply.
APPLY=0
for arg in "$@"; do [ "$arg" = "--apply" ] && APPLY=1; done
export APPLY

run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    "$@"
  else
    echo "DRY RUN: $*"
  fi
}
g() { run "$GCLOUD" "$@" --project "$GCP_PROJECT_ID"; }
# Read-only existence check. Never prompts: gcloud would otherwise wait on "enable this API?".
exists() { "$GCLOUD" "$@" --project "$GCP_PROJECT_ID" --quiet >/dev/null 2>&1 </dev/null; }

# "--set-secrets GEMINI_API_KEY=..." when the secret holds a key, nothing when it does not
# (a deploy that names a secret with no version fails). With the key set, the app calls Gemini
# through the Gemini API; without it, through Vertex AI.
gemini_key_flag() {
  local n
  n="$("$GCLOUD" secrets versions list "$GEMINI_KEY_SECRET" --project "$GCP_PROJECT_ID" --filter "state:ENABLED" --format "value(name)" --quiet 2>/dev/null </dev/null | grep -c .)"
  if [ "${n:-0}" -gt 0 ]; then echo "--set-secrets=GEMINI_API_KEY=${GEMINI_KEY_SECRET}:latest"; fi
}

# The environment the service and the worker job both run with. $1 = version label.
runtime_env() {
  echo "GCP_PROJECT_ID=$GCP_PROJECT_ID,GCP_REGION=$GCP_REGION,GCS_BUCKET=$GCS_BUCKET,STORE_BACKEND=firestore,BLOB_BACKEND=gcs,JOB_RUNNER=cloud_run,WORKER_JOB_NAME=$WORKER_JOB_NAME,TRAINER_JOB_NAME=$TRAINER_JOB_NAME,TICK_AUDIENCE=$SERVICE_URL,TICK_SERVICE_ACCOUNT=$API_SA_EMAIL,GEMINI_LOCATION=$GEMINI_LOCATION,GEMINI_MODEL_BULK=$GEMINI_MODEL_BULK,GEMINI_MODEL_HARD=$GEMINI_MODEL_HARD,APP_VERSION=$1"
}
