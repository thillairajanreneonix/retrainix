"""The worker: runs one job, identified only by project_id and job_id.

    python -m app.worker <project_id> <job_id>

The same code runs as a Cloud Run job execution, and as a thread in the API process on a
laptop. Everything else it needs comes from the job document and config/agents.yaml.
"""
from __future__ import annotations

import logging
import sys
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agents import (
    annotator,
    data_intake,
    dataset_compiler,
    evaluator,
    notifier,
    outliner,
    teacher_qa,
    trainer,
)

from .blobs import Blobs
from .deps import get_blobs, get_store
from .settings import load_agents_config
from .store import Store, now_iso

logger = logging.getLogger(__name__)


@dataclass
class JobContext:
    store: Store
    blobs: Blobs
    config: dict[str, Any]
    project_id: str
    job: dict[str, Any]

    @property
    def job_path(self) -> str:
        return f"projects/{self.project_id}/jobs/{self.job['id']}"

    def progress(self, done: int, total: int) -> None:
        self.store.update(self.job_path, {"progress": {"done": done, "total": total}})


HANDLERS: dict[str, Callable[[JobContext], dict[str, Any]]] = {
    "extract_frames": data_intake.extract_frames_job,
    "prelabel": annotator.prelabel_job,
    "holdout_check": evaluator.holdout_check_job,
    "qa": teacher_qa.qa_job,
    "compile": dataset_compiler.compile_job,
    "train": trainer.train_job,
    "outline": outliner.outline_job,
}

# agents.yaml orchestrator rule: on agent error retry once, then fail. Only for jobs that are
# cheap and safe to repeat. A second go at training, export or the Gemini check costs money and
# leaves duplicates behind: the first cloud training failure (20 Nov) produced two failed model
# versions and two identical dataset versions because it was retried.
RETRY_ONCE = {"extract_frames", "prelabel", "holdout_check"}


def auto_prelabel_enabled(config: dict[str, Any]) -> bool:
    """agents.yaml annotator_model.auto_after_upload. A function so tests can switch it."""
    return bool(config["agents"]["annotator_model"].get("auto_after_upload"))


def label_new_frames(ctx: JobContext, result: dict[str, Any]) -> None:
    """Every upload goes to the model: when frames have been cut from a video, start
    pre-labelling them without waiting for a button. Skipped when a pre-label job is already
    queued or running (the button on the QA screen labels whatever is left). A failure here
    must not fail the upload, so it is only logged."""
    try:
        if not auto_prelabel_enabled(ctx.config) or not result.get("frames_kept"):
            return
        from . import jobs  # noqa: PLC0415 - jobs imports this module

        if jobs.active(ctx.store, ctx.project_id, "prelabel"):
            return
        job = jobs.create_job(ctx.store, ctx.project_id, "prelabel", {}, trigger="auto")
        jobs.dispatch(ctx.store, ctx.project_id, job["id"])
    except Exception:
        logger.exception("could not start pre-labelling after the upload in %s", ctx.project_id)


def run_job(project_id: str, job_id: str) -> dict[str, Any]:
    store, blobs = get_store(), get_blobs()
    path = f"projects/{project_id}/jobs/{job_id}"
    job = store.get(path)
    if job is None:
        raise LookupError(f"job {job_id} does not exist in project {project_id}")
    if job["status"] != "queued":
        logger.warning("job %s is %s, not queued - leaving it alone", job_id, job["status"])
        return job

    handler = HANDLERS.get(job["type"])
    store.update(path, {"status": "running", "started_at": now_iso()})
    ctx = JobContext(store, blobs, load_agents_config(), project_id, job)

    error: str | None = None
    for attempt in range(1, (2 if job["type"] in RETRY_ONCE else 1) + 1):
        try:
            if handler is None:
                raise NotImplementedError(f"job type {job['type']} is not built yet")
            result = handler(ctx)
            store.update(
                path, {"status": "succeeded", "result": result, "finished_at": now_iso()}
            )
            if job["type"] == "extract_frames":
                label_new_frames(ctx, result)
            return store.get(path)
        except NotImplementedError as exc:
            error = str(exc)
            break
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            logger.error("job %s attempt %d failed\n%s", job_id, attempt, traceback.format_exc())

    store.update(path, {"status": "failed", "error": error, "finished_at": now_iso()})
    notifier.emit(
        store, project_id, "pipeline_failed", f"{job['type']} failed: {error}", job_id=job_id
    )
    return store.get(path)


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if len(argv) != 2:
        print("usage: python -m app.worker <project_id> <job_id>", file=sys.stderr)
        return 2
    job = run_job(argv[0], argv[1])
    logger.info("job %s finished: %s %s", job["id"], job["status"], job.get("error") or "")
    return 0 if job["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
