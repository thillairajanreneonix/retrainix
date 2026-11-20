"""Jobs: the job document is the queue (docs/api.md, "How a job reaches compute").

The API writes the document, then starts one execution of the worker and passes it only
project_id and job_id. Locally the worker is a thread in this process.
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from typing import Any

from .settings import get_settings
from .store import Store, now_iso

logger = logging.getLogger(__name__)

# What a user may start through POST /jobs (docs/api.md). extract_frames and import_gold
# are started by completing an upload; evaluate always follows train.
USER_JOB_TYPES = {"prelabel", "holdout_check", "qa", "compile", "train"}
ALL_JOB_TYPES = USER_JOB_TYPES | {"extract_frames", "import_gold", "evaluate"}


def sortable_id(prefix: str) -> str:
    """Ids that sort by creation time, so "newest first" needs no index."""
    return f"{prefix}_{int(time.time() * 1000):013d}{secrets.token_hex(2)}"


def create_job(
    store: Store,
    project_id: str,
    job_type: str,
    params: dict[str, Any] | None = None,
    dry_run: bool = False,
    trigger: str = "user",
) -> dict[str, Any]:
    job_id = sortable_id("j")
    job = {
        "project_id": project_id,
        "type": job_type,
        "status": "queued",
        "dry_run": dry_run,
        "trigger": trigger,
        "params": params or {},
        "progress": {"done": 0, "total": 0},
        "result": {},
        "error": None,
        "execution": None,
        "created_at": now_iso(),
        "started_at": None,
        "finished_at": None,
    }
    store.set(f"projects/{project_id}/jobs/{job_id}", job)
    return {**job, "id": job_id}


def dispatch(store: Store, project_id: str, job_id: str) -> None:
    """Start the worker for one job. Never does the work in the request itself, except
    in the "sync" mode the tests use."""
    runner = get_settings().job_runner
    from . import worker  # noqa: PLC0415 - worker imports this module

    if runner == "sync":
        worker.run_job(project_id, job_id)
    elif runner == "inline":
        threading.Thread(
            target=worker.run_job, args=(project_id, job_id), daemon=True, name=f"job-{job_id}"
        ).start()
    else:
        try:
            job_type = store.get(f"projects/{project_id}/jobs/{job_id}")["type"]
            execution = _run_cloud_run_job(project_id, job_id, job_type)
            store.update(f"projects/{project_id}/jobs/{job_id}", {"execution": execution})
        except Exception as exc:  # the job must not sit "queued" for ever
            logger.exception("could not start the worker for %s", job_id)
            store.update(
                f"projects/{project_id}/jobs/{job_id}",
                {
                    "status": "failed",
                    "error": f"could not start the worker: {exc}",
                    "finished_at": now_iso(),
                },
            )


def _run_cloud_run_job(project_id: str, job_id: str, job_type: str) -> str:
    """Cloud Run Admin API v2, jobs.run with per-execution arguments. Training goes to the
    trainer job (same code, plus the training framework and more CPU); the rest to the worker."""
    import google.auth  # noqa: PLC0415 - only needed in the cloud
    from google.auth.transport.requests import AuthorizedSession  # noqa: PLC0415

    s = get_settings()
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    # Training needs the framework that only the trainer image carries.
    job_name = s.trainer_job_name if job_type == "train" else s.worker_job_name
    name = f"projects/{s.gcp_project_id}/locations/{s.gcp_region}/jobs/{job_name}"
    response = AuthorizedSession(credentials).post(
        f"https://run.googleapis.com/v2/{name}:run",
        json={
            "overrides": {
                "containerOverrides": [{"args": ["-m", "app.worker", project_id, job_id]}]
            }
        },
        timeout=30,
    )
    if response.status_code >= 300:
        raise RuntimeError(f"Cloud Run answered {response.status_code}: {response.text[:300]}")
    body = response.json()
    return body.get("metadata", {}).get("name") or body.get("name", "")
