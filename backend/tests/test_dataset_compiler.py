"""Dataset export (agents.yaml dataset_compiler; plan.md Phase 5).

The export is COCO segmentation in the folder layout CircularNet's training library reads.
"""
import json

import cv2
import numpy as np
import pytest

from agents import annotator, dataset_compiler, teacher_qa
from app import deps
from app.settings import load_agents_config
from tests.test_review_and_qa import METAL, OBJECTS, FakeModel, ScriptedGemini, all_ok, review, upload_video

RATIOS = {"train": 0.7, "val": 0.2, "test": 0.1}


def _frames(session, n, start=0):
    return [{"id": f"{session}_{k:03d}", "session_id": session, "timestamp_s": float(start + k)} for k in range(n)]


def test_one_session_is_split_into_blocks_of_time_not_at_random():
    frames = _frames("a", 20)
    splits = dataset_compiler.assign_splits(frames, RATIOS)
    order = [splits[f["id"]] for f in frames]
    assert order == ["train"] * 14 + ["val"] * 4 + ["test"] * 2
    # No frame sits between two frames of another split: each split is one stretch of the video.
    assert order == sorted(order, key=["train", "val", "test"].index)


def test_many_sessions_are_kept_whole():
    frames = [f for s in "abcdef" for f in _frames(s, 10)]
    splits = dataset_compiler.assign_splits(frames, RATIOS)
    for session in "abcdef":
        assert len({splits[f["id"]] for f in frames if f["session_id"] == session}) == 1
    assert set(splits.values()) == {"train", "val", "test"}


def test_a_tiny_pool_still_holds_one_frame_back_for_validation():
    splits = dataset_compiler.assign_splits(_frames("a", 4), RATIOS)
    assert sorted(splits.values()) == ["train", "train", "train", "val"]


def test_two_short_sessions_still_leave_one_frame_for_validation():
    # Seen live on 20 Nov: 3 passed frames across 2 videos, and the export refused to run.
    frames = _frames("a", 2) + _frames("b", 1)
    splits = dataset_compiler.assign_splits(frames, RATIOS)
    assert sorted(splits.values()) == ["train", "train", "val"]
    assert splits["a_001"] == "val"  # the last frame of the longest session


# --- COCO annotations ---------------------------------------------------------------
PROJECT_CLASSES = ["glass", "plastic", "metal"]


def _label(*objects, width=200, height=100):
    """A 200x100 frame: squashed to 432x432, x grows by 2.16 and y by 4.32."""
    return {"width": width, "height": height, "objects": list(objects)}


def test_coco_outline_is_scaled_into_the_squashed_image_with_its_box_and_area():
    triangle = {"class": "plastic", "bbox_xyxy": [0, 0, 100, 50], "polygon_xy": [[50, 25], [100, 25], [100, 50]]}
    (ann,) = dataset_compiler.coco_annotations(_label(triangle), PROJECT_CLASSES, 432)
    assert ann["category_id"] == 2  # 1-based, in the project's class order
    assert ann["segmentation"] == [pytest.approx([108.0, 108.0, 216.0, 108.0, 216.0, 216.0])]
    # The box and the area are the outline's own, not the label's bbox_xyxy (which is larger here).
    assert ann["bbox"] == pytest.approx([108.0, 108.0, 108.0, 108.0])  # x, y, width, height
    assert ann["area"] == pytest.approx(108 * 108 / 2)
    assert ann["iscrowd"] == 0


def test_coco_category_ids_are_one_based_in_class_order():
    objects = [{"class": c, "bbox_xyxy": [0, 0, 100, 50], "polygon_xy": None} for c in ("metal", "glass", "plastic")]
    found = dataset_compiler.coco_annotations(_label(*objects), PROJECT_CLASSES, 432)
    assert [a["category_id"] for a in found] == [3, 1, 2]


def test_coco_object_without_an_outline_is_written_as_its_box():
    drawn = {"class": "metal", "bbox_xyxy": [100, 50, 200, 100], "polygon_xy": None}  # a box a person drew
    two_points = {"class": "glass", "bbox_xyxy": [0, 0, 100, 50], "polygon_xy": [[0, 0], [100, 50]]}  # not an outline
    metal, glass = dataset_compiler.coco_annotations(_label(drawn, two_points), PROJECT_CLASSES, 432)
    assert metal["category_id"] == 3
    assert metal["segmentation"] == [pytest.approx([216.0, 216.0, 432.0, 216.0, 432.0, 432.0, 216.0, 432.0])]
    assert metal["bbox"] == pytest.approx([216.0, 216.0, 216.0, 216.0])
    assert metal["area"] == pytest.approx(216 * 216)
    assert glass["segmentation"] == [pytest.approx([0.0, 0.0, 216.0, 0.0, 216.0, 216.0, 0.0, 216.0])]


