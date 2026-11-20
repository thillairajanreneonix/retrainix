"""Agent 1 - orchestrator. The project state machine (agents.yaml: orchestrator).

Every project has an explicit state, every transition is written with a timestamp, and a
project only ever moves forward - except into "failed", and back out of it.
"""
from __future__ import annotations

from typing import Any


def states(config: dict[str, Any]) -> list[str]:
    return list(config["agents"]["orchestrator"]["states"])


def advance(store: Any, config: dict[str, Any], project_id: str, new_state: str) -> bool:
    """Move the project to new_state if that is a step forward. Returns whether it moved."""
    from app.store import now_iso  # noqa: PLC0415 - keeps this module importable on its own

    order = states(config)
    if new_state not in order:
        raise ValueError(f"unknown project state: {new_state}")
    path = f"projects/{project_id}"
    project = store.get(path)
    if project is None:
        raise LookupError(f"project {project_id} does not exist")
    current = project.get("state", "created")
    forward = current == "failed" or order.index(new_state) > order.index(current)
    if new_state != "failed" and not forward:
        return False
    at = now_iso()
    store.update(path, {"state": new_state, "updated_at": at})
    stamp = at.replace(":", "").replace("-", "").replace(".", "")
    store.set(
        f"{path}/transitions/t_{stamp}_{new_state}",
        {"from": current, "to": new_state, "at": at},
    )
    return True
