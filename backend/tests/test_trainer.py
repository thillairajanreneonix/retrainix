"""Training, model versions, promotion and the retrain schedule.

docs/api.md "Dataset, training, model versions and the schedule"; plan.md A1.4-A1.6.
The training framework is replaced by a stand-in that writes weight files, and the trained
model by one whose predictions the test chooses - so promotion is tested on exact scores.
"""
import json

import pytest

from agents import annotator, teacher_qa, trainer
from agents.annotator import Detection
from app import deps
from app.settings import load_agents_config, load_models
from tests.test_review_and_qa import METAL, OBJECTS, FakeModel, ScriptedGemini, all_ok, review, upload_video


class TrainedModel:
    """What a trained version predicts. It speaks the project's own class names."""

    def __init__(self, classes_found):
        self.classes_found = classes_found

    def predict(self, frame, profile):
        boxes = {"glass": (10, 10, 110, 110), "plastic": (150, 100, 250, 200), "metal": (200, 20, 260, 80)}
        return [Detection(c, 0.9, boxes[c], None) for c in self.classes_found]


@pytest.fixture
def trainable(client, project, belt_video, monkeypatch):
    """7 frames. Gold = 2 exemplars + 1 hold-out; the hold-out frame has glass, plastic AND a
    metal box a person drew, which the seed model does not find - so version 0 scores 2 of 3
    classes. The other 4 frames pass the Gemini check."""
    rules = load_agents_config()["agents"]["data_intake"]["gold_set"]
    schedule = load_agents_config()["agents"]["orchestrator"]["schedule"]
    saved, saved_schedule = dict(rules), dict(schedule)
    rules.update(required_images=3, exemplar_count=2, holdout_count=1, min_examples_per_class=1)
    schedule.update(min_new_approved_images=1)
    monkeypatch.setattr(annotator, "load_model", lambda ctx, record, cache_dir: FakeModel())
    monkeypatch.setattr(teacher_qa, "make_reviewer", lambda ctx: (ScriptedGemini([all_ok]), "scripted-gemini"))

    state = {"predicts": ["glass", "plastic", "metal"], "epochs_seen": [], "write_log": True}

    def fake_training(dataset_dir, start_weights, out_dir, epochs, imgsz, batch, max_minutes, on_epoch,
                      variant="RFDETRSegMedium", grad_accum=4):  # fmt: skip
        assert dataset_dir.is_dir() and start_weights.is_file()  # dataset and start weights were fetched
        # The COCO layout the training library reads, as it was exported - nothing rewritten.
        for folder in ("train", "valid"):
            coco = json.loads((dataset_dir / folder / "_annotations.coco.json").read_text(encoding="utf-8"))
            assert coco["images"] and all((dataset_dir / folder / i["file_name"]).is_file() for i in coco["images"])
            assert [c["name"] for c in coco["categories"]] == ["glass", "plastic", "metal"]
        state["start_weights_bytes"] = start_weights.read_bytes()
        state["settings"] = {"imgsz": imgsz, "batch": batch, "variant": variant, "grad_accum": grad_accum,
                             "max_minutes": max_minutes}  # fmt: skip
        out_dir.mkdir(parents=True, exist_ok=True)
        for name in ("best.pt", "best.onnx") + (("log.txt",) if state["write_log"] else ()):
            (out_dir / name).write_bytes(f"{name} of a stand-in run".encode())
        for epoch in range(1, epochs + 1):
            on_epoch(epoch, epochs)
            state["epochs_seen"].append(epoch)
        return {"best_pt": out_dir / "best.pt", "best_onnx": out_dir / "best.onnx", "log": out_dir / "log.txt",
                "epochs_run": epochs, "val_split_metrics": {"test_coco_eval_masks": 0.5}}  # fmt: skip

    monkeypatch.setattr(trainer, "run_training", fake_training)
    monkeypatch.setattr(annotator, "open_trained", lambda path, record, classes: TrainedModel(state["predicts"]))

    pid = project["id"]
    # The first run starts from the recipe's PyTorch seed checkpoint (models.yaml seed.pt_key).
    seed_key = annotator.model_spec(load_models(), "circularnet_rfdetr")["seed"]["pt_key"]
    deps.get_blobs().write_bytes(seed_key, b"seed weights", "application/octet-stream")
    upload_video(client, pid, belt_video)

    def job(job_type, **extra):
        return client.post(f"/api/projects/{pid}/jobs", json={"type": job_type, **extra})

    assert job("prelabel").json()["status"] == "succeeded"
    ids = [i["id"] for i in client.get(f"/api/projects/{pid}/images").json()["images"]]
    review(client, pid, ids[0], action="accept")
    review(client, pid, ids[1], action="accept")
    review(client, pid, ids[2], action="fix", objects=[*OBJECTS, METAL])  # last by time -> the hold-out
    assert client.post(f"/api/projects/{pid}/gold/freeze").status_code == 200
    yield pid, job, state
    rules.clear()
    rules.update(saved)
    schedule.clear()
    schedule.update(saved_schedule)


