"""SAM outlines (agents.yaml: outliner_sam; docs/api.md "SAM outlines").

A box a person draws in review has no outline. MobileSAM, prompted with that box, draws one.
SAM decides the SHAPE only: the object's class, box, score and source are never touched.

This is the camera dashboard's method (tools/annotate_with_sam.py: a box in, a mask out),
reused under plan.md A1.7. It runs on CPU - measured 20 Nov 2026 on a laptop CPU: about 3 s
for a frame with 40 boxes, 0.8 s for one box - and only in the trainer image, the one that
carries the framework it needs. The import is inside `run_sam`, so everything else, and every
test, runs without it.
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from . import annotator, labels

if TYPE_CHECKING:
    from app.worker import JobContext

# Frames whose labels may still be given outlines. Gold frames are read-only and never listed.
OUTLINABLE = ("predicted", "passed", "human_review", "human_done")
_models: dict[str, Any] = {}


def run_sam(weights: Path, image_bgr: np.ndarray, boxes: list[list[float]]) -> list[np.ndarray | None]:
    """One mask (HxW, bool) per box, or None where SAM gave nothing. A separate function so
    tests can put a stand-in in its place."""
    from ultralytics import SAM  # noqa: PLC0415 - only in the trainer image

    key = str(weights)
    if key not in _models:
        _models[key] = SAM(key)
    result = _models[key].predict(image_bgr, bboxes=boxes, device="cpu", verbose=False)[0]
    masks = result.masks.data.cpu().numpy().astype(bool) if result.masks is not None else []
    return [masks[i] if i < len(masks) else None for i in range(len(boxes))]


def polygon_for(mask: np.ndarray | None, box: list[float], pad: int) -> list[list[float]] | None:
    """The outline of a mask, kept within its (slightly padded) box so it cannot leak onto a
    neighbouring object."""
    if mask is None or not mask.any():
        return None
    height, width = mask.shape[:2]
    x0, y0 = max(0, int(box[0]) - pad), max(0, int(box[1]) - pad)
    x1, y1 = min(width, int(np.ceil(box[2])) + pad), min(height, int(np.ceil(box[3])) + pad)
    clipped = np.zeros_like(mask, dtype=bool)
    clipped[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    return annotator.mask_to_polygon(clipped, 1.0, 1.0)


def images_missing(store: Any, project_id: str, image_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """Frames that are not gold and have at least one object with a box but no outline."""
    images = store.list(f"projects/{project_id}/images")
    wanted = set(image_ids) if image_ids else None
    return [
        i for i in images
        if i.get("role", "unlabelled") == "unlabelled"
        and i.get("label_status") in OUTLINABLE
        and int(i.get("missing_outlines") or 0) > 0
        and (wanted is None or i["id"] in wanted)
    ]  # fmt: skip


def outline_images(ctx: JobContext, images: list[dict[str, Any]]) -> dict[str, Any]:
    """Draw the missing outlines on these frames. Each frame gets a new label round; its
    status stays as it was."""
    store, blobs, pid = ctx.store, ctx.blobs, ctx.project_id
    cfg = ctx.config["agents"]["outliner_sam"]
    pad = int(cfg["box_pad_px"])
    started = time.time()
    done = failed = touched = 0
    with tempfile.TemporaryDirectory(prefix="retrainix-sam-") as tmp:
        weights = Path(tmp) / Path(cfg["weights_key"]).name
        blobs.download_to(cfg["weights_key"], weights)
        for n, image in enumerate(images, start=1):
            label = labels.read_label(blobs, image)
            todo = [o for o in label["objects"] if o.get("polygon_xy") is None]
            if todo:
                frame = cv2.imdecode(np.frombuffer(blobs.read_bytes(image["key"]), np.uint8), cv2.IMREAD_COLOR)
                masks = run_sam(weights, frame, [o["bbox_xyxy"] for o in todo])
                outlines = {o["id"]: polygon_for(m, o["bbox_xyxy"], pad) for o, m in zip(todo, masks, strict=True)}
                objects = []
                for obj in label["objects"]:
                    obj = dict(obj)
                    if obj["id"] in outlines:
                        if outlines[obj["id"]] is None:
                            failed += 1
                        else:
                            obj["polygon_xy"] = outlines[obj["id"]]
                            obj["outline_source"] = "sam"
                            done += 1
                    objects.append(obj)
                labels.write_round(store, blobs, pid, image, labels.next_round(label, objects), image["label_status"])
                touched += 1
            ctx.progress(n, len(images))
    return {
        "images": touched,
        "objects": done,
        "failed_objects": failed,
        "model": cfg["model"],
        "seconds": round(time.time() - started, 1),
    }


def outline_job(ctx: JobContext) -> dict[str, Any]:
    images = images_missing(ctx.store, ctx.project_id, ctx.job["params"].get("image_ids"))
    if ctx.job["dry_run"]:
        objects = sum(int(i.get("missing_outlines") or 0) for i in images)
        return {"estimate": {"images": len(images), "objects": objects, "gemini_calls": 0, "gpu_minutes": 0}}
    if not images:
        raise ValueError("no object is missing an outline")
    return outline_images(ctx, images)
