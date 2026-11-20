"""SAM outlines for boxes that have none (docs/api.md "SAM outlines"; agents.yaml outliner_sam).

SAM itself is replaced by a stand-in that returns a filled rectangle a little smaller than
the box, so the outline it yields is known exactly.
"""
import numpy as np
import pytest

from agents import outliner, trainer
from app import deps
from tests.test_review_and_qa import METAL, OBJECTS, labelled, review, small_gold  # noqa: F401 - fixtures
from tests.test_trainer import trainable  # noqa: F401 - fixture


def rectangle_sam(shrink=4, fail=False):
    calls = []

    def fake(weights, image_bgr, boxes):
        assert weights.is_file()  # the weights were fetched from storage
        calls.append(len(boxes))
        masks = []
        for x0, y0, x1, y1 in boxes:
            mask = np.zeros(image_bgr.shape[:2], dtype=bool)
            if not fail:
                mask[int(y0) + shrink:int(y1) - shrink, int(x0) + shrink:int(x1) - shrink] = True
            masks.append(mask)
        return masks

    return fake, calls


@pytest.fixture
def with_sam(labelled, monkeypatch):
    """A pre-labelled project (7 frames) with the SAM weights in storage."""
    pid, ids = labelled
    deps.get_blobs().write_bytes("seed/sam/mobile_sam.pt", b"sam weights", "application/octet-stream")

    def use(fake):
        monkeypatch.setattr(outliner, "run_sam", fake)

    return pid, ids, use


def metal_annotation(pid, image_id):
    """The exported COCO annotation of the box a person drew (metal is the third class)."""
    import json

    coco = json.loads(deps.get_blobs().read_bytes(f"projects/{pid}/datasets/v1/train/_annotations.coco.json"))
    image_no = next(i["id"] for i in coco["images"] if i["file_name"] == f"{image_id}.jpg")
    return next(a for a in coco["annotations"] if a["image_id"] == image_no and a["category_id"] == 3)


def job(client, pid, **body):
    return client.post(f"/api/projects/{pid}/jobs", json={"type": "outline", **body})


def test_polygon_stays_inside_its_padded_box():
    mask = np.zeros((100, 100), dtype=bool)
    mask[10:90, 10:90] = True  # SAM spilled far beyond the box
    polygon = outliner.polygon_for(mask, [40, 40, 60, 60], pad=4)
    xs, ys = [p[0] for p in polygon], [p[1] for p in polygon]
    assert min(xs) >= 36 and max(xs) <= 64 and min(ys) >= 36 and max(ys) <= 64
    assert outliner.polygon_for(np.zeros((100, 100), dtype=bool), [40, 40, 60, 60], pad=4) is None
    assert outliner.polygon_for(None, [40, 40, 60, 60], pad=4) is None


def test_a_drawn_box_is_counted_as_missing_an_outline(client, with_sam):
    pid, ids, _ = with_sam
    assert client.get(f"/api/projects/{pid}/qa/summary").json()["outlines"] == {"frames_missing": 0, "objects_missing": 0}
    refused = job(client, pid)
    assert refused.status_code == 409 and "No object is missing an outline" in refused.json()["error"]["message"]

    fixed = review(client, pid, ids[0], action="fix", objects=[*OBJECTS, METAL]).json()
    assert fixed["image"]["missing_outlines"] == 1
    assert client.get(f"/api/projects/{pid}/qa/summary").json()["outlines"] == {"frames_missing": 1, "objects_missing": 1}
    assert client.get(f"/api/projects/{pid}/gold").json()["boxes_without_outline"] == 1


def test_outline_job_draws_the_shape_and_touches_nothing_else(client, with_sam):
    pid, ids, use = with_sam
    fake, calls = rectangle_sam()
    use(fake)
    review(client, pid, ids[0], action="fix", objects=[*OBJECTS, METAL])
    before = client.get(f"/api/projects/{pid}/images/{ids[0]}").json()

    estimate = job(client, pid, dry_run=True).json()["result"]["estimate"]
    assert estimate == {"images": 1, "objects": 1, "gemini_calls": 0, "gpu_minutes": 0} and calls == []

    done = job(client, pid).json()
    assert done["status"] == "succeeded", done["error"]
    assert {k: done["result"][k] for k in ("images", "objects", "failed_objects", "model")} == {
        "images": 1, "objects": 1, "failed_objects": 0, "model": "mobile_sam",
    }  # fmt: skip
    assert calls == [1]  # one frame, and only the one box that had no outline

    after = client.get(f"/api/projects/{pid}/images/{ids[0]}").json()
    assert after["image"]["round"] == before["image"]["round"] + 1
    assert after["image"]["label_status"] == "human_done" and after["image"]["missing_outlines"] == 0
    metal = after["label"]["objects"][2]
    assert metal["outline_source"] == "sam"
    xs, ys = [p[0] for p in metal["polygon_xy"]], [p[1] for p in metal["polygon_xy"]]
    assert (min(xs), max(xs), min(ys), max(ys)) == (204, 255, 24, 75)  # the box 200,20,260,80 shrunk by 4
    # SAM decides the shape only.
    assert (metal["class"], metal["source"], metal["score"], metal["bbox_xyxy"]) == ("metal", "human", None, [200, 20, 260, 80])
    glass = after["label"]["objects"][0]
    assert glass["polygon_xy"] == before["label"]["objects"][0]["polygon_xy"] and "outline_source" not in glass
    assert after["label"]["review"]["by"] == "human"  # the review record is carried into the new round

    assert job(client, pid).status_code == 409  # nothing left to outline
    assert client.get(f"/api/projects/{pid}/qa/summary").json()["outlines"]["objects_missing"] == 0


