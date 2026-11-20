"""Agent 11 - trainer, with agent 12's scoring at the end (plan.md A1.4-A1.6).

The model is CircularNet (RF-DETR segmentation), fine-tuned with the `rfdetr` library - the
one Google's own CircularNet fine-tuning notebook uses.

    export a dataset version -> train from the active weights -> export ONNX
    -> score on the frozen gold hold-out -> promote only if not worse

Training runs on CPU: this project has no usable GPU quota (CLAUDE.md records the refusals).
The deep-learning framework is imported only inside `run_training`, so the rest of the app,
and every test, runs without it.
"""
from __future__ import annotations

import shutil
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import annotator, dataset_compiler, evaluator, notifier, orchestrator

if TYPE_CHECKING:
    from app.worker import JobContext


def run_training(
    dataset_dir: Path, start_weights: Path, out_dir: Path, epochs: int, imgsz: int, batch: int,
    max_minutes: float, on_epoch: Callable[[int, int], None], variant: str = "RFDETRSegMedium",
    grad_accum: int = 4,
) -> dict[str, Any]:  # fmt: skip
    """Fine-tune CircularNet on CPU and export ONNX. Returns paths and what was run.

    `start_weights` is a PyTorch checkpoint: the one rebuilt from Google's published ONNX for a
    first run, the previous version's own checkpoint after that. The class head is sized from
    the dataset's categories, so on a first run it has not been trained for these classes
    (the library resizes the head it was given; nothing in it knows the project's classes).

    Settings that are fixed here and why: one image size (the model's 432 input - no
    multi-scale, which costs CPU time), no test pass (the exam is the gold hold-out, scored
    afterwards with the app's own scoring code), no experiment trackers.
    """
    import rfdetr  # noqa: PLC0415 - only in the trainer image

    started = time.time()
    out_dir.mkdir(parents=True, exist_ok=True)
    model = getattr(rfdetr, variant)(pretrain_weights=str(start_weights), resolution=imgsz)
    done = {"epochs": 0}

    def after_epoch(_log: dict[str, Any]) -> None:
        done["epochs"] += 1
        on_epoch(min(done["epochs"], epochs), epochs)
        if (time.time() - started) / 60 > max_minutes:
            model.model.request_early_stop()  # hard cap from agents.yaml limits

    model.callbacks["on_fit_epoch_end"].append(after_epoch)
    model.train(
        dataset_dir=str(dataset_dir), output_dir=str(out_dir), epochs=epochs, batch_size=batch,
        grad_accum_steps=grad_accum, device="cpu", num_workers=0, run_test=False,
        multi_scale=False, expanded_scales=False, tensorboard=False, wandb=False,
        early_stopping=False, checkpoint_interval=max(1, epochs),
    )  # fmt: skip
    best = out_dir / "checkpoint_best_total.pth"
    if not best.is_file():
        raise RuntimeError("training finished without writing a best checkpoint")
    # Export from a fresh copy of the best checkpoint, so the ONNX is that checkpoint and
    # nothing left over from the last epoch.
    export_dir = out_dir / "export"
    getattr(rfdetr, variant)(pretrain_weights=str(best), resolution=imgsz).export(
        output_dir=str(export_dir), simplify=False, opset_version=17
    )
    onnx = export_dir / "inference_model.onnx"
    if not onnx.is_file():
        raise RuntimeError("the ONNX export did not produce inference_model.onnx")
    return {
        "best_pt": best,
        "best_onnx": onnx,
        "log": out_dir / "log.txt",
        "epochs_run": done["epochs"],
        # The library's own figures on the dataset's validation split, whose labels are
        # machine-made. Kept for the record; NOT the accuracy shown to the user.
        "val_split_metrics": _last_log_metrics(out_dir / "log.txt"),
    }


