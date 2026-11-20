"""Pre-labelling (plan.md A1.1; agents.yaml annotator_model; docs/api.md "Pre-labelling").

The decoder is tested on hand-built model outputs, and the job on a stand-in model, so
no weights are needed. The one model is CircularNet (RF-DETR segmentation); the Ultralytics
YOLO decoder and its tests were removed with that model on 20 Nov 2026.
"""
from types import SimpleNamespace

import numpy as np
import pytest

from agents import annotator
from agents.annotator import Detection
from app.settings import load_models
from tests.conftest import upload_video


# --- decoder ------------------------------------------------------------------------
def test_circularnet_decoder_skips_background_and_reads_normalised_boxes():
    boxes = np.zeros((1, 200, 4), dtype=np.float32)
    logits = np.full((1, 200, 51), -10.0, dtype=np.float32)
    masks = np.full((1, 200, 108, 108), -10.0, dtype=np.float32)
    boxes[0, 0] = [0.5, 0.5, 0.25, 0.5]  # centre, a quarter wide, half tall
    logits[0, 0, 10] = 4.0  # index 10 = the 10th named class; index 0 is background
    masks[0, 0, 27:81, 40:68] = 10.0
    logits[0, 1, 0] = 8.0  # a confident "background" must never become an object
    names = [f"class_{i}" for i in range(1, 51)]

    found = annotator.decode_rfdetr_seg([boxes, logits, masks], names, (800, 1280), 432, conf=0.35)
    assert len(found) == 1
    assert found[0].class_name == "class_10"
    assert found[0].box == pytest.approx((480.0, 200.0, 800.0, 600.0))
    assert found[0].polygon and len(found[0].polygon) >= 3


def _three_queries():
    """Three confident queries, far apart, each with its high logit at a different index.
    Four logits for three classes: one is spare, and where it sits depends on who trained
    the model."""
    boxes = np.zeros((1, 5, 4), dtype=np.float32)
    logits = np.full((1, 5, 4), -10.0, dtype=np.float32)
    boxes[0, 0] = [0.2, 0.2, 0.2, 0.2]
    boxes[0, 1] = [0.5, 0.5, 0.2, 0.2]
    boxes[0, 2] = [0.8, 0.8, 0.2, 0.2]
    logits[0, 0, 0] = 4.0
    logits[0, 1, 1] = 5.0
    logits[0, 2, 3] = 6.0
    return [boxes, logits]  # no mask output: the decoder still answers, with boxes only


def test_published_model_keeps_logit_zero_for_background_so_classes_start_at_one():
    names = ["glass", "plastic", "metal"]
    found = annotator.decode_rfdetr_seg(_three_queries(), names, (100, 100), 432, conf=0.35, first=1)
    # Logit 0 is background and never an object; logit 1 is the first class, logit 3 the third.
    assert [(d.class_name, d.box) for d in found] == [
        ("glass", pytest.approx((40.0, 40.0, 60.0, 60.0))),
        ("metal", pytest.approx((70.0, 70.0, 90.0, 90.0))),
    ]
    # Left unsaid, the decoder reads the published model's layout.
    default = annotator.decode_rfdetr_seg(_three_queries(), names, (100, 100), 432, conf=0.35)
    assert [d.class_name for d in default] == ["glass", "metal"]
    assert all(d.polygon is None for d in found)


def test_a_model_trained_here_has_its_first_class_at_logit_zero():
    names = ["glass", "plastic", "metal"]
    first = annotator.TRAINED_FIRST_CLASS_INDEX
    assert first == 0
    found = annotator.decode_rfdetr_seg(_three_queries(), names, (100, 100), 432, conf=0.35, first=first)
    # The same outputs, read one place to the left: logit 0 is now glass, logit 1 plastic,
    # and logit 3 is the spare one at the end - never an object.
    assert [(d.class_name, d.box) for d in found] == [
        ("glass", pytest.approx((10.0, 10.0, 30.0, 30.0))),
        ("plastic", pytest.approx((40.0, 40.0, 60.0, 60.0))),
    ]
    assert [round(d.score, 3) for d in found] == [0.982, 0.993]  # sigmoid of 4 and of 5


