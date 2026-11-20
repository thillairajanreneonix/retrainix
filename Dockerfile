# Retrainix web service: FastAPI API + the built React app, one Cloud Run service, one URL.
# Build from the repo root:  gcloud run deploy --source .   (Cloud Build runs this file)
# The same image is also the Cloud Run job `retrainix-worker` (command: python -m app.worker).
# The ML images (pre-label, train) are separate and live under /workers.

FROM node:24-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /srv
# OpenCV (headless) reads the uploaded videos; it needs glib at run time.
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
# requirements.txt is exported from uv.lock, so every version is pinned:
#   cd backend && uv export --no-dev --no-hashes --no-emit-project -o requirements.txt
# The import check makes a broken native dependency fail the build, not the first request.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt \
    && python -c "import cv2, google.cloud.firestore, google.cloud.storage; print('imports ok, cv2', cv2.__version__)"
COPY backend/app backend/app
COPY backend/agents backend/agents
COPY config config
COPY --from=web /web/dist frontend/dist

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} \
    PORT=8080 \
    PYTHONPATH=/srv/backend
USER nobody
CMD ["sh", "-c", "exec uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port ${PORT}"]
