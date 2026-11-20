"""Model weights download and the retrain schedule (docs/api.md, "Dataset, training ...")."""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse

from agents import dataset_compiler

from .. import jobs
from ..blobs import LocalBlobs
from ..deps import get_blobs, get_store
from ..errors import APIError, not_found
from ..settings import get_settings, load_agents_config
from ..store import now_iso
from .projects import get_project_or_404
from .work import busy

router = APIRouter(tags=["train"])


@router.get("/api/projects/{project_id}/model-versions/{version}/weights")
def weights_link(project_id: str, version: int, format: str = Query(default="onnx", pattern="^(pt|onnx)$")) -> dict[str, Any]:
    project = get_project_or_404(project_id)
    doc = get_store().get(f"projects/{project_id}/model_versions/{version:04d}")
    if doc is None:
        raise not_found("The model version")
    if not (doc.get("weights") or {}).get(format):
        raise APIError(404, "not_found", f"Version {version} has no {format} file to download")
    key = f"projects/{project_id}/weights/v{version}/best.{format}"
    slug = re.sub(r"[^a-z0-9]+", "-", project["name"].lower()).strip("-") or "project"
    filename = f"retrainix-{slug}-v{version}.{format}"
    return {"url": get_blobs().download_url(key, filename), "filename": filename}


# --- the schedule -------------------------------------------------------------------
def _parse(ts: str | None) -> datetime | None:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None


def decide(project: dict[str, Any], store: Any, config: dict[str, Any], now: datetime) -> tuple[bool, str]:
    """Should a scheduled retrain start for this project now? (yes/no, why)."""
    pid = project["id"]
    rules = config["agents"]["orchestrator"]["schedule"]
    hours = project.get("retrain_interval_hours")
    if not hours:
        return False, "no schedule is set"
    if not project.get("holdout"):
        return False, "the hold-out check has not run, so a new model could not be scored"
    since = _parse(project.get("last_retrain_at")) or _parse(project.get("schedule_set_at"))
    if since and now < since + timedelta(hours=float(hours)):
        due = (since + timedelta(hours=float(hours))).strftime("%Y-%m-%d %H:%M UTC")
        return False, f"the interval of {hours} h has not passed yet (next run is due {due})"
    if busy(store, pid, "train"):
        return False, "a model is already being trained"

    # Approved frames added since the last dataset version: only they are a reason to retrain.
    versions = store.list(f"projects/{pid}/dataset_versions")
    in_last = versions[-1]["images"] if versions else 0
    approved = len(dataset_compiler.trainable_images(store, pid)) + int(project["counts"].get("gold_exemplar", 0))
    new = approved - in_last
    need = int(rules["min_new_approved_images"])
    if new < need:
        return False, f"only {max(new, 0)} new checked frames since the last dataset version; {need} are needed"
    return True, f"{new} new checked frames since the last dataset version"


def _verify_scheduler(request: Request) -> None:
    """/internal/tick is for Cloud Scheduler only: a Google-signed identity token for this
    service, issued to the scheduler's service account."""
    s = get_settings()
    if not s.tick_audience and not s.tick_service_account:
        return  # a laptop
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise APIError(401, "unauthorized", "A Google-signed identity token is required")
    from google.auth.transport import requests as google_requests  # noqa: PLC0415
    from google.oauth2 import id_token  # noqa: PLC0415

    try:
        claims = id_token.verify_oauth2_token(header[7:], google_requests.Request(), audience=s.tick_audience)
    except Exception as exc:
        raise APIError(401, "unauthorized", "The identity token is not valid for this service") from exc
    if claims.get("email") != s.tick_service_account or not claims.get("email_verified"):
        raise APIError(403, "forbidden", "This account may not call the scheduler endpoint")


@router.post("/internal/tick")
def tick(request: Request) -> dict[str, Any]:
    _verify_scheduler(request)
    store, config = get_store(), load_agents_config()
    now = datetime.now(UTC)
    started, skipped, checked = [], [], 0
    for project in store.list("projects"):
        if not project.get("retrain_interval_hours"):
            continue
        checked += 1
        go, reason = decide(project, store, config, now)
        pid = project["id"]
        store.update(
            f"projects/{pid}",
            {"last_tick": {"at": now_iso(), "decision": "started" if go else "skipped", "reason": reason}},
        )
        if not go:
            skipped.append({"project_id": pid, "reason": reason})
            continue
        job = jobs.create_job(store, pid, "train", {"compile_first": True}, trigger="schedule")
        # Stamp the run now, so the next tick does not start a second one while this one trains.
        store.update(f"projects/{pid}", {"last_retrain_at": now_iso()})
        jobs.dispatch(store, pid, job["id"])
        started.append({"project_id": pid, "job_id": job["id"]})
    return {"checked": checked, "started": started, "skipped": skipped}


# --- local development only ---------------------------------------------------------
local_router = APIRouter(prefix="/api/_local", include_in_schema=False)


@local_router.get("/download/{key:path}")
def local_download(key: str, filename: str = "download") -> FileResponse:
    """Stands in for the signed Cloud Storage link when files are kept in a local folder."""
    blobs = get_blobs()
    if not isinstance(blobs, LocalBlobs) or not blobs.exists(key):
        raise not_found("This file")
    return FileResponse(blobs.path(key), filename=filename)