def test_coco_skips_an_object_of_a_class_the_project_does_not_have():
    wood = {"class": "wood", "bbox_xyxy": [0, 0, 10, 10], "polygon_xy": None}
    glass = {"class": "glass", "bbox_xyxy": [0, 0, 100, 50], "polygon_xy": None}
    found = dataset_compiler.coco_annotations(_label(wood, glass), PROJECT_CLASSES, 432)
    assert [a["category_id"] for a in found] == [1]


def test_coco_skips_a_degenerate_outline():
    line = {"class": "glass", "bbox_xyxy": [0, 0, 100, 50], "polygon_xy": [[0, 0], [50, 25], [100, 50]]}  # no area
    speck = {"class": "glass", "bbox_xyxy": [10, 10, 10.3, 10.2], "polygon_xy": None}  # under 1 px2 once squashed
    empty_box = {"class": "glass", "bbox_xyxy": [40, 40, 40, 40], "polygon_xy": None}
    real = {"class": "plastic", "bbox_xyxy": [0, 0, 100, 50], "polygon_xy": None}
    found = dataset_compiler.coco_annotations(_label(line, speck, empty_box, real), PROJECT_CLASSES, 432)
    assert [a["category_id"] for a in found] == [2]


def test_coco_outline_that_leaves_the_frame_is_clipped_to_it():
    over = {"class": "glass", "bbox_xyxy": [150, 50, 220, 120], "polygon_xy": [[150, 50], [220, 50], [220, 120], [150, 120]]}
    (ann,) = dataset_compiler.coco_annotations(_label(over), PROJECT_CLASSES, 432)
    assert ann["segmentation"] == [pytest.approx([324.0, 216.0, 432.0, 216.0, 432.0, 432.0, 324.0, 432.0])]
    assert ann["bbox"] == pytest.approx([324.0, 216.0, 108.0, 216.0])


def _coco(**changes):
    """A well-formed file of one 432x432 image and one triangle; `changes` spoil the annotation."""
    annotation = {"id": 1, "image_id": 1, "category_id": 1, "segmentation": [[10.0, 10.0, 200.0, 10.0, 200.0, 200.0]],
                  "bbox": [10.0, 10.0, 190.0, 190.0], "area": 18050.0, "iscrowd": 0}  # fmt: skip
    return {"images": [{"id": 1, "file_name": "f.jpg", "width": 432, "height": 432}],
            "annotations": [{**annotation, **changes}],
            "categories": [{"id": i + 1, "name": c} for i, c in enumerate(PROJECT_CLASSES)]}  # fmt: skip


def test_check_coco_accepts_what_the_exporter_writes():
    assert dataset_compiler.check_coco(_coco(), 3, 432) is None
    assert dataset_compiler.check_coco(_coco(category_id=3), 3, 432) is None  # the last class
    assert dataset_compiler.check_coco(_coco(segmentation=[[0.0, 0.0, 432.0, 0.0, 432.0, 432.0]]), 3, 432) is None  # the edge is inside
    label = _label(
        {"class": "glass", "bbox_xyxy": [-5, -5, 250, 120], "polygon_xy": None},
        {"class": "metal", "bbox_xyxy": [0, 0, 100, 50], "polygon_xy": [[0, 0], [100, 0], [100, 50]]},
    )
    made = dataset_compiler.coco_annotations(label, PROJECT_CLASSES, 432)
    doc = _coco()
    doc["annotations"] = [{"id": n, "image_id": 1, **a} for n, a in enumerate(made, start=1)]
    assert len(made) == 2 and dataset_compiler.check_coco(doc, 3, 432) is None


def test_check_coco_catches_a_category_outside_the_class_list():
    assert "category 4 is out of range" in dataset_compiler.check_coco(_coco(category_id=4), 3, 432)
    # Category ids start at 1: a 0 here means the classes were numbered the YOLO way.
    assert "category 0 is out of range" in dataset_compiler.check_coco(_coco(category_id=0), 3, 432)


