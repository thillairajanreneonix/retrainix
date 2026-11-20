#!/usr/bin/env bash
# One-time project setup for Retrainix. Idempotent: safe to run again.
#   bash infra/bootstrap.sh            dry run - prints what it would do
#   bash infra/bootstrap.sh --apply    does it
# Undo with infra/teardown.sh.
#
# COST NOTE: enabling APIs and creating the service account are free. The bucket and the
# Firestore database cost nothing while empty and are billed by stored GB and by
# reads/writes once used - small amounts at demo scale. Nothing here starts compute.
set -uo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh "$@"

echo "== Project $GCP_PROJECT_ID, region $GCP_REGION, apply=$APPLY"

echo "== 1. APIs"
g services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com \
  cloudquotas.googleapis.com aiplatform.googleapis.com generativelanguage.googleapis.com

echo "== 2. Cloud Storage bucket gs://$GCS_BUCKET"
if exists storage buckets describe "gs://$GCS_BUCKET"; then
  echo "   exists"
else
  g storage buckets create "gs://$GCS_BUCKET" --location "$GCP_REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi

echo "== 3. Firestore (default) database, Native mode"
if exists firestore databases describe; then
  echo "   exists"
else
  g firestore databases create --location "$GCP_REGION" --type firestore-native
fi

echo "== 4. Service account for the API (least privilege)"
if exists iam service-accounts describe "$API_SA_EMAIL"; then
  echo "   exists"
else
  g iam service-accounts create "$API_SA_NAME" --display-name "Retrainix API"
fi
# Firestore read/write for the whole project; object access on the one bucket only.
g projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member "serviceAccount:$API_SA_EMAIL" --role roles/datastore.user --condition None --quiet
run "$GCLOUD" storage buckets add-iam-policy-binding "gs://$GCS_BUCKET" \
  --member "serviceAccount:$API_SA_EMAIL" --role roles/storage.objectAdmin --project "$GCP_PROJECT_ID"

echo "== 5. Let Cloud Build deploy from source"
# `gcloud run deploy --source` builds as the Compute Engine default service account. On this
# project it had no access to the uploaded source (403 on storage.objects.get, seen 20 Nov),
# so it gets the Cloud Run Builder role - the role intended for exactly this.
PROJECT_NUMBER="$("$GCLOUD" projects describe "$GCP_PROJECT_ID" --format 'value(projectNumber)' </dev/null | tr -d '[:space:]')"
g projects add-iam-policy-binding "$GCP_PROJECT_ID"   --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"   --role roles/run.builder --condition None --quiet

echo "== 6. What the API needs to hand out upload links and start worker jobs"
# Signed upload URLs are signed through IAM (Cloud Run has no key file), so the service
# account needs Token Creator on itself - on itself only, not on the project.
run "$GCLOUD" iam service-accounts add-iam-policy-binding "$API_SA_EMAIL"   --member "serviceAccount:$API_SA_EMAIL" --role roles/iam.serviceAccountTokenCreator   --project "$GCP_PROJECT_ID" --quiet
# Start executions of the worker job and pass each one its project and job id.
g projects add-iam-policy-binding "$GCP_PROJECT_ID"   --member "serviceAccount:$API_SA_EMAIL" --role roles/run.jobsExecutorWithOverrides --condition None --quiet

echo "== 8. Let the API and the worker call Gemini and start training on Vertex AI"
# Gemini is called through Vertex AI with this service account - no API key to store.
g projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member "serviceAccount:$API_SA_EMAIL" --role roles/aiplatform.user --condition None --quiet

echo "== 7. Let the browser upload straight to the bucket (CORS)"
run "$GCLOUD" storage buckets update "gs://$GCS_BUCKET" --cors-file infra/cors.json --project "$GCP_PROJECT_ID"

echo "== 9. A place for the Gemini API key (Secret Manager)"
# The key itself is never handled here: a person pastes it in as a version of this secret.
# COST NOTE: Secret Manager is free for the first six secret versions.
if exists secrets describe "$GEMINI_KEY_SECRET"; then
  echo "   exists"
else
  g secrets create "$GEMINI_KEY_SECRET" --replication-policy automatic
fi
run "$GCLOUD" secrets add-iam-policy-binding "$GEMINI_KEY_SECRET" \
  --member "serviceAccount:$API_SA_EMAIL" --role roles/secretmanager.secretAccessor \
  --project "$GCP_PROJECT_ID" --quiet

echo "== done"
