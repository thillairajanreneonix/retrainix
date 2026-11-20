# Retrainix trainer: the worker code on top of the dependency base (Dockerfile.base).
# Runs as the Cloud Run job `retrainix-trainer`:  python -m app.worker <project_id> <job_id>
#
#   bash infra/deploy_trainer.sh --apply
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /srv

# The job runs as an unprivileged user, and the training libraries write caches and settings
# under the home directory, so it must exist and be writable. (The first cloud run of the
# earlier trainer, 20 Nov 2026, failed on exactly this: a folder created by root at build time.)
ENV HOME=/srv/home \
    MPLCONFIGDIR=/srv/home/matplotlib \
    HF_HOME=/srv/home/huggingface \
    TORCH_HOME=/srv/home/torch
RUN mkdir -p "$MPLCONFIGDIR" "$HF_HOME" "$TORCH_HOME" && chmod -R a+rwX /srv/home

COPY backend/app backend/app
COPY backend/agents backend/agents
COPY config config
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} \
    PYTHONPATH=/srv/backend
RUN python -c "from app import worker; from agents import trainer; print('trainer image ok, handlers:', sorted(worker.HANDLERS))" \
    && chmod -R a+rwX /srv/home
USER nobody
# Prove, as the user the job runs as, that the training library starts and the home folder is
# writable. Building the model itself is not tried here: it needs a checkpoint from the bucket.
RUN python -c "import rfdetr, pathlib, os; p = pathlib.Path(os.environ['HOME']) / 'write-test'; p.write_text('ok'); p.unlink(); print('rfdetr has', [n for n in dir(rfdetr) if n.startswith('RFDETRSeg')], 'and starts as an unprivileged user')"
CMD ["python", "-m", "app.worker"]
