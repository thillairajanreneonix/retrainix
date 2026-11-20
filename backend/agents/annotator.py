"""Agent 7 - annotator (agents.yaml: annotator_model; plan.md A1.1).

The project's own model labels the frames. The model is CircularNet - Google's published
weights until the project has trained its own version - as an ONNX file run with onnxruntime
on CPU, so the worker needs no deep-learning framework. The decoder turns its raw outputs
into boxes, outlines, class names and scores, all in pixels of the original image.

The CircularNet pre- and post-processing is the camera dashboard's (docs/reuse.md): squash
to 432x432, ImageNet normalisation, sigmoid over the class logits with index 0 = background.
"""
from __future__ import annotations

import json
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from . import labels, orchestrator

if TYPE_CHECKING:
    from app.worker import JobContext

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
MAX_POLYGON_POINTS = 120
# Where a model trained here keeps its first class in the class logits (see decode_rfdetr_seg).
TRAINED_FIRST_CLASS_INDEX = 0


@dataclass
class Detection:
    class_name: str  # the MODEL's class name, before the project's class map
    score: float
    box: tuple[float, float, float, float]  # x0, y0, x1, y1 in original pixels
    polygon: list[list[float]] | None  # outline in original pixels


# --- geometry helpers ---------------------------------------------------------------
def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50)))


def box_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def nms(detections: list[Detection], iou_threshold: float) -> list[Detection]:
    """Per-class non-maximum suppression: keep the highest score among overlapping boxes."""
    kept: list[Detection] = []
    for det in sorted(detections, key=lambda d: d.score, reverse=True):
        if all(
            k.class_name != det.class_name or box_iou(k.box, det.box) <= iou_threshold
            for k in kept
        ):
            kept.append(det)
    return kept


def one_label_per_object(detections: list[Detection], iou_threshold: float) -> list[Detection]:
    """A model can put two different classes on the same object (per-class suppression keeps
    both). A label needs one answer per object, so the lower score of such a pair is dropped."""
    kept: list[Detection] = []
    for det in sorted(detections, key=lambda d: d.score, reverse=True):
        if all(box_iou(k.box, det.box) <= iou_threshold for k in kept):
            kept.append(det)
    return kept


def mask_to_polygon(mask: np.ndarray, scale_x: float, scale_y: float) -> list[list[float]] | None:
    """Outline of the largest blob in a binary mask, scaled into original pixels."""
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 4:
        return None
    epsilon = 0.75
    points = cv2.approxPolyDP(contour, epsilon, True)
    while len(points) > MAX_POLYGON_POINTS:
        epsilon *= 1.5
        points = cv2.approxPolyDP(contour, epsilon, True)
    if len(points) < 3:
        return None
    return [[round(float(x) * scale_x, 1), round(float(y) * scale_y, 1)] for x, y in points[:, 0, :]]


# --- decoders -----------------------------------------------------------------------
def preprocess_rfdetr(image_bgr: np.ndarray, size: int) -> np.ndarray:
    rgb = cv2.cvtColor(cv2.resize(image_bgr, (size, size)), cv2.COLOR_BGR2RGB)
    x = (rgb.astype(np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)


def decode_rfdetr_seg(
    outputs: list[np.ndarray], classes: list[str], shape: tuple[int, int], size: int, conf: float,
    first: int = 1,
) -> list[Detection]:  # fmt: skip
    """CircularNet: dets [1, 200, 4] normalised cxcywh, labels [1, 200, 1 + nc] logits,
    masks [1, 200, M, M] logits.

    `first` is the logit index of the first class. Google's published model keeps index 0 for
    background, so its classes start at 1. A version trained here has its classes at 0..nc-1
    and the spare logit at the end (the training library numbers classes from 0)."""
    height, width = shape
    boxes, logits = outputs[0][0], outputs[1][0]
    masks = outputs[2][0] if len(outputs) > 2 else None
    probs = _sigmoid(logits)[:, first:first + len(classes)]
    cls = probs.argmax(axis=1)
    score = probs[np.arange(len(cls)), cls]
    found: list[Detection] = []
    for i in np.where(score >= conf)[0]:
        cx, cy, bw, bh = (float(v) for v in boxes[i])
        x0, y0 = max(0.0, (cx - bw / 2) * width), max(0.0, (cy - bh / 2) * height)
        x1, y1 = min(float(width), (cx + bw / 2) * width), min(float(height), (cy + bh / 2) * height)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        polygon = None
        if masks is not None:
            mask = cv2.resize(_sigmoid(masks[i]), (size, size), interpolation=cv2.INTER_LINEAR) > 0.5
            polygon = mask_to_polygon(mask, width / size, height / size)
        found.append(
            Detection(
                classes[int(cls[i])], float(score[i]),
                (round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)), polygon,
            )  # fmt: skip
        )
    return found


