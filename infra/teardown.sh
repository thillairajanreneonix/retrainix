#!/usr/bin/env bash
# Remove what bootstrap.sh and deploy.sh created.
#   bash infra/teardown.sh                  dry run
#   bash infra/teardown.sh --apply          deletes the Cloud Run service and the service account
#   bash infra/teardown.sh --apply --data   ALSO deletes the bucket and everything in it (not recoverable)
# The Firestore database and enabled APIs are left in place; both are free while unused.
set -uo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh "$@"
DATA=0; for arg in "$@"; do [ "$arg" = "--data" ] && DATA=1; done

g run services delete "$SERVICE_NAME" --region "$GCP_REGION" --quiet
g iam service-accounts delete "$API_SA_EMAIL" --quiet
if [ "$DATA" = "1" ]; then
  run "$GCLOUD" storage rm --recursive "gs://$GCS_BUCKET" --project "$GCP_PROJECT_ID"
else
  echo "Bucket gs://$GCS_BUCKET kept. Add --data to delete it and its contents."
fi
