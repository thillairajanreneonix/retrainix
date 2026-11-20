"""Label one picture now (docs/api.md, "Labelling a live view").

The Dashboard sends a frame from the camera it is showing; the project's active model - the
same one that pre-labels uploads - labels it and the answer goes straight back. Nothing is
stored: no image, no label, no job. It is one frame per request, about a second each on CPU
once the model is open, so it is "what the model sees every few seconds", not real-time video.

The model is opened once and kept in memory, one model at a time (the service is small). It
is kept by the storage key of its weights, so every project still on Google's published
CircularNet shares one copy, and a project's own trained version can never be mistaken for
another's. Which class map applies is read from the project on every request.
"""
from __future__ import annotations

import hashlib
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from agents import annotator

from ..deps import get_blobs
from ..errors import APIError
from ..settings import load_agents_config
from .projects import get_project_or_404

router = APIRouter(prefix="/api", tags=["live"])

_open_model: dict[str, Any] = {}  # {"key": storage key of the weights, "model": the opened model}
_busy = threading.Lock()  # one picture at a time per instance; also guards _open_model
_cache_root: Path | None = None


class _Fetch:
    """What annotator.load_model needs from a job context: storage and the project id."""

    def __init__(self, project_id: str) -> None:
        self.blobs, self.project_id = get_blobs(), project_id


def _model_for(project_id: str, record: dict[str, Any]) -> Any:
    """The opened model for these weights. Called only while holding _busy."""
    global _cache_root
    key = record["seed"]["onnx_key"]
    if _open_model.get("key") != key:
        _open_model.clear()
        if _cache_root is None:
            _cache_root = Path(tempfile.mkdtemp(prefix="retrainix-live-"))
        for old in _cache_root.iterdir():  # the previous model's file; on Cloud Run /tmp is memory
            shutil.rmtree(old, ignore_errors=True)
        folder = _cache_root / hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
        folder.mkdir(parents=True, exist_ok=True)
        _open_model["model"] = annotator.load_model(_Fetch(project_id), record, folder)
        _open_model["key"] = key
    return _open_model["model"]


def reset_for_tests() -> None:
    _open_model.clear()


def _label(project: dict[str, Any], frame: np.ndarray, config: dict[str, Any]) -> dict[str, Any]:
    cfg = config["agents"]["annotator_model"]
    started = time.time()
    record, which, class_map = annotator.active_spec(project["id"], project)
    model = _model_for(project["id"], record)
    detections = annotator.one_label_per_object(
        model.predict(frame, cfg["profiles"]["default"]), float(cfg["cross_class_nms_iou"])
    )
    height, width = frame.shape[:2]
    min_area = float(config["agents"]["teacher_qa"]["thresholds"]["min_mask_area_px"])
    label_model = {**which, "profile": "default"}
    label, unmapped = annotator.to_master_label(
        {"id": "live", "width": width, "height": height}, detections, class_map, label_model, min_area
    )
    return {
        "width": width,
        "height": height,
        "label_model": label_model,
        "objects": [
            {k: o[k] for k in ("id", "class", "bbox_xyxy", "polygon_xy", "score", "model_class")} for o in label["objects"]
        ],
        "unmapped_objects": unmapped,
        "seconds": round(time.time() - started, 2),
    }


@router.post("/projects/{project_id}/predict")
async def predict(project_id: str, request: Request) -> dict[str, Any]:
    project = await run_in_threadpool(get_project_or_404, project_id)
    config = load_agents_config()
    limit_mb = config["agents"]["annotator_model"]["live_max_image_mb"]
    body = await request.body()
    if len(body) > int(limit_mb * 1024 * 1024):
        raise APIError(413, "too_large", f"The picture is larger than the {limit_mb} MB limit")
    frame = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR) if body else None
    if frame is None:
        raise APIError(422, "invalid_request", "body: a JPEG or PNG picture is needed here")
    if not _busy.acquire(blocking=False):
        raise APIError(429, "busy", "The model is still labelling the previous picture")
    try:
        # In a worker thread, so the service keeps answering other requests meanwhile.
        return await run_in_threadpool(_label, project, frame, config)
    finally:
        _busy.release()