# --- model --------------------------------------------------------------------------
class OnnxModel:
    """One labelling model: an ONNX session plus the decoder its recipe names."""

    def __init__(self, path: Path, decoder: str, input_size: int, classes: list[str], first_class_index: int = 1) -> None:
        import onnxruntime as ort  # noqa: PLC0415 - heavy; only the worker needs it

        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.decoder, self.size, self.classes = decoder, int(input_size), list(classes)
        self.first = int(first_class_index)
        if decoder != "rfdetr_seg":
            raise ValueError(f"unknown decoder: {decoder}")

    def predict_once(self, image_bgr: np.ndarray, conf: float) -> list[Detection]:
        shape = image_bgr.shape[:2]
        outputs = self.session.run(None, {self.input_name: preprocess_rfdetr(image_bgr, self.size)})
        return decode_rfdetr_seg(outputs, self.classes, shape, self.size, conf, self.first)

    def predict(self, image_bgr: np.ndarray, profile: dict[str, Any]) -> list[Detection]:
        conf = float(profile["conf"])
        if not profile.get("tiled"):
            return self.predict_once(image_bgr, conf)
        return predict_tiled(
            self, image_bgr, conf, int(profile["tile_cols"]), int(profile["tile_rows"]),
            float(profile["tile_overlap"]), float(profile["nms_iou"]),
        )  # fmt: skip


def tile_windows(
    width: int, height: int, cols: int, rows: int, overlap: float
) -> list[tuple[int, int, int, int]]:
    """Overlapping windows that cover the image: (x0, y0, x1, y1)."""
    tile_w = int(np.ceil(width / (cols - (cols - 1) * overlap)))
    tile_h = int(np.ceil(height / (rows - (rows - 1) * overlap)))
    xs = [round(c * (width - tile_w) / max(1, cols - 1)) for c in range(cols)]
    ys = [round(r * (height - tile_h) / max(1, rows - 1)) for r in range(rows)]
    return [(x, y, min(width, x + tile_w), min(height, y + tile_h)) for y in ys for x in xs]


def predict_tiled(
    model: Any, image_bgr: np.ndarray, conf: float, cols: int, rows: int, overlap: float,
    nms_iou: float,
) -> list[Detection]:  # fmt: skip
    """Run the model on overlapping tiles so small objects reach it at a larger scale,
    then shift the results back and drop the duplicates the overlaps create."""
    height, width = image_bgr.shape[:2]
    merged: list[Detection] = []
    for x0, y0, x1, y1 in tile_windows(width, height, cols, rows, overlap):
        for det in model.predict_once(image_bgr[y0:y1, x0:x1], conf):
            bx0, by0, bx1, by1 = det.box
            polygon = [[px + x0, py + y0] for px, py in det.polygon] if det.polygon else None
            merged.append(
                Detection(det.class_name, det.score, (bx0 + x0, by0 + y0, bx1 + x0, by1 + y0), polygon)
            )
    return nms(merged, nms_iou)