class RecordingOnnxModel:
    """Stands in for OnnxModel: opens nothing, remembers how it was asked to read the outputs."""

    def __init__(self, path, decoder, input_size, classes, first_class_index=1):
        self.path, self.decoder, self.size = path, decoder, input_size
        self.classes, self.first = list(classes), first_class_index


def test_seed_weights_are_read_from_logit_one_and_a_trained_version_from_logit_zero(tmp_path, monkeypatch):
    monkeypatch.setattr(annotator, "OnnxModel", RecordingOnnxModel)
    fetched = []

    def download_to(key, path):
        fetched.append(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"onnx")

    ctx = SimpleNamespace(project_id="p_abc123", blobs=SimpleNamespace(download_to=download_to))
    record = annotator.model_spec(load_models(), "circularnet_rfdetr")
    project = {"recipe": "circularnet_rfdetr", "prelabel_recipe": "circularnet_rfdetr",
               "classes": ["glass", "plastic"], "class_map": {"Glass_Bottle": "glass"},
               "active_model_version": None}  # fmt: skip

    seed, which, class_map = annotator.active_model(ctx, project, tmp_path / "seed")
    assert (seed.first, seed.decoder, seed.size) == (1, "rfdetr_seg", 432)
    assert seed.classes == record["classes"] and len(seed.classes) == 50
    assert which == {"recipe": "circularnet_rfdetr", "version": 0} and class_map == {"Glass_Bottle": "glass"}

    own, which, class_map = annotator.active_model(ctx, {**project, "active_model_version": 2}, tmp_path / "own")
    assert (own.first, own.decoder, own.size) == (0, "rfdetr_seg", 432)
    assert own.classes == ["glass", "plastic"]  # a trained version speaks the project's classes ...
    assert class_map == {"glass": "glass", "plastic": "plastic"}  # ... so its map is the identity
    assert which == {"recipe": "circularnet_rfdetr", "version": 2}
    assert fetched == [record["seed"]["onnx_key"], "projects/p_abc123/weights/v2/best.onnx"]

    scored = annotator.open_trained(tmp_path / "best.onnx", record, ["glass", "plastic"])
    assert scored.first == 0 and scored.classes == ["glass", "plastic"]  # the hold-out exam reads it the same way


def test_tiles_cover_the_whole_image_with_overlap():
    windows = annotator.tile_windows(1280, 800, cols=3, rows=2, overlap=0.2)
    assert len(windows) == 6
    covered = np.zeros((800, 1280), dtype=bool)
    for x0, y0, x1, y1 in windows:
        covered[y0:y1, x0:x1] = True
    assert covered.all()
    assert windows[0][2] > windows[1][0]  # neighbours overlap, so a seam never splits every view


def test_tiled_prediction_shifts_results_back_and_merges_duplicates():
    outline = [[10.0, 10.0], [30.0, 10.0], [30.0, 30.0]]

    class OneBoxPerTile:
        def predict_once(self, tile, conf):
            return [Detection("glass", 0.8, (10.0, 10.0, 30.0, 30.0), outline)]

    frame = np.zeros((800, 1280, 3), np.uint8)
    found = annotator.predict_tiled(OneBoxPerTile(), frame, 0.2, cols=3, rows=2, overlap=0.2, nms_iou=0.5)
    windows = annotator.tile_windows(1280, 800, cols=3, rows=2, overlap=0.2)
    assert len(found) == 6  # one per tile, far apart, so none is merged away
    # Each box sits 10 px inside its own tile, so it must be shifted by that tile's origin.
    assert sorted(d.box[:2] for d in found) == sorted((x0 + 10.0, y0 + 10.0) for x0, y0, _, _ in windows)
    assert all(d.polygon[0] == [d.box[0], d.box[1]] for d in found)  # outlines move with their boxes