def test_check_coco_catches_a_coordinate_outside_the_image():
    too_far = dataset_compiler.check_coco(_coco(segmentation=[[10.0, 10.0, 432.5, 10.0, 200.0, 200.0]]), 3, 432)
    assert too_far == "annotation 1: a coordinate is outside the image"
    assert "outside the image" in dataset_compiler.check_coco(_coco(segmentation=[[10.0, -0.5, 200.0, 10.0, 200.0, 200.0]]), 3, 432)


def test_check_coco_catches_a_broken_outline_and_an_orphan_annotation():
    assert "three points" in dataset_compiler.check_coco(_coco(segmentation=[[10.0, 10.0, 200.0, 10.0]]), 3, 432)
    assert "three points" in dataset_compiler.check_coco(_coco(segmentation=[[10.0, 10.0, 200.0, 10.0, 200.0, 200.0, 5.0]]), 3, 432)
    assert "its image is not in the file" in dataset_compiler.check_coco(_coco(image_id=7), 3, 432)


@pytest.fixture
def checked_project(client, project, belt_video, monkeypatch):
    """7 frames: 3 become gold (2 exemplars + 1 hold-out), the other 4 pass the Gemini check."""
    rules = load_agents_config()["agents"]["data_intake"]["gold_set"]
    saved = dict(rules)
    rules.update(required_images=3, exemplar_count=2, holdout_count=1, min_examples_per_class=1)
    monkeypatch.setattr(annotator, "load_model", lambda ctx, record, cache_dir: FakeModel())
    monkeypatch.setattr(teacher_qa, "make_reviewer", lambda ctx: (ScriptedGemini([all_ok]), "scripted-gemini"))
    pid = project["id"]
    upload_video(client, pid, belt_video)

    def job(job_type, **extra):
        return client.post(f"/api/projects/{pid}/jobs", json={"type": job_type, **extra}).json()

    assert job("prelabel")["status"] == "succeeded"
    ids = [i["id"] for i in client.get(f"/api/projects/{pid}/images").json()["images"]]
    review(client, pid, ids[0], action="fix", objects=[*OBJECTS, METAL])
    review(client, pid, ids[1], action="accept")
    review(client, pid, ids[2], action="accept")
    assert client.post(f"/api/projects/{pid}/gold/freeze").status_code == 200
    assert job("holdout_check")["status"] == "succeeded"
    yield pid, ids, job
    rules.clear()
    rules.update(saved)


def test_compile_waits_for_checked_frames(client, checked_project):
    pid, _, job = checked_project
    refused = client.post(f"/api/projects/{pid}/jobs", json={"type": "compile"})
    assert refused.status_code == 409 and "passed the check" in refused.json()["error"]["message"]
    assert job("compile", dry_run=True)["result"] == {"estimate": {"images": 2, "gemini_calls": 0, "gpu_minutes": 0}}


def test_compile_writes_an_immutable_coco_dataset_without_the_hold_out(client, checked_project):
    pid, ids, job = checked_project
    assert job("qa")["result"]["passed"] == 4
    done = job("compile")
    assert done["status"] == "succeeded", done["error"]
    result = done["result"]
    assert result["version"] == 1 and result["format"] == "coco_json" and result["image_size"] == 432
    # 4 passed frames -> 3 train + 1 val; the 2 gold exemplars join train; the hold-out stays out.
    assert {k: v["images"] for k, v in result["splits"].items()} == {"train": 5, "val": 1, "test": 0}
    assert result["images"] == 6
    assert result["label_sources"] == {"gold": 5, "model": 8}  # counts of objects, by who made the label
    assert result["objects_per_class"] == {"glass": 6, "plastic": 6, "metal": 1}

    blobs = deps.get_blobs()
    prefix = f"projects/{pid}/datasets/v1"
    holdout_id = ids[2]
    assert not any(holdout_id in key for key in blobs.list_keys(f"{prefix}/"))  # the exam is never trained on
    image = cv2.imdecode(np.frombuffer(blobs.read_bytes(f"{prefix}/train/{ids[0]}.jpg"), np.uint8), 1)
    assert image.shape[:2] == (432, 432)  # squashed to the model's square input

    project = client.get(f"/api/projects/{pid}").json()
    assert project["state"] == "dataset_ready"
    assert client.get(f"/api/projects/{pid}/events").json()["events"][0]["type"] == "dataset_ready"
    versions = client.get(f"/api/projects/{pid}/dataset-versions").json()["dataset_versions"]
    assert [v["version"] for v in versions] == [1] and versions[0]["validated_by"] == "format_check"

    before = {key: blobs.read_bytes(key) for key in blobs.list_keys(f"{prefix}/")}
    again = job("compile")  # a second export is a new version; the first is not overwritten
    assert again["result"]["version"] == 2
    assert {key: blobs.read_bytes(key) for key in blobs.list_keys(f"{prefix}/")} == before
    assert blobs.exists(f"projects/{pid}/datasets/v2/train/_annotations.coco.json")