def _last_log_metrics(log: Path) -> dict[str, float]:
    """The numeric fields of the last line of the training log (one JSON object per epoch)."""
    import json  # noqa: PLC0415

    try:
        last = [line for line in log.read_text(encoding="utf-8").splitlines() if line.strip()][-1]
        return {k: float(v) for k, v in json.loads(last).items() if isinstance(v, (int, float))}
    except (OSError, IndexError, ValueError):
        return {}


def _stage(ctx: JobContext, stage: str) -> None:
    ctx.store.update(ctx.job_path, {"result": {"stage": stage}})


def _download_dataset(ctx: JobContext, prefix: str, dest: Path) -> Path:
    """Copy one dataset version to a local folder; the COCO layout needs no rewriting."""
    prefix = prefix.rstrip("/")
    for key in ctx.blobs.list_keys(prefix + "/"):
        target = dest / key[len(prefix) + 1:]
        target.parent.mkdir(parents=True, exist_ok=True)
        ctx.blobs.download_to(key, target)
    return dest


def train_job(ctx: JobContext) -> dict[str, Any]:
    from app.settings import load_models  # noqa: PLC0415
    from app.store import now_iso  # noqa: PLC0415

    store, blobs, pid = ctx.store, ctx.blobs, ctx.project_id
    params = ctx.job["params"]
    cfg = ctx.config["agents"]["trainer"]
    max_minutes = float(ctx.config["limits"]["gpu_job_max_minutes"])
    epochs = int(params.get("epochs") or cfg["epochs"])
    project = store.get(f"projects/{pid}")
    recipe = project["recipe"]
    record = annotator.model_spec(load_models(), recipe)
    imgsz = int(record["seed"]["input_size"])

    datasets = store.list(f"projects/{pid}/dataset_versions")
    compile_first = params.get("compile_first", True) and "dataset_version" not in params
    if ctx.job["dry_run"]:
        pool = dataset_compiler.trainable_images(store, pid)
        splits = dataset_compiler.assign_splits(pool, dataset_compiler.ratios(ctx.config))
        n_exemplars = int(project["counts"].get("gold_exemplar", 0))
        return {
            "estimate": {
                "train_images": sum(1 for s in splits.values() if s == "train") + n_exemplars,
                "val_images": sum(1 for s in splits.values() if s == "val"),
                "epochs": epochs,
                "gemini_calls": 0,
                "gpu_minutes": 0,
                "compute": cfg["compute_note"],
                "max_minutes": max_minutes,
            }
        }
    if not project.get("holdout"):
        raise ValueError("the hold-out check has not run, so a new model could not be scored honestly")

    if compile_first:
        _stage(ctx, "compiling")
        dataset_version = int(dataset_compiler.compile_job(ctx)["version"])
    else:
        dataset_version = int(params.get("dataset_version") or max((int(d["version"]) for d in datasets), default=0))
    dataset = store.get(f"projects/{pid}/dataset_versions/{dataset_version:04d}")
    if dataset is None:
        raise ValueError(f"dataset version {dataset_version} does not exist")

    versions = store.list(f"projects/{pid}/model_versions")
    version = 1 + max((int(v["version"]) for v in versions), default=0)
    active = int(project.get("active_model_version") or 0)
    start_key = f"projects/{pid}/weights/v{active}/best.pt" if active else record["seed"]["pt_key"]
    weights_prefix = f"projects/{pid}/weights/v{version}"
    version_path = f"projects/{pid}/model_versions/{version:04d}"
    doc: dict[str, Any] = {
        "version": version,
        "recipe": recipe,
        "parent": f"v{active}" if active else "seed",
        "dataset_version": dataset_version,
        "weights_uri": blobs.uri(weights_prefix),
        "weights": {"pt": False, "onnx": False},
        "status": "training",
        "trigger": ctx.job["trigger"],
        "metrics": None,
        "promoted": False,
        "promotion_note": None,
        "train_minutes": None,
        "epochs_run": None,
        "created_at": now_iso(),
    }
    store.set(version_path, doc)
    orchestrator.advance(store, ctx.config, pid, "training")

    started = time.time()
    try:
        with tempfile.TemporaryDirectory(prefix="retrainix-train-") as tmp:
            work = Path(tmp)
            dataset_dir = _download_dataset(ctx, dataset["gcs_prefix"], work / "dataset")
            start_weights = work / "start.pt"
            blobs.download_to(start_key, start_weights)

            _stage(ctx, "training")
            ctx.progress(0, epochs)
            trained = run_training(
                dataset_dir, start_weights, work / "runs", epochs, imgsz, int(cfg["batch"]), max_minutes, ctx.progress,
                variant=record["seed"]["variant"], grad_accum=int(cfg["grad_accum_steps"]),
            )
            train_minutes = round((time.time() - started) / 60, 2)

            _stage(ctx, "exporting")
            blobs.write_bytes(f"{weights_prefix}/best.pt", Path(trained["best_pt"]).read_bytes(), "application/octet-stream")
            blobs.write_bytes(f"{weights_prefix}/best.onnx", Path(trained["best_onnx"]).read_bytes(), "application/octet-stream")
            if Path(trained["log"]).is_file():
                blobs.write_bytes(f"{weights_prefix}/log.txt", Path(trained["log"]).read_bytes(), "text/plain")

            # The exam: the same frozen gold hold-out, the same scoring code, as every other version.
            _stage(ctx, "evaluating")
            store.update(version_path, {"status": "evaluating", "weights": {"pt": True, "onnx": True}})
            local_onnx = work / "best.onnx"
            shutil.copy(trained["best_onnx"], local_onnx)
            model = annotator.open_trained(local_onnx, record, project["classes"])
            label_model = {"recipe": recipe, "version": version, "profile": "default"}
            profile = ctx.config["agents"]["annotator_model"]["profiles"]["default"]
            identity = {c: c for c in project["classes"]}
            metrics = evaluator.evaluate_on_holdout(ctx, model, label_model, profile, class_map=identity)
            ctx.progress(trained["epochs_run"], epochs)  # scoring reused the bar; put the epochs back
    except Exception:
        store.update(version_path, {"status": "failed"})
        raise

    previous = next((v for v in versions if int(v["version"]) == active), None)
    old, new = (previous or {}).get("metrics", {}).get("map50") if previous else None, metrics.get("map50")
    counts = f"n = {metrics['n_images']} images, {metrics['n_objects_gold']} objects"
    if new is None:
        promoted, note = False, f"The new version could not be scored on the gold hold-out ({counts}), so it was not promoted."
    elif old is None:
        promoted, note = True, f"mAP50 on the gold hold-out is {new:.2f} ({counts}); there was no earlier score to compare with."
    elif new >= old:
        promoted, note = True, f"mAP50 on the gold hold-out went from {old:.2f} to {new:.2f} ({counts})."
    else:
        promoted = False
        note = f"mAP50 on the gold hold-out fell from {old:.2f} to {new:.2f} ({counts}), so version {active} stays active."

    result = {
        "version": version,
        "dataset_version": dataset_version,
        "parent": doc["parent"],
        "epochs_run": trained["epochs_run"],
        "train_minutes": train_minutes,
        "metrics": metrics,
        "previous": {"version": active, "map50": old},
        "promoted": promoted,
        "promotion_note": note,
        "val_split_metrics": trained["val_split_metrics"],
    }
    store.update(
        version_path,
        {
            "status": "ready", "metrics": metrics, "promoted": promoted, "promotion_note": note,
            "train_minutes": train_minutes, "epochs_run": trained["epochs_run"],
            "val_split_metrics": trained["val_split_metrics"],
        },  # fmt: skip
    )
    update = {"last_retrain_at": now_iso(), "updated_at": now_iso()}
    if promoted:
        update["active_model_version"] = version
    store.update(f"projects/{pid}", update)
    orchestrator.advance(store, ctx.config, pid, "evaluated")
    notifier.emit(store, pid, "training_done", f"Model version {version} is ready. {note}", job_id=ctx.job["id"])
    return result
