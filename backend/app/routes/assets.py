"""Uploads and assets (docs/api.md, "Uploads"). Files go browser -> storage directly."""
from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .. import jobs
from ..blobs import LocalBlobs
from ..deps import get_blobs, get_store
from ..errors import APIError, not_found
from ..settings import load_agents_config
from ..store import now_iso
from .projects import get_project_or_404

router = APIRouter(prefix="/api", tags=["uploads"])

# Which job a completed upload starts. Gold import arrives with the next phase.
JOB_FOR_KIND = {"video": "extract_frames"}


class UploadRequest(BaseModel):
    kind: Literal["video", "images", "gold_images", "gold_labels"]
    filename: str = Field(min_length=1, max_length=200)
    content_type: str = Field(min_length=1, max_length=100)
    size_bytes: int = Field(gt=0)
    source: Literal["file", "camera"] = "file"


def _safe_filename(name: str) -> str:
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "upload"


@router.post("/projects/{project_id}/uploads", status_code=201)
def start_upload(project_id: str, body: UploadRequest) -> dict[str, Any]:
    get_project_or_404(project_id)
    cap_mb = load_agents_config()["limits"]["max_upload_mb"]
    if body.size_bytes > cap_mb * 1024 * 1024:
        raise APIError(413, "too_large", f"The file is larger than the {cap_mb} MB limit")
    if body.kind == "video" and not body.content_type.startswith("video/"):
        raise APIError(422, "invalid_request", "content_type: a video file is needed here")

    asset_id = jobs.sortable_id("a")
    filename = _safe_filename(body.filename)
    folder = "gold" if body.kind.startswith("gold") else "raw"
    key = f"projects/{project_id}/{folder}/{asset_id}/{filename}"
    blobs = get_blobs()
    upload_url, headers = blobs.upload_url(key, body.content_type)

    get_store().set(
        f"projects/{project_id}/assets/{asset_id}",
        {
            "project_id": project_id,
            "kind": body.kind,
            "filename": filename,
            "content_type": body.content_type,
            "size_bytes": body.size_bytes,
            "source": body.source,
            "gcs_uri": blobs.uri(key),
            "key": key,
            "session_id": asset_id,  # one capture session per upload
            "status": "pending",
            "frames_extracted": 0,
            "frames_kept": 0,
            "job_id": None,
            "created_at": now_iso(),
        },
    )
    return {"asset_id": asset_id, "upload_url": upload_url, "method": "PUT", "headers": headers}


@router.post("/projects/{project_id}/assets/{asset_id}/complete", status_code=202)
def complete_upload(project_id: str, asset_id: str) -> dict[str, Any]:
    store, blobs = get_store(), get_blobs()
    path = f"projects/{project_id}/assets/{asset_id}"
    asset = store.get(path)
    if asset is None:
        raise not_found("The upload")
    if asset["status"] != "pending":
        raise APIError(409, "conflict", f"This upload is already {asset['status']}")
    if not blobs.exists(asset["key"]):
        raise APIError(409, "conflict", "The file has not arrived in storage yet")
    job_type = JOB_FOR_KIND.get(asset["kind"])
    if job_type is None:
        raise APIError(501, "not_implemented", f"{asset['kind']} uploads are not built yet")

    job = jobs.create_job(store, project_id, job_type, {"asset_id": asset_id})
    store.update(
        path, {"status": "uploaded", "size_bytes": blobs.size(asset["key"]), "job_id": job["id"]}
    )
    jobs.dispatch(store, project_id, job["id"])
    return store.get(f"projects/{project_id}/jobs/{job['id']}")


@router.get("/projects/{project_id}/assets")
def list_assets(project_id: str) -> dict[str, Any]:
    get_project_or_404(project_id)
    # An upload that was started but never completed ("pending") is not shown: the file may
    # never have arrived. It appears once it is marked complete.
    assets = get_store().list(f"projects/{project_id}/assets", descending=True)
    return {"assets": [a for a in assets if a["status"] != "pending"]}


# --- local development only -------------------------------------------------------
local_router = APIRouter(prefix="/api/_local", include_in_schema=False)


@local_router.put("/upload/{key:path}")
async def local_upload(key: str, request: Request) -> dict[str, Any]:
    """Stands in for the signed Cloud Storage URL when files are kept in a local folder."""
    blobs = get_blobs()
    if not isinstance(blobs, LocalBlobs):
        raise not_found("This address")
    target = blobs.path(key)
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    with open(target, "wb") as fh:
        async for chunk in request.stream():
            fh.write(chunk)
            size += len(chunk)
    return {"size_bytes": size}
