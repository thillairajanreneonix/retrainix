"""Agent 12 - evaluator (agents.yaml: evaluator_reporter; plan.md A1.6).

Scores a model against the frozen gold hold-out. The same function scores every model
version, the seed weights included (version 0), so the versions are comparable. Every
figure is returned with the counts behind it.

The hold-out check of the teacher loop (step A) is this same scoring, read as a gate:
mean IoU of the matched boxes against a minimum.
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from . import annotator, labels

if TYPE_CHECKING:
    from app.worker import JobContext

MATCH_IOU = 0.5
MAP_THRESHOLDS = [round(0.5 + 0.05 * i, 2) for i in range(10)]  # 0.50 .. 0.95


def _iou(a: list[float], b: list[float]) -> float:
    return annotator.box_iou(tuple(a), tuple(b))


def match(
    predicted: list[dict[str, Any]], gold: list[dict[str, Any]], threshold: float, same_class: bool
) -> list[tuple[int, int, float]]:
    """Greedy one-to-one matching, highest score first: (predicted index, gold index, IoU)."""
    order = sorted(range(len(predicted)), key=lambda i: predicted[i].get("score") or 0, reverse=True)
    taken: set[int] = set()
    pairs = []
    for i in order:
        best, best_j = 0.0, None
        for j, g in enumerate(gold):
            if j in taken or (same_class and g["class"] != predicted[i]["class"]):
                continue
            iou = _iou(predicted[i]["bbox_xyxy"], g["bbox_xyxy"])
            if iou > best:
                best, best_j = iou, j
        if best_j is not None and best >= threshold:
            taken.add(best_j)
            pairs.append((i, best_j, best))
    return pairs


def average_precision(
    frames: list[tuple[list[dict[str, Any]], list[dict[str, Any]]]], cls: str, threshold: float
) -> float | None:
    """Area under the precision-recall curve for one class. None when gold has no such object."""
    scored: list[tuple[float, bool]] = []
    n_gold = 0
    for predicted, gold in frames:
        p = [o for o in predicted if o["class"] == cls]
        g = [o for o in gold if o["class"] == cls]
        n_gold += len(g)
        hit = {i for i, _, _ in match(p, g, threshold, same_class=True)}
        scored.extend((o.get("score") or 0.0, i in hit) for i, o in enumerate(p))
    if n_gold == 0:
        return None
    scored.sort(key=lambda s: s[0], reverse=True)
    tp = np.cumsum([1 if hit else 0 for _, hit in scored]) if scored else np.array([])
    fp = np.cumsum([0 if hit else 1 for _, hit in scored]) if scored else np.array([])
    recall = np.concatenate(([0.0], tp / n_gold, [1.0])) if len(tp) else np.array([0.0, 1.0])
    precision = np.concatenate(([1.0], tp / np.maximum(tp + fp, 1), [0.0])) if len(tp) else np.array([1.0, 0.0])
    for k in range(len(precision) - 2, -1, -1):  # make precision non-increasing
        precision[k] = max(precision[k], precision[k + 1])
    return float(np.sum((recall[1:] - recall[:-1]) * precision[1:]))


def score(
    frames: list[tuple[list[dict[str, Any]], list[dict[str, Any]]]], classes: list[str]
) -> dict[str, Any]:
    """Metrics for (predicted objects, gold objects) per image."""
    n_gold = sum(len(g) for _, g in frames)
    n_model = sum(len(p) for p, _ in frames)
    ious: list[float] = []
    same_class = 0
    for predicted, gold in frames:
        for i, j, iou in match(predicted, gold, MATCH_IOU, same_class=False):
            ious.append(iou)
            same_class += predicted[i]["class"] == gold[j]["class"]
    matched = len(ious)

    per_class_recall: dict[str, dict[str, Any]] = {}
    for cls in classes:
        n = sum(1 for _, g in frames for o in g if o["class"] == cls)
        found = sum(
            len(match([o for o in p if o["class"] == cls], [o for o in g if o["class"] == cls],
                      MATCH_IOU, same_class=True))
            for p, g in frames
        )  # fmt: skip
        per_class_recall[cls] = {"recall": round(found / n, 4) if n else None, "n": n}

    def mean_ap(threshold: float) -> float | None:
        values = [ap for cls in classes if (ap := average_precision(frames, cls, threshold)) is not None]
        return float(np.mean(values)) if values else None

    map50 = mean_ap(0.5)
    all_maps = [m for t in MAP_THRESHOLDS if (m := mean_ap(t)) is not None]

    def ratio(a: int, b: int) -> float | None:
        return round(a / b, 4) if b else None

    return {
        "mean_iou": round(float(np.mean(ious)), 4) if ious else None,
        "n_images": len(frames),
        "n_objects_gold": n_gold,
        "n_objects_model": n_model,
        "matched": matched,
        "precision": ratio(matched, n_model),
        "recall": ratio(matched, n_gold),
        "class_agreement": ratio(same_class, matched),
        "map50": round(map50, 4) if map50 is not None else None,
        "map50_95": round(float(np.mean(all_maps)), 4) if all_maps else None,
        "per_class_recall": per_class_recall,
        "eval_set": "gold_holdout",
    }


def evaluate_on_holdout(
    ctx: JobContext, model: Any, label_model: dict[str, Any], profile: dict[str, Any],
    class_map: dict[str, str] | None = None,
) -> dict[str, Any]:  # fmt: skip
    """Label the hold-out images with `model` and score them against the human labels.
    Reads gold; writes nothing to it."""
    store, blobs, pid = ctx.store, ctx.blobs, ctx.project_id
    project = store.get(f"projects/{pid}")
    cfg = ctx.config["agents"]
    min_area = float(cfg["teacher_qa"]["thresholds"]["min_mask_area_px"])
    cross_iou = float(cfg["annotator_model"]["cross_class_nms_iou"])
    if class_map is None:
        class_map = project.get("class_map") or {}
    holdout = store.list(f"projects/{pid}/images", where={"role": "gold_holdout"})
    if not holdout:
        raise ValueError("the gold set is not frozen yet, so there is no hold-out to score against")

    frames = []
    for n, image in enumerate(holdout, start=1):
        frame = cv2.imdecode(np.frombuffer(blobs.read_bytes(image["key"]), np.uint8), cv2.IMREAD_COLOR)
        detections = annotator.one_label_per_object(model.predict(frame, profile), cross_iou)
        predicted, _ = annotator.to_master_label(image, detections, class_map, label_model, min_area)
        frames.append((predicted["objects"], labels.read_label(blobs, image)["objects"]))
        ctx.progress(n, len(holdout))
    return {**score(frames, project["classes"]), "label_model": label_model}


def holdout_check_job(ctx: JobContext) -> dict[str, Any]:
    """Teacher loop step A, and the baseline (version 0) of the accuracy trend."""
    from app.store import now_iso  # noqa: PLC0415

    store, pid = ctx.store, ctx.project_id
    project = store.get(f"projects/{pid}")
    threshold = float(ctx.config["agents"]["teacher_qa"]["thresholds"]["holdout_iou_min"])
    profile_name = "default"
    profile = ctx.config["agents"]["annotator_model"]["profiles"][profile_name]
    with tempfile.TemporaryDirectory(prefix="retrainix-model-") as tmp:
        model, which, class_map = annotator.active_model(ctx, project, Path(tmp))
        recipe, version = which["recipe"], which["version"]
        label_model = {**which, "profile": profile_name}
        result = evaluate_on_holdout(ctx, model, label_model, profile, class_map=class_map)

    result["threshold"] = threshold
    result["passed"] = result["mean_iou"] is not None and result["mean_iou"] >= threshold
    store.update(f"projects/{pid}", {"holdout": result, "updated_at": now_iso()})
    if version == 0:
        # The seed weights, scored before any training: where the trend chart starts.
        store.set(
            f"projects/{pid}/model_versions/0000",
            {
                "version": 0,
                "recipe": recipe,
                "parent": "seed",
                "dataset_version": None,
                "weights_uri": None,
                "status": "ready",
                "trigger": "seed",
                "metrics": result,
                "train_minutes": 0,
                "created_at": now_iso(),
            },
        )
    return result
