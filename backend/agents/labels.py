"""Reading and writing labels in the master format (docs/schemas.md section 2).

One file per image per round, never overwritten. The image document points at the latest
round and carries the status; the project counts follow every status change.
"""
from __future__ import annotations

import json
from typing import Any

# Statuses that have a counter on the project. "predicted" is cumulative and is counted
# where frames are pre-labelled; "none" and "gold" have no counter here.
COUNTED = ("passed", "human_review", "human_done", "rejected")


def missing_outlines(label: dict[str, Any]) -> int:
    """Objects that have a box but no outline (a box a person drew, or an empty model mask)."""
    return sum(1 for o in label["objects"] if o.get("polygon_xy") is None)


def read_label(blobs: Any, image: dict[str, Any]) -> dict[str, Any] | None:
    if not image.get("label_key"):
        return None
    return json.loads(blobs.read_bytes(image["label_key"]))


def set_status(store: Any, project_id: str, image: dict[str, Any], status: str) -> None:
    """Change an image's label status and keep the project counters in step."""
    old = image.get("label_status")
    if old == status:
        return
    store.update(f"projects/{project_id}/images/{image['id']}", {"label_status": status})
    deltas: dict[str, int] = {}
    if old in COUNTED:
        deltas[f"counts.{old}"] = -1
    if status in COUNTED:
        deltas[f"counts.{status}"] = 1
    if deltas:
        store.increment(f"projects/{project_id}", deltas)
    image["label_status"] = status


def write_round(
    store: Any, blobs: Any, project_id: str, image: dict[str, Any], label: dict[str, Any], status: str
) -> dict[str, Any]:
    """Store `label` as the image's next round and move the image to `status`."""
    if image.get("role", "unlabelled") != "unlabelled":
        raise PermissionError(f"{image['id']} is a gold image and is read-only")
    round_no = int(label["round"])
    key = f"projects/{project_id}/labels/{image['id']}/r{round_no}.json"
    if blobs.exists(key):
        raise FileExistsError(f"round {round_no} of {image['id']} already exists")
    blobs.write_bytes(key, json.dumps(label).encode("utf-8"), "application/json")
    update = {
        "round": round_no,
        "label_uri": blobs.uri(key),
        "label_key": key,
        "object_count": len(label["objects"]),
        "missing_outlines": missing_outlines(label),
    }
    store.update(f"projects/{project_id}/images/{image['id']}", update)
    image.update(update)
    set_status(store, project_id, image, status)
    return image


def next_round(label: dict[str, Any], objects: list[dict[str, Any]]) -> dict[str, Any]:
    """A copy of `label` one round on, holding `objects` renumbered o1, o2, ..."""
    round_no = int(label["round"]) + 1
    renumbered = []
    for n, obj in enumerate(objects, start=1):
        renumbered.append({**obj, "id": f"o{n}"})
    return {**label, "round": round_no, "objects": renumbered}
