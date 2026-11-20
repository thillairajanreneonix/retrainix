"""Agent 10 - dataset compiler (agents.yaml: dataset_compiler).

Master labels in, a model-ready dataset version out. Each export is a new immutable folder
`datasets/v<n>/`; originals are never touched, and resizing happens only here.

What goes in: frames that passed QA or were checked by a person, plus the gold exemplars
(labels a person verified). The gold hold-out never goes in - it is the exam.

The format is COCO segmentation in the layout CircularNet's training library reads:

    train/_annotations.coco.json   + the images beside it
    valid/_annotations.coco.json   + ...
    test/_annotations.coco.json    + ...      (only when there are test frames)

Images are squashed to the model's square input, not letterboxed, because that is how the
pre-label worker feeds the model (see annotator.py). Outlines are scaled with them.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from . import labels, notifier, orchestrator

if TYPE_CHECKING:
    from app.worker import JobContext

TRAINABLE = ("passed", "human_done")
# The app calls the validation split "val"; the training library looks for a folder "valid".
SPLIT_DIR = {"train": "train", "val": "valid", "test": "test"}


def ratios(config: dict[str, Any]) -> dict[str, float]:
    split = config["agents"]["dataset_compiler"]["split"]
    return {k: float(split[k]) for k in ("train", "val", "test")}


def trainable_images(store: Any, project_id: str) -> list[dict[str, Any]]:
    """Frames whose labels passed QA or were checked by a person. Never gold."""
    pool: list[dict[str, Any]] = []
    for status in TRAINABLE:
        pool += store.list(f"projects/{project_id}/images", where={"label_status": status})
    return [i for i in pool if i.get("role", "unlabelled") == "unlabelled"]


def assign_splits(images: list[dict[str, Any]], ratios: dict[str, float]) -> dict[str, str]:
    """image id -> train | val | test.

    By capture session when there are enough sessions to give every split one. Otherwise
    by blocks of time inside each session: the first part trains, the next validates, the
    last tests. Either way neighbouring frames, which are near-copies, are never dealt out
    at random between the splits."""
    by_session: dict[str, list[dict[str, Any]]] = {}
    for image in images:
        by_session.setdefault(image["session_id"], []).append(image)
    for frames in by_session.values():
        frames.sort(key=lambda i: (i.get("timestamp_s") or 0, i["id"]))

    out: dict[str, str] = {}
    sessions = sorted(by_session, key=lambda s: (-len(by_session[s]), s))
    if len(sessions) >= 5:
        total, running = len(images), 0
        for session in sessions:
            running += len(by_session[session])
            share = running / total  # where this session ENDS, so the last one always lands in test
            train_end, val_end = ratios["train"] + 1e-9, ratios["train"] + ratios["val"] + 1e-9
            split = "train" if share <= train_end else "val" if share <= val_end else "test"
            for image in by_session[session]:
                out[image["id"]] = split
        return out

    for frames in by_session.values():
        n = len(frames)
        n_train = max(1, round(n * ratios["train"])) if n >= 3 else n
        n_val = max(1, round(n * ratios["val"])) if n >= 3 else 0
        n_train = min(n_train, n - n_val - (1 if n >= 10 else 0))
        for k, image in enumerate(frames):
            out[image["id"]] = "train" if k < n_train else "val" if k < n_train + n_val else "test"
    if "val" not in out.values() and len(images) >= 2:
        # Every session was too short to spare a frame. Hold back the last frame of the
        # longest one, so there is always something to validate on.
        longest = max(by_session.values(), key=len)
        out[longest[-1]["id"]] = "val"
    return out


def coco_annotations(label: dict[str, Any], classes: list[str], size: int) -> list[dict[str, Any]]:
    """One COCO annotation per object, in pixels of the squashed size x size image.

    An object with no outline (a box a person drew that SAM has not outlined yet) is written
    as its box, so the model is taught a rectangle for that object. The
    bbox and area are computed from the outline itself, so they cannot disagree with it.
    category_id is 1-based, in the project's class order."""
    sx, sy = size / float(label["width"]), size / float(label["height"])
    out = []
    for obj in label["objects"]:
        if obj["class"] not in classes:
            continue
        points = obj.get("polygon_xy")
        if not points or len(points) < 3:
            x0, y0, x1, y1 = obj["bbox_xyxy"]
            points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        pts = np.array(
            [[min(float(size), max(0.0, x * sx)), min(float(size), max(0.0, y * sy))] for x, y in points],
            dtype=np.float32,
        )
        area = float(cv2.contourArea(pts))
        if area <= 1:
            continue  # too small to survive the squash; a degenerate outline breaks training
        x0, y0 = float(pts[:, 0].min()), float(pts[:, 1].min())
        x1, y1 = float(pts[:, 0].max()), float(pts[:, 1].max())
        out.append(
            {
                "category_id": classes.index(obj["class"]) + 1,
                "segmentation": [[round(float(v), 2) for point in pts for v in point]],
                "bbox": [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)],
                "area": round(area, 2),
                "iscrowd": 0,
            }
        )
    return out


def check_coco(coco: dict[str, Any], n_classes: int, size: int) -> str | None:
    """None when the annotation file is well formed, otherwise what is wrong with it."""
    image_ids = {i["id"] for i in coco["images"]}
    for ann in coco["annotations"]:
        if ann["image_id"] not in image_ids:
            return f"annotation {ann['id']}: its image is not in the file"
        if not 1 <= ann["category_id"] <= n_classes:
            return f"annotation {ann['id']}: category {ann['category_id']} is out of range"
        ring = ann["segmentation"][0]
        if len(ring) < 6 or len(ring) % 2:
            return f"annotation {ann['id']}: an outline needs at least three points"
        if any(not 0.0 <= v <= size for v in ring):
            return f"annotation {ann['id']}: a coordinate is outside the image"
    return None


