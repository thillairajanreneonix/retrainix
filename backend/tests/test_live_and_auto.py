"""Whatever comes in goes to the model: pre-labelling starts by itself after an upload
(agents.yaml annotator_model.auto_after_upload), and one picture can be labelled on request
without storing anything (POST /predict, docs/api.md "Labelling a live view")."""
import cv2
import numpy as np
import pytest

from agents import annotator
from agents.annotator import Detection
from app import worker
from app.routes import live
from tests.conftest import upload_video


class StandInModel:
    """Two objects the class map knows and one it does not, whatever the picture."""

    def __init__(self):
        self.seen = []

    def predict(self, frame, profile):
        self.seen.append(frame.shape[:2])
        return [
            Detection("Glass_Bottle", 0.9, (10, 10, 110, 110), [[10, 10], [110, 10], [110, 110]]),
            Detection("Plastics-PET_Bottle", 0.6, (150, 100, 250, 200), None),
            Detection("Battery", 0.8, (200, 20, 260, 80), None),
        ]


@pytest.fixture
def model(monkeypatch):
    stand_in = StandInModel()
    monkeypatch.setattr(annotator, "load_model", lambda ctx, record, cache_dir: stand_in)
    return stand_in


def jpeg(width=320, height=240):
    picture = np.random.default_rng(3).integers(0, 256, (height, width, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", picture)[1].tobytes()


# --- pre-labelling by itself after an upload ---------------------------------------------
def test_an_upload_is_labelled_without_anyone_pressing_a_button(client, project, belt_video, model, monkeypatch):
    monkeypatch.setattr(worker, "auto_prelabel_enabled", lambda config: True)
    pid = project["id"]
    upload_video(client, pid, belt_video)  # 7 frames kept (see conftest)

    jobs = client.get(f"/api/projects/{pid}/jobs").json()["jobs"]
    assert [j["type"] for j in jobs] == ["prelabel", "extract_frames"]  # newest first
    prelabel = jobs[0]
    assert prelabel["status"] == "succeeded", prelabel["error"]
    assert prelabel["trigger"] == "auto" and prelabel["result"]["images"] == 7
    assert prelabel["result"]["label_model"]["recipe"] == "circularnet_rfdetr"
    counts = client.get(f"/api/projects/{pid}").json()["counts"]
    assert counts["predicted"] == 7
    waiting = client.get(f"/api/projects/{pid}/images", params={"status": "predicted"}).json()["images"]
    assert len(waiting) == 7 and all(i["object_count"] == 2 for i in waiting)  # the unmapped class is dropped


def test_the_setting_in_agents_yaml_is_what_switches_it_on():
    from app.settings import load_agents_config

    config = load_agents_config()
    assert config["agents"]["annotator_model"]["auto_after_upload"] is True
    off = {"agents": {"annotator_model": {}}}
    assert worker.auto_prelabel_enabled.__module__ != "app.worker" or worker.auto_prelabel_enabled(off) is False


def test_an_upload_with_no_usable_frame_starts_no_labelling(client, project, tmp_path, model, monkeypatch):
    monkeypatch.setattr(worker, "auto_prelabel_enabled", lambda config: True)
    pid = project["id"]
    fake = tmp_path / "notes.mp4"
    fake.write_bytes(b"this is not a video" * 100)
    upload_video(client, pid, fake)
    assert [j["type"] for j in client.get(f"/api/projects/{pid}/jobs").json()["jobs"]] == ["extract_frames"]


def test_a_second_upload_does_not_start_labelling_while_one_is_running(client, project, belt_video, model, monkeypatch):
    monkeypatch.setattr(worker, "auto_prelabel_enabled", lambda config: True)
    from app import deps, jobs

    pid = project["id"]
    running = jobs.create_job(deps.get_store(), pid, "prelabel", {}, trigger="user")  # queued, never dispatched
    upload_video(client, pid, belt_video)
    listed = client.get(f"/api/projects/{pid}/jobs").json()["jobs"]
    assert [j["type"] for j in listed] == ["extract_frames", "prelabel"]  # no second pre-label job
    assert listed[1]["id"] == running["id"] and listed[1]["status"] == "queued"


def test_a_failure_to_start_labelling_does_not_fail_the_upload(client, project, belt_video, monkeypatch):
    monkeypatch.setattr(worker, "auto_prelabel_enabled", lambda config: True)
    from app import jobs

    def broken(*args, **kwargs):
        raise RuntimeError("the worker could not be reached")

    monkeypatch.setattr(jobs, "active", broken)  # the first thing the automatic step asks
    up = upload_video(client, project["id"], belt_video)
    job = client.get(f"/api/projects/{project['id']}/jobs/{up['job']['id']}").json()
    assert job["status"] == "succeeded" and job["result"]["frames_kept"] == 7


# --- one picture, labelled now, nothing stored -------------------------------------------
def test_a_picture_is_labelled_and_nothing_is_stored(client, project, model):
    pid = project["id"]
    before = client.get(f"/api/projects/{pid}").json()
    answer = client.post(f"/api/projects/{pid}/predict", content=jpeg(), headers={"Content-Type": "image/jpeg"})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert (body["width"], body["height"]) == (320, 240) and model.seen == [(240, 320)]
    assert body["label_model"] == {"recipe": "circularnet_rfdetr", "version": 0, "profile": "default"}
    assert [(o["class"], o["model_class"]) for o in body["objects"]] == [
        ("glass", "Glass_Bottle"), ("plastic", "Plastics-PET_Bottle"),
    ]  # fmt: skip
    assert body["objects"][0]["polygon_xy"] == [[10, 10], [110, 10], [110, 110]] and body["objects"][1]["polygon_xy"] is None
    assert body["objects"][0]["bbox_xyxy"] == [10, 10, 110, 110] and body["objects"][0]["score"] == 0.9
    assert body["unmapped_objects"] == 1 and body["seconds"] >= 0
    # No frame, no label, no job: the project is exactly as it was.
    after = client.get(f"/api/projects/{pid}").json()
    assert after["counts"] == before["counts"] and after["state"] == before["state"]
    assert client.get(f"/api/projects/{pid}/jobs").json()["jobs"] == []
    assert client.get(f"/api/projects/{pid}/images").json()["images"] == []


def test_the_model_is_opened_once_and_kept_for_the_next_picture(client, project, monkeypatch):
    opened = []

    def open_model(ctx, record, cache_dir):
        opened.append(record["id"])
        return StandInModel()

    monkeypatch.setattr(annotator, "load_model", open_model)
    for _ in range(3):
        assert client.post(f"/api/projects/{project['id']}/predict", content=jpeg()).status_code == 200
    assert opened == ["circularnet_rfdetr"]


def test_predict_refuses_what_is_not_a_picture_too_large_or_for_no_project(client, project, model):
    pid = project["id"]
    assert client.post(f"/api/projects/{pid}/predict", content=b"not a picture").status_code == 422
    assert client.post(f"/api/projects/{pid}/predict", content=b"").status_code == 422
    too_big = client.post(f"/api/projects/{pid}/predict", content=b"x" * (2 * 1024 * 1024 + 1))
    assert too_big.status_code == 413 and too_big.json()["error"]["code"] == "too_large"
    assert client.post("/api/projects/p_none/predict", content=jpeg()).status_code == 404
    assert model.seen == []  # the model was never asked


def test_predict_says_busy_while_another_picture_is_being_labelled(client, project, model):
    assert live._busy.acquire(blocking=False)
    try:
        busy = client.post(f"/api/projects/{project['id']}/predict", content=jpeg())
        assert busy.status_code == 429 and busy.json()["error"]["code"] == "busy"
    finally:
        live._busy.release()
    assert client.post(f"/api/projects/{project['id']}/predict", content=jpeg()).status_code == 200


def test_a_trained_version_is_opened_from_its_own_weights_and_the_old_file_is_removed(client, project, monkeypatch):
    from app import deps

    opened = []

    def open_model(ctx, record, cache_dir):
        (cache_dir / "weights.onnx").write_bytes(b"x")  # what a real download leaves behind
        opened.append((record["seed"]["onnx_key"], record["seed"]["first_class_index"], cache_dir))
        return StandInModel()

    monkeypatch.setattr(annotator, "load_model", open_model)
    pid = project["id"]
    first = client.post(f"/api/projects/{pid}/predict", content=jpeg()).json()
    deps.get_store().update(f"projects/{pid}", {"active_model_version": 2})  # as after a promotion
    second = client.post(f"/api/projects/{pid}/predict", content=jpeg()).json()

    assert [key for key, _, _ in opened] == [
        "seed/circularnet_rfdetr/cn_segmentation.onnx", f"projects/{pid}/weights/v2/best.onnx",
    ]  # fmt: skip
    assert [first_index for _, first_index, _ in opened] == [1, 0]  # Google's file, then one trained here
    assert opened[0][2] != opened[1][2] and not opened[0][2].exists() and opened[1][2].exists()
    assert first["label_model"]["version"] == 0 and second["label_model"]["version"] == 2
    # A trained version speaks the project's own class names, so the stand-in's product names map to nothing.
    assert len(first["objects"]) == 2 and second["objects"] == [] and second["unmapped_objects"] == 3


def test_the_class_map_is_read_from_the_project_on_every_picture(client, project, model, monkeypatch):
    pid = project["id"]
    assert [o["class"] for o in client.post(f"/api/projects/{pid}/predict", content=jpeg()).json()["objects"]] == ["glass", "plastic"]
    smaller = {k: v for k, v in project["class_map"].items() if k != "Glass_Bottle"}
    assert client.put(f"/api/projects/{pid}/class-map", json={"class_map": smaller}).status_code == 200
    again = client.post(f"/api/projects/{pid}/predict", content=jpeg()).json()
    assert [o["class"] for o in again["objects"]] == ["plastic"] and again["unmapped_objects"] == 2
    assert len(model.seen) == 2  # the same opened model answered both