def test_compile_lays_the_dataset_out_as_coco_folders_the_training_library_reads(client, checked_project):
    pid, ids, job = checked_project
    assert job("qa")["result"]["passed"] == 4
    assert job("compile")["status"] == "succeeded"
    blobs = deps.get_blobs()
    prefix = f"projects/{pid}/datasets/v1"
    holdout_id = ids[2]

    def read(folder):
        return json.loads(blobs.read_bytes(f"{prefix}/{folder}/_annotations.coco.json"))

    train, valid = read("train"), read("valid")  # the app's "val" split is the folder "valid"
    train_files = [i["file_name"] for i in train["images"]]
    valid_files = [i["file_name"] for i in valid["images"]]
    # Every file of the version: one annotation file per folder, with that folder's images beside it.
    # No test/ folder (no test frames), and none of the YOLO layout: no data.yaml, images/ or labels/.
    assert blobs.list_keys(f"{prefix}/") == sorted(
        [f"{prefix}/train/_annotations.coco.json", f"{prefix}/valid/_annotations.coco.json"]
        + [f"{prefix}/train/{name}" for name in train_files]
        + [f"{prefix}/valid/{name}" for name in valid_files]
    )
    assert len(train_files) == 5 and len(valid_files) == 1 and not set(train_files) & set(valid_files)
    assert sorted(train_files + valid_files) == sorted(f"{i}.jpg" for i in ids if i != holdout_id)
    assert f"{holdout_id}.jpg" not in train_files + valid_files  # the gold hold-out is in no split

    for doc in (train, valid):
        # Category ids are 1-based, in the project's class order.
        assert [(c["id"], c["name"]) for c in doc["categories"]] == [(1, "glass"), (2, "plastic"), (3, "metal")]
        assert all((i["width"], i["height"]) == (432, 432) for i in doc["images"])
        assert [i["id"] for i in doc["images"]] == list(range(1, len(doc["images"]) + 1))
        assert [a["id"] for a in doc["annotations"]] == list(range(1, len(doc["annotations"]) + 1))
        assert {a["image_id"] for a in doc["annotations"]} <= {i["id"] for i in doc["images"]}
        assert {a["category_id"] for a in doc["annotations"]} <= {1, 2, 3}
        assert dataset_compiler.check_coco(doc, 3, 432) is None
    assert len(train["annotations"]) == 11 and len(valid["annotations"]) == 2  # the 13 objects of the result

    # The frame a person fixed: glass and plastic keep the model's outlines, the metal box
    # a person drew has none and is written as its rectangle. 320x240 -> x * 1.35, y * 1.8.
    fixed_no = next(i["id"] for i in train["images"] if i["file_name"] == f"{ids[0]}.jpg")
    glass, plastic, metal = (a for a in train["annotations"] if a["image_id"] == fixed_no)
    assert [glass["category_id"], plastic["category_id"], metal["category_id"]] == [1, 2, 3]
    assert glass["segmentation"] == [pytest.approx([13.5, 18.0, 148.5, 18.0, 148.5, 198.0])]
    assert glass["bbox"] == pytest.approx([13.5, 18.0, 135.0, 180.0]) and glass["area"] == pytest.approx(12150.0)
    assert metal["segmentation"] == [pytest.approx([270.0, 36.0, 351.0, 36.0, 351.0, 144.0, 270.0, 144.0])]
    assert metal["bbox"] == pytest.approx([270.0, 36.0, 81.0, 108.0]) and metal["area"] == pytest.approx(8748.0)
