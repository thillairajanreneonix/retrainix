"""Jobs, images and events (docs/api.md)."""
from __future__ import annotations

import json
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, Field

from agents import outliner

from .. import jobs
from ..deps import get_blobs, get_store
from ..errors import APIError, not_found
from ..settings import load_agents_config
from ..store import now_iso
from .projects import get_project_or_404

router = APIRouter(prefix="/api", tags=["work"])


# --- jobs ---------------------------------------------------------------------------
class JobCreate(BaseModel):
    type: str
    dry_run: bool = False
    params: dict[str, Any] = Field(default_factory=dict)


@router.post("/projects/{project_id}/jobs", status_code=202)
def start_job(project_id: str, body: JobCreate) -> dict[str, Any]:
    get_project_or_404(project_id)
    if body.type not in jobs.USER_JOB_TYPES:
        allowed = ", ".join(sorted(jobs.USER_JOB_TYPES))
        raise APIError(422, "invalid_request", f"type: must be one of {allowed}")
    store = get_store()
    if not body.dry_run:
        _check_can_start(store, project_id, body.type)
    job = jobs.create_job(store, project_id, body.type, body.params, dry_run=body.dry_run)
    jobs.dispatch(store, project_id, job["id"])
    return store.get(f"projects/{project_id}/jobs/{job['id']}")


def busy(store: Any, project_id: str, job_type: str) -> bool:
    for status in ("queued", "running"):
        jobs_now = store.list(f"projects/{project_id}/jobs", where={"status": status})
        if any(j["type"] == job_type and not j["dry_run"] for j in jobs_now):
            return True
    return False


def _check_can_start(store: Any, project_id: str, job_type: str) -> None:
    """docs/api.md: no step starts without the output of the one before, and never two of
    the same kind at once."""
    project = store.get(f"projects/{project_id}")
    images = f"projects/{project_id}/images"
    if job_type == "prelabel":
        if busy(store, project_id, "prelabel"):
            raise APIError(409, "conflict", "Frames are already being pre-labelled")
        if not store.list(images, where={"label_status": "none"}, limit=1):
            raise APIError(409, "conflict", "There are no unlabelled frames to pre-label")
    elif job_type == "holdout_check":
        if busy(store, project_id, "holdout_check"):
            raise APIError(409, "conflict", "The hold-out is already being scored")
        if not project["counts"].get("gold_holdout"):
            raise APIError(409, "conflict", "Freeze the gold set first: there is no hold-out to score against")
    elif job_type == "outline":
        if busy(store, project_id, "outline"):
            raise APIError(409, "conflict", "Outlines are already being drawn")
        if not outliner.images_missing(store, project_id):
            raise APIError(409, "conflict", "No object is missing an outline")
    elif job_type == "compile":
        if busy(store, project_id, "compile"):
            raise APIError(409, "conflict", "A dataset is already being compiled")
        ready = project["counts"].get("passed", 0) + project["counts"].get("human_done", 0)
        if not ready:
            raise APIError(409, "conflict", "No frame has passed the check or been checked by a person yet")
    elif job_type == "train":
        if busy(store, project_id, "train"):
            raise APIError(409, "conflict", "A model is already being trained")
        if not project.get("holdout"):
            raise APIError(
                409, "conflict",
                "Run the hold-out check first: without it a new model could not be scored honestly",
            )  # fmt: skip
        ready = project["counts"].get("passed", 0) + project["counts"].get("human_done", 0)
        if not ready and not store.list(f"projects/{project_id}/dataset_versions", limit=1):
            raise APIError(409, "conflict", "No frame has passed the check or been checked by a person yet")
    elif job_type == "qa":
        if busy(store, project_id, "qa"):
            raise APIError(409, "conflict", "Labels are already being checked")
        holdout = project.get("holdout")
        if not holdout:
            raise APIError(409, "conflict", "Run the hold-out check first")
        if not holdout.get("passed"):
            raise APIError(
                409, "conflict",
                f"The hold-out check did not pass (mean IoU {holdout.get('mean_iou')} against a minimum of "
                f"{holdout.get('threshold')}, n = {holdout.get('n_images')} images), so the full check may not start",
            )  # fmt: skip
        waiting = store.list(images, where={"label_status": "predicted"})
        if not waiting:
            raise APIError(409, "conflict", "There are no pre-labelled frames waiting for the check")
        config = load_agents_config()
        cap = config["limits"]["gemini_max_calls_per_project"]
        # Every frame failing every round, each answer needing its one retry.
        worst = len(waiting) * (config["agents"]["teacher_qa"]["thresholds"]["max_retries"] + 1) * 2
        left = cap - project.get("gemini_calls_used", 0)
        if worst > left:
            raise APIError(
                409, "conflict",
                f"Checking {len(waiting)} frames could take {worst} Gemini calls, and the project has {left} left of {cap}",
            )  # fmt: skip