def test_training_waits_for_the_hold_out_check_and_for_checked_frames(client, trainable):
    pid, job, _ = trainable
    refused = job("train")
    assert refused.status_code == 409 and "hold-out check" in refused.json()["error"]["message"]
    assert job("holdout_check").json()["status"] == "succeeded"
    refused = job("train")
    assert refused.status_code == 409 and "passed the check" in refused.json()["error"]["message"]


def test_dry_run_says_what_a_run_would_use(client, trainable):
    pid, job, state = trainable
    job("holdout_check")
    job("qa")
    estimate = job("train", dry_run=True).json()["result"]["estimate"]
    assert estimate == {
        "train_images": 5, "val_images": 1, "epochs": 3, "gemini_calls": 0, "gpu_minutes": 0,
        "compute": "Cloud Run job, 8 vCPU, CPU only", "max_minutes": 120.0,
    }  # fmt: skip
    assert state["epochs_seen"] == []  # nothing was trained
    assert client.get(f"/api/projects/{pid}/model-versions").json()["model_versions"][0]["version"] == 0


def test_a_better_model_is_scored_on_the_same_hold_out_and_promoted(client, trainable):
    pid, job, state = trainable
    baseline = job("holdout_check").json()["result"]
    assert baseline["map50"] == pytest.approx(2 / 3, abs=1e-3)  # the seed model misses the metal object
    job("qa")

    done = job("train", params={"epochs": 3}).json()
    assert done["status"] == "succeeded", done["error"]
    result = done["result"]
    assert (result["version"], result["dataset_version"], result["parent"], result["epochs_run"]) == (1, 1, "seed", 3)
    assert state["epochs_seen"] == [1, 2, 3] and done["progress"] == {"done": 3, "total": 3}
    assert state["start_weights_bytes"] == b"seed weights"  # the first run starts from the seed weights
    # CircularNet's own input size and variant from models.yaml; batch and accumulation from agents.yaml.
    assert state["settings"] == {"imgsz": 432, "batch": 2, "variant": "RFDETRSegMedium", "grad_accum": 4, "max_minutes": 120.0}
    assert "outlines" not in result and "outlines_error" not in result  # nothing is outlined before training any more
    assert result["val_split_metrics"] == {"test_coco_eval_masks": 0.5}
    # Same exam as version 0: the same frozen hold-out frame, the same counts.
    assert (result["metrics"]["n_images"], result["metrics"]["n_objects_gold"]) == (baseline["n_images"], baseline["n_objects_gold"])
    assert result["metrics"]["map50"] == 1.0 and result["metrics"]["eval_set"] == "gold_holdout"
    assert result["previous"] == {"version": 0, "map50": baseline["map50"]}
    assert result["promoted"] is True
    assert result["promotion_note"] == "mAP50 on the gold hold-out went from 0.67 to 1.00 (n = 1 images, 3 objects)."

    project = client.get(f"/api/projects/{pid}").json()
    assert project["active_model_version"] == 1 and project["state"] == "evaluated" and project["last_retrain_at"]
    versions = client.get(f"/api/projects/{pid}/model-versions").json()["model_versions"]
    assert [(v["version"], v["trigger"], v["status"]) for v in versions] == [(0, "seed", "ready"), (1, "user", "ready")]
    assert versions[1]["weights"] == {"pt": True, "onnx": True} and versions[1]["promoted"] is True
    assert client.get(f"/api/projects/{pid}/events").json()["events"][0]["type"] == "training_done"

    blobs = deps.get_blobs()
    assert blobs.read_bytes(f"projects/{pid}/weights/v1/best.onnx") == b"best.onnx of a stand-in run"
    assert blobs.read_bytes(f"projects/{pid}/weights/v1/best.pt") == b"best.pt of a stand-in run"
    assert blobs.read_bytes(f"projects/{pid}/weights/v1/log.txt") == b"log.txt of a stand-in run"
    link = client.get(f"/api/projects/{pid}/model-versions/1/weights", params={"format": "onnx"}).json()
    assert link["filename"] == "retrainix-mixed-belt-v1.onnx"
    assert client.get(link["url"]).content == b"best.onnx of a stand-in run"
    assert client.get(f"/api/projects/{pid}/model-versions/0/weights").status_code == 404  # the seed has no download
    assert client.get(f"/api/projects/{pid}/model-versions/9/weights").status_code == 404