def test_one_label_per_object_keeps_the_higher_score_across_classes():
    same_object = [
        Detection("plastic", 0.50, (0, 0, 100, 100), None),
        Detection("aluminium", 0.49, (2, 2, 100, 100), None),
        Detection("glass", 0.40, (300, 300, 350, 350), None),
    ]
    kept = annotator.one_label_per_object(same_object, iou_threshold=0.7)
    assert [d.class_name for d in kept] == ["plastic", "glass"]


def test_class_map_suggestion_matches_on_the_material_part_only():
    model_classes = ["Plastics-HDPE_Bottle", "Fiber_Cup-&-glass", "Glass_Bottle", "Metals_Lid",
                     "Aluminium_Can", "Battery"]  # fmt: skip
    suggested = annotator.suggest_class_map(model_classes, ["glass", "plastic", "metal", "aluminium"])
    assert suggested == {
        "Plastics-HDPE_Bottle": "plastic",
        "Glass_Bottle": "glass",
        "Metals_Lid": "metal",
        "Aluminium_Can": "aluminium",
    }  # a paper cup is not glass; a battery is nothing the project named


def test_master_label_maps_classes_counts_unmapped_and_drops_noise():
    image = {"id": "f1", "width": 1280, "height": 800}
    detections = [
        Detection("Glass_Bottle", 0.9, (0, 0, 100, 100), [[0, 0], [100, 0], [100, 100]]),
        Detection("Battery", 0.8, (200, 200, 300, 300), None),  # not in the map
        Detection("Glass_Bottle", 0.7, (500, 500, 505, 505), None),  # 25 px2: noise
    ]
    label, unmapped = annotator.to_master_label(
        image, detections, {"Glass_Bottle": "glass"}, {"recipe": "r", "version": 0, "profile": "default"},
        min_area_px=100,
    )  # fmt: skip
    assert unmapped == 1
    assert [o["class"] for o in label["objects"]] == ["glass"]
    obj = label["objects"][0]
    assert obj["source"] == "model" and obj["round"] == 0 and obj["id"] == "o1"
    assert obj["bbox_xyxy"] == [0, 0, 100, 100] and obj["mask_rle"] is None
    assert (label["width"], label["height"], label["image_id"]) == (1280, 800, "f1")


# --- the job, with a stand-in model ---------------------------------------------------
class FakeModel:
    """Two mapped objects and one unmapped object on every frame."""

    def predict(self, frame, profile):
        assert frame.shape[:2] == (240, 320)  # the worker hands over the original frame
        return [
            Detection("Glass_Bottle", 0.9, (10, 10, 110, 110), [[10, 10], [110, 10], [110, 110]]),
            Detection("Plastics-PET_Bottle", 0.6, (150, 100, 250, 200), None),
            Detection("Battery", 0.8, (200, 20, 260, 80), None),
        ]


@pytest.fixture
def labelled_project(client, project, belt_video, monkeypatch):
    monkeypatch.setattr(annotator, "load_model", lambda ctx, record, cache_dir: FakeModel())
    upload_video(client, project["id"], belt_video)  # 7 frames (see conftest)
    return project


def test_new_project_gets_a_name_matched_class_map(project):
    assert project["class_map_source"] == "name_match"
    assert project["class_map"]["Glass_Bottle"] == "glass"
    assert project["class_map"]["Plastics-PET_Bottle"] == "plastic"
    assert project["class_map"]["Metals_Lid"] == "metal"
    assert "Fiber_Cup-&-glass" not in project["class_map"]
    assert "Battery" not in project["class_map"]


def test_class_map_can_be_edited_until_frames_are_labelled(client, labelled_project):
    pid = labelled_project["id"]
    url = f"/api/projects/{pid}/class-map"
    assert client.put(url, json={"class_map": {"Nonsense": "glass"}}).status_code == 422
    assert client.put(url, json={"class_map": {"Glass_Bottle": "wood"}}).status_code == 422
    saved = client.put(url, json={"class_map": {"Glass_Bottle": "glass", "Battery": "metal"}}).json()
    assert saved["class_map"] == {"Glass_Bottle": "glass", "Battery": "metal"}
    assert saved["class_map_source"] == "user"

    assert client.post(f"/api/projects/{pid}/jobs", json={"type": "prelabel"}).json()["status"] == "succeeded"
    locked = client.put(url, json={"class_map": {"Glass_Bottle": "glass"}})
    assert locked.status_code == 409  # labels were made with the map; changing it now would lie