# --- class map ----------------------------------------------------------------------
def suggest_class_map(model_classes: list[str], project_classes: list[str]) -> dict[str, str]:
    """Map a model class to a project class when the project class name appears in the
    model class's material part - the text before the first "_". So "Plastics-HDPE_Bottle"
    becomes "plastic", while "Fiber_Cup-&-glass" does not become "glass"."""
    mapping: dict[str, str] = {}
    by_length = sorted(project_classes, key=len, reverse=True)  # longest name wins
    for name in model_classes:
        material = name.split("_", 1)[0].lower()
        for project_class in by_length:
            if project_class.lower() in material:
                mapping[name] = project_class
                break
    return mapping


# --- the job ------------------------------------------------------------------------
def model_spec(models: list[dict[str, Any]], recipe: str) -> dict[str, Any]:
    for record in models:
        if record["id"] == recipe:
            if not record.get("seed"):
                raise ValueError(f"{recipe} has no seed weights configured")
            return record
    raise ValueError(f"unknown recipe: {recipe}")


def load_model(ctx: JobContext, record: dict[str, Any], cache_dir: Path) -> OnnxModel:
    """Fetch the recipe's ONNX file and open it. A separate function so tests can swap it."""
    seed = record["seed"]
    local = cache_dir / Path(seed["onnx_key"]).name
    if not local.is_file():
        ctx.blobs.download_to(seed["onnx_key"], local)
    return OnnxModel(local, seed["decoder"], seed["input_size"], record["classes"], seed.get("first_class_index", 1))


def open_trained(path: Path, record: dict[str, Any], classes: list[str]) -> OnnxModel:
    """A model this project trained: same decoder as its recipe, the project's own classes."""
    return OnnxModel(path, record["seed"]["decoder"], record["seed"]["input_size"], classes, TRAINED_FIRST_CLASS_INDEX)


def active_model(
    ctx: JobContext, project: dict[str, Any], cache_dir: Path
) -> tuple[Any, dict[str, Any], dict[str, str]]:
    """The model that labels for this project right now: (model, {recipe, version}, class map).

    Version 0 is the pre-label recipe's seed weights, read through the project's class map.
    A trained version speaks the project's own classes, so its map is the identity."""
    from app.settings import load_models  # noqa: PLC0415

    version = int(project.get("active_model_version") or 0)
    if version == 0:
        recipe = project["prelabel_recipe"]
        model = load_model(ctx, model_spec(load_models(), recipe), cache_dir)
        return model, {"recipe": recipe, "version": 0}, project.get("class_map") or {}
    recipe = project["recipe"]
    record = model_spec(load_models(), recipe)
    key = f"projects/{ctx.project_id}/weights/v{version}/best.onnx"
    seed = {**record["seed"], "onnx_key": key, "first_class_index": TRAINED_FIRST_CLASS_INDEX}
    trained = {**record, "classes": project["classes"], "seed": seed}
    identity = {c: c for c in project["classes"]}
    return load_model(ctx, trained, cache_dir), {"recipe": recipe, "version": version}, identity


def to_master_label(
    image: dict[str, Any], detections: list[Detection], class_map: dict[str, str],
    label_model: dict[str, Any], min_area_px: float, round_no: int = 0,
) -> tuple[dict[str, Any], int]:  # fmt: skip
    """Master label format (docs/schemas.md section 2) and the number of dropped objects."""
    objects, unmapped = [], 0
    for det in sorted(detections, key=lambda d: d.score, reverse=True):
        project_class = class_map.get(det.class_name)
        if project_class is None:
            unmapped += 1
            continue
        x0, y0, x1, y1 = det.box
        if (x1 - x0) * (y1 - y0) < min_area_px:
            continue  # noise, by the project's own threshold
        objects.append(
            {
                "id": f"o{len(objects) + 1}",
                "class": project_class,
                "bbox_xyxy": [x0, y0, x1, y1],
                "polygon_xy": det.polygon,
                "mask_rle": None,
                "source": "model",
                "score": round(det.score, 4),
                "round": round_no,
                "model_class": det.class_name,
            }
        )
    label = {
        "image_id": image["id"],
        "width": image["width"],
        "height": image["height"],
        "round": round_no,
        "label_model": label_model,
        "objects": objects,
    }
    return label, unmapped


