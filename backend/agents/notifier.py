"""Agent 13 - notifier. Events become in-app messages (agents.yaml: notifier)."""
from __future__ import annotations

import secrets
import time
from typing import Any

EVENT_TYPES = {"dataset_ready", "training_done", "needs_human_review", "pipeline_failed"}


def emit(
    store: Any, project_id: str, event_type: str, message: str, job_id: str | None = None
) -> str:
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown event type: {event_type}")
    from app.store import now_iso  # noqa: PLC0415 - keeps this module importable on its own

    event_id = f"e_{int(time.time() * 1000):013d}{secrets.token_hex(2)}"
    store.set(
        f"projects/{project_id}/events/{event_id}",
        {
            "type": event_type,
            "message": message,
            "job_id": job_id,
            "read": False,
            "created_at": now_iso(),
        },
    )
    return event_id