@router.get("/projects/{project_id}/jobs")
def list_jobs(
    project_id: str, type: str | None = None, status: str | None = None
) -> dict[str, Any]:
    get_project_or_404(project_id)
    where = {k: v for k, v in {"type": type, "status": status}.items() if v}
    found = get_store().list(f"projects/{project_id}/jobs", where=where or None, descending=True)
    return {"jobs": found}


@router.get("/projects/{project_id}/jobs/{job_id}")
def get_job(project_id: str, job_id: str) -> dict[str, Any]:
    job = get_store().get(f"projects/{project_id}/jobs/{job_id}")
    if job is None:
        raise not_found("The job")
    return job


@router.post("/projects/{project_id}/jobs/{job_id}/cancel")
def cancel_job(project_id: str, job_id: str) -> dict[str, Any]:
    store = get_store()
    path = f"projects/{project_id}/jobs/{job_id}"
    job = store.get(path)
    if job is None:
        raise not_found("The job")
    if job["status"] != "queued":
        raise APIError(409, "conflict", f"A job that is {job['status']} cannot be cancelled")
    store.update(path, {"status": "cancelled", "finished_at": now_iso()})
    return store.get(path)


# --- versions -----------------------------------------------------------------------
@router.get("/projects/{project_id}/dataset-versions")
def list_dataset_versions(project_id: str) -> dict[str, Any]:
    get_project_or_404(project_id)
    return {"dataset_versions": get_store().list(f"projects/{project_id}/dataset_versions")}


@router.get("/projects/{project_id}/model-versions")
def list_model_versions(project_id: str) -> dict[str, Any]:
    """Oldest first: this is the data of the accuracy trend (docs/api.md)."""
    get_project_or_404(project_id)
    return {"model_versions": get_store().list(f"projects/{project_id}/model_versions")}


# --- images -------------------------------------------------------------------------
@router.get("/projects/{project_id}/images")
def list_images(
    project_id: str,
    status: str | None = None,
    role: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = None,
) -> dict[str, Any]:
    get_project_or_404(project_id)
    where = {k: v for k, v in {"label_status": status, "role": role}.items() if v}
    images = get_store().list(
        f"projects/{project_id}/images", where=where or None, limit=limit + 1, start_after=cursor
    )
    more = len(images) > limit
    images = images[:limit]
    return {"images": images, "next_cursor": images[-1]["id"] if more and images else None}


def _image_or_404(project_id: str, image_id: str) -> dict[str, Any]:
    image = get_store().get(f"projects/{project_id}/images/{image_id}")
    if image is None:
        raise not_found("The image")
    return image


@router.get("/projects/{project_id}/images/{image_id}")
def get_image(project_id: str, image_id: str) -> dict[str, Any]:
    image = _image_or_404(project_id, image_id)
    verdicts = get_store().list(f"projects/{project_id}/verdicts", where={"image_id": image_id})
    label = None
    if image.get("label_key"):
        label = json.loads(get_blobs().read_bytes(image["label_key"]))
    return {"image": image, "label": label, "verdicts": verdicts}


@router.get("/projects/{project_id}/images/{image_id}/file")
def get_image_file(
    project_id: str, image_id: str, w: int | None = Query(default=None, ge=64, le=1920)
) -> Response:
    """The image bytes, optionally narrowed for display. Storage keeps the original."""
    image = _image_or_404(project_id, image_id)
    data = get_blobs().read_bytes(image["key"])
    if w is not None and w < image["width"]:
        decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        height = max(1, round(decoded.shape[0] * w / decoded.shape[1]))
        small = cv2.resize(decoded, (w, height), interpolation=cv2.INTER_AREA)
        data = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 82])[1].tobytes()
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400, immutable"},  # frames never change
    )


# --- events -------------------------------------------------------------------------
@router.get("/projects/{project_id}/events")
def list_events(project_id: str, unread: bool = False) -> dict[str, Any]:
    get_project_or_404(project_id)
    events = get_store().list(
        f"projects/{project_id}/events", where={"read": False} if unread else None, descending=True
    )
    return {"events": events}


@router.post("/projects/{project_id}/events/{event_id}/read")
def mark_event_read(project_id: str, event_id: str) -> dict[str, Any]:
    store = get_store()
    path = f"projects/{project_id}/events/{event_id}"
    if store.get(path) is None:
        raise not_found("The notification")
    store.update(path, {"read": True})
    return store.get(path)