def test_a_worse_model_is_kept_but_not_promoted(client, trainable):
    pid, job, state = trainable
    job("holdout_check")
    job("qa")
    state["predicts"] = ["glass"]  # the new version finds less than the seed model did
    result = job("train", params={"epochs": 1}).json()["result"]
    assert result["metrics"]["map50"] == pytest.approx(1 / 3, abs=1e-3)
    assert result["promoted"] is False
    assert result["promotion_note"] == (
        "mAP50 on the gold hold-out fell from 0.67 to 0.33 (n = 1 images, 3 objects), so version 0 stays active."
    )
    project = client.get(f"/api/projects/{pid}").json()
    assert project["active_model_version"] is None  # still the seed weights
    version = client.get(f"/api/projects/{pid}/model-versions").json()["model_versions"][1]
    assert version["promoted"] is False and version["weights"]["onnx"] is True  # kept and downloadable


def test_the_next_run_starts_from_the_promoted_version_and_labels_with_it(client, trainable):
    pid, job, state = trainable
    job("holdout_check")
    job("qa")
    assert job("train", params={"epochs": 1}).json()["result"]["promoted"] is True
    second = job("train", params={"epochs": 1}).json()["result"]
    assert (second["version"], second["parent"], second["dataset_version"]) == (2, "v1", 2)
    assert state["start_weights_bytes"] == b"best.pt of a stand-in run"  # version 1's weights, not the seed
    assert second["previous"] == {"version": 1, "map50": 1.0} and second["promoted"] is True  # equal is not worse


def test_a_run_goes_from_export_to_scoring_with_no_outlining_stage(client, trainable, monkeypatch):
    pid, job, _ = trainable
    job("holdout_check")
    job("qa")
    stages, record_stage = [], trainer._stage

    def remember(ctx, stage):
        stages.append(stage)
        record_stage(ctx, stage)

    monkeypatch.setattr(trainer, "_stage", remember)
    done = job("train", params={"epochs": 1}).json()
    assert done["status"] == "succeeded", done["error"]
    assert stages == ["compiling", "training", "exporting", "evaluating"]


def test_a_run_that_leaves_no_log_still_stores_its_weights(client, trainable):
    pid, job, state = trainable
    job("holdout_check")
    job("qa")
    state["write_log"] = False
    done = job("train", params={"epochs": 1}).json()
    assert done["status"] == "succeeded", done["error"]
    blobs = deps.get_blobs()
    assert blobs.list_keys(f"projects/{pid}/weights/v1/") == [
        f"projects/{pid}/weights/v1/best.onnx", f"projects/{pid}/weights/v1/best.pt",
    ]  # fmt: skip


