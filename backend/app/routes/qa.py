"""Human review, the gold set and the QA summary (docs/api.md, "Review, gold set ...")."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel

from agents import labels, outliner, review_router

from ..deps import get_blobs, get_store
from ..errors import APIError, not_found
from ..settings import load_agents_config
from ..store import now_iso
from .projects import get_project_or_404

router = APIRouter(prefix="/api", tags=["qa"])


class ReviewObject(BaseModel):
    id: str | None = None
    # "class" is a Python keyword, so the field is read under an alias.
    class_: str
    bbox_xyxy: list[float]

    model_config = {"populate_by_name": True}

    def __init__(self, **data: Any) -> None:
        if "class" in data:
            data["class_"] = data.pop("class")
        super().__init__(**data)


class ReviewBody(BaseModel):
    action: Literal["accept", "fix", "reject"]
    objects: list[ReviewObject] | None = None


def _api_error(exc: review_router.ReviewError) -> APIError:
    code = {403: "forbidden", 409: "conflict", 422: "invalid_request"}.get(exc.status, "error")
    return APIError(exc.status, code, exc.message)


@router.post("/projects/{project_id}/images/{image_id}/review")
def review_image(project_id: str, image_id: str, body: ReviewBody) -> dict[str, Any]:
    project = get_project_or_404(project_id)
    store, blobs = get_store(), get_blobs()
    image = store.get(f"projects/{project_id}/images/{image_id}")
    if image is None:
        raise not_found("The image")
    objects = None
    if body.objects is not None:
        objects = [{"id": o.id, "class": o.class_, "bbox_xyxy": o.bbox_xyxy} for o in body.objects]
    try:
        review_router.apply_review(store, blobs, project, image, body.action, objects, now_iso())
    except review_router.ReviewError as exc:
        raise _api_error(exc) from exc
    image = store.get(f"projects/{project_id}/images/{image_id}")
    return {"image": image, "label": labels.read_label(blobs, image)}


@router.get("/projects/{project_id}/gold")
def get_gold(project_id: str) -> dict[str, Any]:
    project = get_project_or_404(project_id)
    return review_router.gold_status(get_store(), get_blobs(), load_agents_config(), project)


@router.post("/projects/{project_id}/gold/freeze")
def freeze_gold(project_id: str) -> dict[str, Any]:
    project = get_project_or_404(project_id)
    try:
        return review_router.freeze_gold(
            get_store(), get_blobs(), load_agents_config(), project, now_iso()
        )
    except review_router.ReviewError as exc:
        raise _api_error(exc) from exc


@router.get("/gemini/status")
def gemini_status() -> dict[str, Any]:
    """Whether Gemini can be used right now. The answer is remembered for two minutes."""
    from .. import gemini  # noqa: PLC0415

    return gemini.status()


@router.get("/projects/{project_id}/qa/summary")
def qa_summary(project_id: str) -> dict[str, Any]:
    project = get_project_or_404(project_id)
    store = get_store()
    counts = project["counts"]
    waiting = store.list(f"projects/{project_id}/images", where={"label_status": "predicted"})
    checked = sum(counts.get(k, 0) for k in ("passed", "human_review", "human_done", "rejected"))
    last_qa = None
    for job in store.list(f"projects/{project_id}/jobs", where={"type": "qa"}, descending=True):
        if job["status"] == "succeeded" and not job["dry_run"]:
            last_qa = job["result"]
            break
    cap = load_agents_config()["limits"]["gemini_max_calls_per_project"]
    no_outline = outliner.images_missing(store, project_id)
    return {
        "holdout": project.get("holdout"),
        "images": {
            "frames": counts.get("frames", 0),
            "predicted": counts.get("predicted", 0),
            "waiting_for_qa": len(waiting),
            "passed": counts.get("passed", 0),
            "human_review": counts.get("human_review", 0),
            "human_done": counts.get("human_done", 0),
            "rejected": counts.get("rejected", 0),
        },
        "pass_rate": round(counts.get("passed", 0) / checked, 4) if checked else None,
        "n_images": checked,
        "last_qa": last_qa,
        "gemini_calls": {"used": project.get("gemini_calls_used", 0), "cap": cap},
        "outlines": {
            "frames_missing": len(no_outline),
            "objects_missing": sum(int(i.get("missing_outlines") or 0) for i in no_outline),
        },
    }