def test_dry_run_estimates_and_changes_nothing(client, labelled_project):
    pid = labelled_project["id"]
    job = client.post(f"/api/projects/{pid}/jobs", json={"type": "prelabel", "dry_run": True}).json()
    assert job["status"] == "succeeded"
    assert job["result"] == {"estimate": {"images": 7, "gemini_calls": 0, "gpu_minutes": 0}}
    project = client.get(f"/api/projects/{pid}").json()
    assert project["counts"]["predicted"] == 0 and project["state"] == "data_uploaded"
    assert client.get(f"/api/projects/{pid}/images", params={"status": "predicted"}).json()["images"] == []


def test_prelabel_labels_every_frame_in_the_master_format(client, labelled_project):
    pid = labelled_project["id"]
    job = client.post(f"/api/projects/{pid}/jobs", json={"type": "prelabel"}).json()
    assert job["status"] == "succeeded", job["error"]
    result = job["result"]
    assert result["images"] == 7 and result["objects"] == 14
    assert result["objects_per_image_mean"] == 2.0
    assert result["unmapped_objects"] == 7 and result["images_with_no_objects"] == 0
    assert result["per_class"] == {"glass": 7, "plastic": 7}
    assert result["label_model"] == {"recipe": "circularnet_rfdetr", "version": 0, "profile": "default"}
    assert job["progress"] == {"done": 7, "total": 7}

    project = client.get(f"/api/projects/{pid}").json()
    assert project["counts"]["predicted"] == 7 and project["state"] == "labelling"

    images = client.get(f"/api/projects/{pid}/images", params={"status": "predicted"}).json()["images"]
    assert len(images) == 7 and all(i["object_count"] == 2 and i["round"] == 0 for i in images)

    detail = client.get(f"/api/projects/{pid}/images/{images[0]['id']}").json()
    label = detail["label"]
    assert label["image_id"] == images[0]["id"] and (label["width"], label["height"]) == (320, 240)
    assert label["label_model"]["recipe"] == "circularnet_rfdetr"
    glass, plastic = label["objects"]  # highest score first
    assert glass["class"] == "glass" and glass["source"] == "model" and glass["score"] == 0.9
    assert glass["polygon_xy"] == [[10, 10], [110, 10], [110, 110]]
    assert plastic["class"] == "plastic" and plastic["polygon_xy"] is None
    assert set(glass) >= {"id", "class", "bbox_xyxy", "polygon_xy", "mask_rle", "source", "score", "round"}


def test_prelabel_refuses_to_start_with_nothing_to_label(client, project, labelled_project):
    pid = labelled_project["id"]
    assert client.post(f"/api/projects/{pid}/jobs", json={"type": "prelabel"}).json()["status"] == "succeeded"
    again = client.post(f"/api/projects/{pid}/jobs", json={"type": "prelabel"})
    assert again.status_code == 409 and "no unlabelled frames" in again.json()["error"]["message"]

    empty = client.post(
        "/api/projects",
        json={"name": "empty", "classes": ["glass"], "recipe": "circularnet_rfdetr",
              "prelabel_recipe": "circularnet_rfdetr"},
    ).json()  # fmt: skip
    refused = client.post(f"/api/projects/{empty['id']}/jobs", json={"type": "prelabel"})
    assert refused.status_code == 409


def test_unknown_profile_fails_the_job_with_a_clear_error(client, labelled_project):
    pid = labelled_project["id"]
    job = client.post(
        f"/api/projects/{pid}/jobs", json={"type": "prelabel", "params": {"profile": "nope"}}
    ).json()
    assert job["status"] == "failed" and "unknown profile" in job["error"]
    assert client.get(f"/api/projects/{pid}").json()["counts"]["predicted"] == 0