def compile_job(ctx: JobContext) -> dict[str, Any]:
    from app.settings import load_models  # noqa: PLC0415
    from app.store import now_iso  # noqa: PLC0415

    store, blobs, pid = ctx.store, ctx.blobs, ctx.project_id
    cfg = ctx.config["agents"]["dataset_compiler"]
    project = store.get(f"projects/{pid}")
    classes = project["classes"]
    recipe = project["recipe"]
    fmt = cfg["formats"][recipe]
    if fmt["format"] != "coco_json":
        raise NotImplementedError(f"export to {fmt['format']} is not built yet")
    record = next(m for m in load_models() if m["id"] == recipe)
    size = int(record["seed"]["input_size"])

    pool = trainable_images(store, pid)
    exemplars = store.list(f"projects/{pid}/images", where={"role": "gold_exemplar"})

    if ctx.job["dry_run"]:
        return {"estimate": {"images": len(pool) + len(exemplars), "gemini_calls": 0, "gpu_minutes": 0}}
    if not pool:
        raise ValueError("no frame has passed the check or been checked by a person yet")

    splits = assign_splits(pool, ratios(ctx.config))
    for image in exemplars:
        splits[image["id"]] = "train"  # person-verified labels: the best training data there is
    if "val" not in splits.values():
        raise ValueError("too few frames to hold any back for validation")

    existing = store.list(f"projects/{pid}/dataset_versions")
    version = 1 + max((int(d["version"]) for d in existing), default=0)
    prefix = f"projects/{pid}/datasets/v{version}"

    summary = {s: {"images": 0, "objects": 0, "sessions": set()} for s in ("train", "val", "test")}
    categories = [{"id": i + 1, "name": c, "supercategory": "none"} for i, c in enumerate(classes)]
    coco = {s: {"info": {"description": f"Retrainix {pid} dataset v{version}"}, "licenses": [],
                "images": [], "annotations": [], "categories": categories} for s in summary}  # fmt: skip
    sources: dict[str, int] = {}
    per_class = dict.fromkeys(classes, 0)
    images = pool + exemplars
    for n, image in enumerate(images, start=1):
        split = splits[image["id"]]
        label = labels.read_label(blobs, image)
        annotations = coco_annotations(label, classes, size)
        frame = cv2.imdecode(np.frombuffer(blobs.read_bytes(image["key"]), np.uint8), cv2.IMREAD_COLOR)
        squashed = cv2.resize(frame, (size, size), interpolation=cv2.INTER_AREA)
        jpeg = cv2.imencode(".jpg", squashed, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()
        blobs.write_bytes(f"{prefix}/{SPLIT_DIR[split]}/{image['id']}.jpg", jpeg, "image/jpeg")
        image_no = len(coco[split]["images"]) + 1
        coco[split]["images"].append({"id": image_no, "file_name": f"{image['id']}.jpg", "width": size, "height": size})
        for ann in annotations:
            coco[split]["annotations"].append({"id": len(coco[split]["annotations"]) + 1, "image_id": image_no, **ann})

        summary[split]["images"] += 1
        summary[split]["objects"] += len(annotations)
        summary[split]["sessions"].add(image["session_id"])
        for obj in label["objects"]:
            source = "gemini_corrected" if obj.get("class_source") == "gemini" else obj["source"]
            sources[source] = sources.get(source, 0) + 1
            if obj["class"] in per_class:
                per_class[obj["class"]] += 1
        if n % 5 == 0:
            ctx.progress(n, len(images))
    ctx.progress(len(images), len(images))

    for split, doc in coco.items():
        if not doc["images"]:
            continue
        problem = check_coco(doc, len(classes), size)
        if problem:
            raise ValueError(f"{split} split: {problem}")
        key = f"{prefix}/{SPLIT_DIR[split]}/_annotations.coco.json"
        blobs.write_bytes(key, json.dumps(doc).encode("utf-8"), "application/json")

    split_summary = {s: {**v, "sessions": sorted(v["sessions"])} for s, v in summary.items()}
    doc = {
        "version": version,
        "gcs_prefix": f"{prefix}/",
        "gcs_uri": blobs.uri(prefix),
        "format": fmt["format"],
        "image_size": size,
        "images": sum(v["images"] for v in summary.values()),
        "splits": split_summary,
        "label_sources": dict(sorted(sources.items())),
        "objects_per_class": per_class,
        # Checked here for shape only; the training framework's own loader is the real test
        # and its result is recorded on the model version.
        "validated": True,
        "validated_by": "format_check",
        "created_at": now_iso(),
    }
    store.set(f"projects/{pid}/dataset_versions/{version:04d}", doc)
    orchestrator.advance(store, ctx.config, pid, "dataset_ready")
    n_images = sum(v["images"] for v in summary.values())
    notifier.emit(
        store, pid, "dataset_ready",
        f"Dataset version {version} is ready: {n_images} frames, {sum(v['objects'] for v in summary.values())} objects.",
        job_id=ctx.job["id"],
    )  # fmt: skip
    return {**{k: doc[k] for k in ("version", "gcs_prefix", "format", "image_size", "splits", "label_sources",
                                   "objects_per_class", "validated", "validated_by")}, "images": n_images}  # fmt: skip