def test_a_failed_run_is_recorded_and_changes_nothing(client, trainable, monkeypatch):
    pid, job, _ = trainable
    job("holdout_check")
    job("qa")

    def broken(*args, **kwargs):
        raise RuntimeError("out of memory")

    monkeypatch.setattr(trainer, "run_training", broken)
    failed = job("train").json()
    assert failed["status"] == "failed" and "out of memory" in failed["error"]
    project = client.get(f"/api/projects/{pid}").json()
    assert project["active_model_version"] is None
    statuses = [v["status"] for v in client.get(f"/api/projects/{pid}/model-versions").json()["model_versions"]]
    assert statuses == ["ready", "failed"]  # one failed version: a training run is never retried on its own
    assert len(client.get(f"/api/projects/{pid}/dataset-versions").json()["dataset_versions"]) == 1
    assert client.get(f"/api/projects/{pid}/events").json()["events"][0]["type"] == "pipeline_failed"


# --- the schedule -------------------------------------------------------------------
def backdate(pid, field, hours):
    from datetime import UTC, datetime, timedelta

    then = (datetime.now(UTC) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    deps.get_store().update(f"projects/{pid}", {field: then})


def test_tick_ignores_projects_without_a_schedule(client, trainable):
    assert client.post("/internal/tick").json() == {"checked": 0, "started": [], "skipped": []}


def test_tick_waits_for_the_interval_then_trains_once(client, trainable):
    pid, job, state = trainable
    job("holdout_check")
    job("qa")
    client.put(f"/api/projects/{pid}/schedule", json={"retrain_interval_hours": 6})

    early = client.post("/internal/tick").json()
    assert early["started"] == [] and "has not passed yet" in early["skipped"][0]["reason"]
    assert client.get(f"/api/projects/{pid}").json()["last_tick"]["decision"] == "skipped"

    backdate(pid, "schedule_set_at", hours=7)
    due = client.post("/internal/tick").json()
    assert [s["project_id"] for s in due["started"]] == [pid] and due["skipped"] == []
    trained = client.get(f"/api/projects/{pid}/jobs/{due['started'][0]['job_id']}").json()
    assert trained["status"] == "succeeded" and trained["trigger"] == "schedule"
    assert client.get(f"/api/projects/{pid}/model-versions").json()["model_versions"][1]["trigger"] == "schedule"

    again = client.post("/internal/tick").json()  # straight afterwards: the interval starts over
    assert again["started"] == [] and "has not passed yet" in again["skipped"][0]["reason"]


def test_tick_skips_when_no_new_frames_were_checked_since_the_last_dataset(client, trainable):
    pid, job, _ = trainable
    job("holdout_check")
    job("qa")
    assert job("train", params={"epochs": 1}).json()["status"] == "succeeded"  # uses every checked frame
    client.put(f"/api/projects/{pid}/schedule", json={"retrain_interval_hours": 1})
    backdate(pid, "last_retrain_at", hours=2)
    skipped = client.post("/internal/tick").json()
    assert skipped["started"] == []
    assert skipped["skipped"][0]["reason"] == "only 0 new checked frames since the last dataset version; 1 are needed"
    assert len(client.get(f"/api/projects/{pid}/model-versions").json()["model_versions"]) == 2  # no third version


def test_tick_does_nothing_before_the_hold_out_check(client, trainable):
    pid, _, _ = trainable
    client.put(f"/api/projects/{pid}/schedule", json={"retrain_interval_hours": 1})
    backdate(pid, "schedule_set_at", hours=2)
    out = client.post("/internal/tick").json()
    assert out["started"] == [] and "hold-out check has not run" in out["skipped"][0]["reason"]
