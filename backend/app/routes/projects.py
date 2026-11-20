"""Projects, model catalogue, schedule (docs/api.md)."""
from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from agents import annotator, orchestrator

from ..deps import get_store
from ..errors import APIError, not_found
from ..settings import load_agents_config, load_models
from ..store import now_iso

router = APIRouter(prefix="/api", tags=["projects"])

EMPTY_COUNTS = {
    "gold_exemplar": 0, "gold_holdout": 0, "frames": 0, "predicted": 0,
    "passed": 0, "human_review": 0, "human_done": 0, "rejected": 0,
}  # fmt: skip


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    classes: list[str] = Field(min_length=1, max_length=50)
    recipe: str
    prelabel_recipe: str
    class_map: dict[str, str] = Field(default_factory=dict)


class ScheduleUpdate(BaseModel):
    retrain_interval_hours: float | None


class ClassMapUpdate(BaseModel):
    class_map: dict[str, str]


def _check_class_map(
    class_map: dict[str, str], model_classes: list[str], project_classes: list[str]
) -> None:
    bad_keys = sorted(set(class_map) - set(model_classes))
    if bad_keys:
        raise APIError(
            422, "invalid_request",
            f"class_map: {', '.join(bad_keys[:5])} is not a class of the pre-labelling model",
        )  # fmt: skip
    bad_values = sorted(set(class_map.values()) - set(project_classes))
    if bad_values:
        raise APIError(
            422, "invalid_request", f"class_map: {', '.join(bad_values)} is not a project class"
        )


def get_project_or_404(project_id: str) -> dict[str, Any]:
    project = get_store().get(f"projects/{project_id}")
    if project is None:
        raise not_found("The project")
    return project


@router.get("/models")
def list_models() -> dict[str, Any]:
    return {"models": load_models()}


@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate) -> dict[str, Any]:
    classes = [c.strip().lower() for c in body.classes if c.strip()]
    if not classes:
        raise APIError(422, "invalid_request", "classes: at least one class name is needed")
    if len(set(classes)) != len(classes):
        raise APIError(422, "invalid_request", "classes: every class name must be different")

    models = {m["id"]: m for m in load_models()}
    if not models.get(body.recipe, {}).get("can_train"):
        raise APIError(422, "invalid_request", f"recipe: {body.recipe} cannot be trained here")
    if not models.get(body.prelabel_recipe, {}).get("can_prelabel"):
        raise APIError(
            422, "invalid_request", f"prelabel_recipe: {body.prelabel_recipe} cannot pre-label"
        )
    prelabel_classes = models[body.prelabel_recipe]["classes"]
    _check_class_map(body.class_map, prelabel_classes, classes)
    # No map given: fill it by name, and say so, so the user knows to check it.
    class_map = body.class_map or annotator.suggest_class_map(prelabel_classes, classes)
    class_map_source = "user" if body.class_map else "name_match"

    store = get_store()
    project_id = f"p_{secrets.token_hex(3)}"
    at = now_iso()
    store.set(
        f"projects/{project_id}",
        {
            "name": body.name.strip(),
            "classes": classes,
            "recipe": body.recipe,
            "prelabel_recipe": body.prelabel_recipe,
            "class_map": class_map,
            "class_map_source": class_map_source,
            "state": "created",
            "retrain_interval_hours": None,
            "last_retrain_at": None,
            "active_model_version": None,
            "counts": dict(EMPTY_COUNTS),
            "gemini_calls_used": 0,
            "created_at": at,
            "updated_at": at,
        },
    )
    orchestrator.advance(store, load_agents_config(), project_id, "model_selected")
    return store.get(f"projects/{project_id}")


@router.get("/projects")
def list_projects() -> dict[str, Any]:
    projects = get_store().list("projects")
    projects.sort(key=lambda p: p.get("created_at", ""), reverse=True)
    return {"projects": projects}


@router.get("/projects/{project_id}")
def get_project(project_id: str) -> dict[str, Any]:
    return get_project_or_404(project_id)


@router.put("/projects/{project_id}/schedule")
def set_schedule(project_id: str, body: ScheduleUpdate) -> dict[str, Any]:
    get_project_or_404(project_id)
    hours = body.retrain_interval_hours
    minimum = load_agents_config()["agents"]["orchestrator"]["schedule"]["min_interval_hours"]
    if hours is not None and hours < minimum:
        raise APIError(
            422, "invalid_request",
            f"retrain_interval_hours: the shortest interval is {minimum} hour(s)",
        )  # fmt: skip
    store = get_store()
    # The first scheduled run is counted from the moment the schedule is set.
    store.update(
        f"projects/{project_id}",
        {"retrain_interval_hours": hours, "schedule_set_at": now_iso() if hours else None, "updated_at": now_iso()},
    )
    return store.get(f"projects/{project_id}")


@router.put("/projects/{project_id}/class-map")
def set_class_map(project_id: str, body: ClassMapUpdate) -> dict[str, Any]:
    project = get_project_or_404(project_id)
    if project["counts"].get("predicted", 0) > 0:
        raise APIError(409, "conflict", "Frames are already labelled with the current mapping")
    models = {m["id"]: m for m in load_models()}
    _check_class_map(
        body.class_map, models[project["prelabel_recipe"]]["classes"], project["classes"]
    )
    store = get_store()
    store.update(
        f"projects/{project_id}",
        {"class_map": body.class_map, "class_map_source": "user", "updated_at": now_iso()},
    )
    return store.get(f"projects/{project_id}")