def images_to_label(ctx: JobContext) -> list[dict[str, Any]]:
    store, pid = ctx.store, ctx.project_id
    wanted = ctx.job["params"].get("image_ids")
    if wanted:
        images = [store.get(f"projects/{pid}/images/{i}") for i in wanted]
        return [i for i in images if i is not None and i["role"] == "unlabelled"]
    images = store.list(f"projects/{pid}/images", where={"label_status": "none"})
    return [i for i in images if i["role"] == "unlabelled"]


def prelabel_job(ctx: JobContext) -> dict[str, Any]:
    store, blobs, pid = ctx.store, ctx.blobs, ctx.project_id
    cfg = ctx.config["agents"]["annotator_model"]
    profile_name = ctx.job["params"].get("profile", "default")
    if profile_name not in cfg["profiles"]:
        raise ValueError(f"unknown profile: {profile_name}")
    profile = cfg["profiles"][profile_name]
    min_area = float(ctx.config["agents"]["teacher_qa"]["thresholds"]["min_mask_area_px"])
    cross_class_iou = float(cfg["cross_class_nms_iou"])

    project = store.get(f"projects/{pid}")
    images = images_to_label(ctx)
    if ctx.job["dry_run"]:
        return {"estimate": {"images": len(images), "gemini_calls": 0, "gpu_minutes": 0}}
    if not images:
        raise ValueError("there are no unlabelled frames to pre-label")


    started = time.time()
    per_class: dict[str, int] = {}
    total_objects = total_unmapped = empty = 0
    with tempfile.TemporaryDirectory(prefix="retrainix-model-") as tmp:
        # Until the project has trained its own model, the recipe's seed weights do the labelling.
        model, which, class_map = active_model(ctx, project, Path(tmp))
        label_model = {**which, "profile": profile_name}
        for n, image in enumerate(images, start=1):
            frame = cv2.imdecode(np.frombuffer(blobs.read_bytes(image["key"]), np.uint8), cv2.IMREAD_COLOR)
            detections = one_label_per_object(model.predict(frame, profile), cross_class_iou)
            label, unmapped = to_master_label(image, detections, class_map, label_model, min_area)
            key = f"projects/{pid}/labels/{image['id']}/r0.json"
            blobs.write_bytes(key, json.dumps(label).encode("utf-8"), "application/json")
            store.update(
                f"projects/{pid}/images/{image['id']}",
                {
                    "label_status": "predicted",
                    "round": 0,
                    "label_uri": blobs.uri(key),
                    "label_key": key,
                    "object_count": len(label["objects"]),
                    "missing_outlines": labels.missing_outlines(label),
                },
            )
            total_objects += len(label["objects"])
            total_unmapped += unmapped
            empty += 0 if label["objects"] else 1
            for obj in label["objects"]:
                per_class[obj["class"]] = per_class.get(obj["class"], 0) + 1
            ctx.progress(n, len(images))

    store.increment(f"projects/{pid}", {"counts.predicted": len(images)})
    orchestrator.advance(store, ctx.config, pid, "labelling")
    seconds = time.time() - started
    return {
        "images": len(images),
        "objects": total_objects,
        "objects_per_image_mean": round(total_objects / len(images), 1),
        "images_with_no_objects": empty,
        "unmapped_objects": total_unmapped,
        "per_class": dict(sorted(per_class.items())),
        "label_model": label_model,
        "seconds": round(seconds, 1),
        "seconds_per_image": round(seconds / len(images), 2),
    }
