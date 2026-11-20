"""Agent 9 - human review router (agents.yaml: human_review_router), and the gold set.

A person accepts, fixes or rejects a frame's label. Frames a person has checked can then be
frozen into the gold set: 20 exemplars and a 10-frame hold-out that no job may change.
"""
from __future__ import annotations

import json
from typing import Any

from . import labels


class ReviewError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def apply_review(
    store: Any, blobs: Any, project: dict[str, Any], image: dict[str, Any], action: str,
    objects: list[dict[str, Any]] | None, at: str,
) -> tuple[dict[str, Any], dict[str, Any] | None]:  # fmt: skip
    pid = project["id"]
    if image.get("role", "unlabelled") != "unlabelled":
        raise ReviewError(403, "Gold frames cannot be changed")
    label = labels.read_label(blobs, image)
    if label is None:
        raise ReviewError(409, "This frame has no label yet; pre-label it first")

    if action == "reject":
        labels.set_status(store, pid, image, "rejected")
        return image, label

    if action == "accept":
        new_objects = [dict(o) for o in label["objects"]]
    elif action == "fix":
        new_objects = _fixed_objects(label, objects or [], project["classes"], image)
    else:
        raise ReviewError(422, "action must be accept, fix or reject")

    new_label = labels.next_round(label, new_objects)
    new_label["review"] = {"by": "human", "action": action, "at": at}
    for obj in new_label["objects"]:
        obj["round"] = obj.get("round", new_label["round"])
    labels.write_round(store, blobs, pid, image, new_label, "human_done")
    return image, new_label


def _fixed_objects(
    label: dict[str, Any], submitted: list[dict[str, Any]], classes: list[str], image: dict[str, Any]
) -> list[dict[str, Any]]:
    existing = {o["id"]: o for o in label["objects"]}
    seen: set[str] = set()
    fixed = []
    for entry in submitted:
        cls, box = entry.get("class"), entry.get("bbox_xyxy")
        if cls not in classes:
            raise ReviewError(422, f"{cls} is not a class of this project")
        if not (isinstance(box, list) and len(box) == 4):
            raise ReviewError(422, "bbox_xyxy must be four numbers")
        x0, y0, x1, y1 = (float(v) for v in box)
        x0, x1 = sorted((max(0.0, x0), min(float(image["width"]), x1)))
        y0, y1 = sorted((max(0.0, y0), min(float(image["height"]), y1)))
        if x1 - x0 < 1 or y1 - y0 < 1:
            raise ReviewError(422, "a box must be at least one pixel wide and tall")
        box = [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]

        old = existing.get(entry.get("id")) if entry.get("id") else None
        if old is not None and old["id"] not in seen:
            seen.add(old["id"])
            moved = any(abs(a - b) > 0.5 for a, b in zip(box, old["bbox_xyxy"], strict=True))
            obj = dict(old)
            if cls != old["class"] or moved:
                obj.update({"class": cls, "bbox_xyxy": box, "source": "human"})
                if moved:
                    obj["polygon_xy"] = None  # the old outline no longer fits the new box
            fixed.append(obj)
        else:
            fixed.append(
                {
                    "class": cls, "bbox_xyxy": box, "polygon_xy": None, "mask_rle": None,
                    "source": "human", "score": None, "round": int(label["round"]) + 1,
                }  # fmt: skip
            )
    return fixed


# --- gold set -----------------------------------------------------------------------
def _reviewed(store: Any, pid: str) -> list[dict[str, Any]]:
    images = store.list(f"projects/{pid}/images", where={"label_status": "human_done"})
    images = [i for i in images if i.get("role", "unlabelled") == "unlabelled"]
    return sorted(images, key=lambda i: (i["session_id"], i.get("timestamp_s") or 0, i["id"]))