def test_a_box_sam_cannot_outline_stays_a_box(client, with_sam):
    pid, ids, use = with_sam
    fake, _ = rectangle_sam(fail=True)
    use(fake)
    review(client, pid, ids[0], action="fix", objects=[*OBJECTS, METAL])
    result = job(client, pid).json()["result"]
    assert (result["objects"], result["failed_objects"]) == (0, 1)
    after = client.get(f"/api/projects/{pid}/images/{ids[0]}").json()
    assert after["label"]["objects"][2]["polygon_xy"] is None and after["image"]["missing_outlines"] == 1


def test_gold_frames_are_never_outlined_after_the_freeze(client, with_sam):
    pid, ids, use = with_sam
    fake, calls = rectangle_sam()
    use(fake)
    review(client, pid, ids[0], action="fix", objects=[*OBJECTS, METAL])
    for image_id in ids[1:6]:
        review(client, pid, image_id, action="accept")
    assert client.post(f"/api/projects/{pid}/gold/freeze").status_code == 200
    assert client.get(f"/api/projects/{pid}/gold").json()["boxes_without_outline"] == 0  # nothing left that could be fixed
    assert job(client, pid).status_code == 409 and calls == []
    gold = client.get(f"/api/projects/{pid}/images/{ids[0]}").json()
    assert gold["image"]["role"] == "gold_exemplar" and gold["label"]["objects"][2]["polygon_xy"] is None


def test_training_draws_missing_outlines_before_it_exports(client, trainable, monkeypatch):
    pid, start, state = trainable
    deps.get_blobs().write_bytes("seed/sam/mobile_sam.pt", b"sam weights", "application/octet-stream")
    fake, calls = rectangle_sam()
    monkeypatch.setattr(outliner, "run_sam", fake)
    start("holdout_check")
    waiting = client.get(f"/api/projects/{pid}/images", params={"status": "predicted"}).json()["images"]
    review(client, pid, waiting[0]["id"], action="fix", objects=[*OBJECTS, METAL])  # a person draws a box
    start("qa")  # the other three frames pass, so there is enough to train and validate on

    result = start("train", params={"epochs": 1}).json()["result"]
    assert result["outlines"]["objects"] == 1 and calls == [1] and "outlines_error" not in result
    ring = metal_annotation(pid, waiting[0]["id"])["segmentation"][0]
    # SAM's outline starts 4 px inside the drawn box: x 204 of 320 -> 275.4 of 432, not the box's 270.
    assert min(ring[0::2]) == 275.4 and min(ring[1::2]) == 43.2


def test_training_goes_on_with_rectangles_when_sam_cannot_run(client, trainable, monkeypatch):
    pid, start, _ = trainable
    deps.get_blobs().write_bytes("seed/sam/mobile_sam.pt", b"sam weights", "application/octet-stream")

    def broken(weights, image_bgr, boxes):
        raise RuntimeError("SAM could not load")

    monkeypatch.setattr(outliner, "run_sam", broken)
    start("holdout_check")
    waiting = client.get(f"/api/projects/{pid}/images", params={"status": "predicted"}).json()["images"]
    review(client, pid, waiting[0]["id"], action="fix", objects=[*OBJECTS, METAL])
    start("qa")
    done = start("train", params={"epochs": 1}).json()
    assert done["status"] == "succeeded" and "SAM could not load" in done["result"]["outlines_error"]
    assert "outlines" not in done["result"] and trainer is not None
    # The box itself, as a rectangle: 200,20 - 260,80 of 320 x 240 scaled to 432 x 432.
    assert metal_annotation(pid, waiting[0]["id"])["segmentation"][0] == [270.0, 36.0, 351.0, 36.0, 351.0, 144.0, 270.0, 144.0]