def gold_status(store: Any, blobs: Any, config: dict[str, Any], project: dict[str, Any]) -> dict[str, Any]:
    pid = project["id"]
    rules = config["agents"]["data_intake"]["gold_set"]
    counts = project["counts"]
    frozen = bool(counts.get("gold_holdout"))
    status = {
        "frozen": frozen,
        "required_images": rules["required_images"],
        "exemplar_count": rules["exemplar_count"],
        "holdout_count": rules["holdout_count"],
        "min_examples_per_class": rules["min_examples_per_class"],
        "reviewed_images": 0,
        "objects_per_class": dict.fromkeys(project["classes"], 0),
        "ready_to_freeze": False,
        "blocking": [],
        "gold_exemplar": counts.get("gold_exemplar", 0),
        "gold_holdout": counts.get("gold_holdout", 0),
        "holdout_note": project.get("holdout_note"),
        "boxes_without_outline": 0,
    }
    if frozen:
        gold = store.list(f"projects/{pid}/images", where={"label_status": "gold"})
        for image in gold:
            for obj in labels.read_label(blobs, image)["objects"]:
                status["objects_per_class"][obj["class"]] = status["objects_per_class"].get(obj["class"], 0) + 1
        return status

    reviewed = _reviewed(store, pid)
    status["reviewed_images"] = len(reviewed)
    # Gold frames are read-only once frozen, so outlines have to be drawn before that.
    status["boxes_without_outline"] = sum(int(i.get("missing_outlines") or 0) for i in reviewed)
    # Only the frames that would be frozen count towards the per-class minimum.
    chosen = _choose(reviewed, rules)
    for image in chosen["exemplar"] + chosen["holdout"] if chosen else reviewed:
        for obj in labels.read_label(blobs, image)["objects"]:
            status["objects_per_class"][obj["class"]] = status["objects_per_class"].get(obj["class"], 0) + 1

    need = rules["required_images"]
    if len(reviewed) < need:
        status["blocking"].append(f"{len(reviewed)} of {need} frames have been checked by a person")
    minimum = rules["min_examples_per_class"]
    for cls in project["classes"]:
        have = status["objects_per_class"].get(cls, 0)
        if have < minimum:
            status["blocking"].append(f"{cls} has {have} of {minimum} examples")
    status["ready_to_freeze"] = not status["blocking"]
    return status


def _choose(reviewed: list[dict[str, Any]], rules: dict[str, Any]) -> dict[str, list[dict[str, Any]]] | None:
    """First 20 by (session, time) are exemplars, last 10 the hold-out; any between stay."""
    if len(reviewed) < rules["required_images"]:
        return None
    return {
        "exemplar": reviewed[: rules["exemplar_count"]],
        "holdout": reviewed[-rules["holdout_count"]:],
    }


def freeze_gold(
    store: Any, blobs: Any, config: dict[str, Any], project: dict[str, Any], at: str
) -> dict[str, Any]:
    pid = project["id"]
    status = gold_status(store, blobs, config, project)
    if status["frozen"]:
        raise ReviewError(409, "The gold set is already frozen")
    if not status["ready_to_freeze"]:
        raise ReviewError(409, "The gold set cannot be frozen yet: " + "; ".join(status["blocking"]))

    rules = config["agents"]["data_intake"]["gold_set"]
    chosen = _choose(_reviewed(store, pid), rules)
    for role, images in (("gold_exemplar", chosen["exemplar"]), ("gold_holdout", chosen["holdout"])):
        for image in images:
            label = labels.read_label(blobs, image)
            for obj in label["objects"]:
                obj["source"] = "gold"
            label["label_model"] = None
            label["gold"] = {"role": role, "frozen_at": at}
            image_key = f"projects/{pid}/gold/images/{image['id']}.jpg"
            label_key = f"projects/{pid}/gold/labels/{image['id']}.json"
            blobs.write_bytes(image_key, blobs.read_bytes(image["key"]), "image/jpeg")
            blobs.write_bytes(label_key, json.dumps(label).encode("utf-8"), "application/json")
            store.update(
                f"projects/{pid}/images/{image['id']}",
                {
                    "role": role, "label_status": "gold", "key": image_key,
                    "gcs_uri": blobs.uri(image_key), "label_key": label_key,
                    "label_uri": blobs.uri(label_key),
                },  # fmt: skip
            )

    holdout = chosen["holdout"]
    sessions = sorted({i["session_id"] for i in holdout})
    note = (
        f"The hold-out is {len(holdout)} frames from capture session"
        f"{'s' if len(sessions) > 1 else ''} {', '.join(sessions)}, "
        f"{holdout[0].get('timestamp_s')} s to {holdout[-1].get('timestamp_s')} s into the video."
    )
    n_gold = len(chosen["exemplar"]) + len(holdout)
    store.increment(
        f"projects/{pid}",
        {
            "counts.gold_exemplar": len(chosen["exemplar"]),
            "counts.gold_holdout": len(holdout),
            "counts.human_done": -n_gold,
            "counts.frames": -n_gold,
            "counts.predicted": -n_gold,
        },
    )
    store.update(f"projects/{pid}", {"holdout_note": note, "updated_at": at})
    return gold_status(store, blobs, config, store.get(f"projects/{pid}"))
