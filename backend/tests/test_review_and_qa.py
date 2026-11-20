"""Human review, the gold set, hold-out scoring and the Gemini teacher loop.

docs/api.md "Review, gold set and the teacher loop"; plan.md section 5 teacher-loop rules.
Gemini is replaced by a scripted reviewer, so pass, fail and malformed answers are exact.
"""
import re

import pytest

from agents import annotator, evaluator, teacher_qa
from agents.annotator import Detection
from app.settings import load_agents_config
from tests.conftest import upload_video


class FakeModel:
    """Glass and plastic on every frame; with the tiled profile, one more glass object."""

    def predict(self, frame, profile):
        found = [
            Detection("Glass_Bottle", 0.9, (10, 10, 110, 110), [[10, 10], [110, 10], [110, 110]]),
            Detection("Plastics-PET_Bottle", 0.6, (150, 100, 250, 200), [[150, 100], [250, 100], [250, 200]]),
        ]
        if profile.get("tiled"):
            found.append(Detection("Glass_Bottle", 0.5, (260, 10, 310, 60), [[260, 10], [310, 10], [310, 60]]))
        return found


@pytest.fixture
def small_gold():
    """A gold set of 6 (4 exemplars + 2 hold-out) so a 7-frame video is enough."""
    rules = load_agents_config()["agents"]["data_intake"]["gold_set"]
    saved = dict(rules)
    rules.update(required_images=6, exemplar_count=4, holdout_count=2, min_examples_per_class=1)
    yield rules
    rules.clear()
    rules.update(saved)


@pytest.fixture
def labelled(client, project, belt_video, monkeypatch, small_gold):
    """A project with 7 pre-labelled frames (glass + plastic on each)."""
    monkeypatch.setattr(annotator, "load_model", lambda ctx, record, cache_dir: FakeModel())
    pid = project["id"]
    upload_video(client, pid, belt_video)
    assert client.post(f"/api/projects/{pid}/jobs", json={"type": "prelabel"}).json()["status"] == "succeeded"
    images = client.get(f"/api/projects/{pid}/images").json()["images"]
    return pid, [i["id"] for i in images]


def review(client, pid, image_id, **body):
    return client.post(f"/api/projects/{pid}/images/{image_id}/review", json=body)


OBJECTS = [
    {"id": "o1", "class": "glass", "bbox_xyxy": [10, 10, 110, 110]},
    {"id": "o2", "class": "plastic", "bbox_xyxy": [150, 100, 250, 200]},
]
METAL = {"id": None, "class": "metal", "bbox_xyxy": [200, 20, 260, 80]}


# --- review ---------------------------------------------------------------------------
def test_accept_keeps_the_label_and_marks_it_checked_by_a_person(client, labelled):
    pid, ids = labelled
    body = review(client, pid, ids[0], action="accept").json()
    assert body["image"]["label_status"] == "human_done" and body["image"]["round"] == 1
    assert body["label"]["review"]["by"] == "human" and body["label"]["review"]["action"] == "accept"
    assert [o["source"] for o in body["label"]["objects"]] == ["model", "model"]  # nothing was changed
    assert client.get(f"/api/projects/{pid}").json()["counts"]["human_done"] == 1


def test_fix_changes_a_class_adds_a_box_and_deletes_an_object(client, labelled):
    pid, ids = labelled
    fixed = review(
        client, pid, ids[0], action="fix",
        objects=[{**OBJECTS[0], "class": "plastic"}, METAL],  # o1 reclassified, o2 deleted, one drawn
    ).json()["label"]  # fmt: skip
    assert len(fixed["objects"]) == 2
    changed, drawn = fixed["objects"]
    assert changed["class"] == "plastic" and changed["source"] == "human"
    assert changed["polygon_xy"] == [[10, 10], [110, 10], [110, 110]]  # the box did not move, so the outline stays
    assert drawn["class"] == "metal" and drawn["source"] == "human"
    assert drawn["score"] is None and drawn["polygon_xy"] is None and drawn["id"] == "o2"
    assert client.get(f"/api/projects/{pid}/images/{ids[0]}").json()["image"]["object_count"] == 2


def test_fix_rules_and_reject(client, labelled):
    pid, ids = labelled
    assert review(client, pid, ids[0], action="fix", objects=[{**OBJECTS[0], "class": "wood"}]).status_code == 422
    assert review(client, pid, ids[0], action="fix", objects=[{**OBJECTS[0], "bbox_xyxy": [5, 5, 5, 5]}]).status_code == 422
    assert review(client, pid, ids[0], action="fix", objects=[]).json()["label"]["objects"] == []  # an empty belt

    rejected = review(client, pid, ids[1], action="reject").json()
    assert rejected["image"]["label_status"] == "rejected" and rejected["image"]["round"] == 0
    counts = client.get(f"/api/projects/{pid}").json()["counts"]
    assert (counts["human_done"], counts["rejected"]) == (1, 1)
    # Reviewing again moves the frame between counters instead of counting it twice.
    review(client, pid, ids[1], action="accept")
    counts = client.get(f"/api/projects/{pid}").json()["counts"]
    assert (counts["human_done"], counts["rejected"]) == (2, 0)


def test_boxes_without_an_outline_are_counted(client, labelled):
    # The screens say how many boxes still wait for an outline (tests/test_outliner.py covers drawing them).
    pid, ids = labelled
    assert client.get(f"/api/projects/{pid}/qa/summary").json()["outlines"] == {"frames_missing": 0, "objects_missing": 0}
    assert client.get(f"/api/projects/{pid}/gold").json()["boxes_without_outline"] == 0

    review(client, pid, ids[0], action="fix", objects=[*OBJECTS, METAL])  # a person draws one box: it has no outline
    moved = {**OBJECTS[0], "bbox_xyxy": [20, 20, 120, 120]}  # a moved box loses the outline that no longer fits
    review(client, pid, ids[1], action="fix", objects=[moved, OBJECTS[1], METAL])
    assert client.get(f"/api/projects/{pid}/qa/summary").json()["outlines"] == {"frames_missing": 2, "objects_missing": 3}
    assert client.get(f"/api/projects/{pid}/gold").json()["boxes_without_outline"] == 3


# --- gold set ---------------------------------------------------------------------------
def make_gold(client, pid, ids):
    """Review six frames (one with a metal box, so every class has an example) and freeze."""
    review(client, pid, ids[0], action="fix", objects=[*OBJECTS, METAL])
    for image_id in ids[1:6]:
        review(client, pid, image_id, action="accept")
    return client.post(f"/api/projects/{pid}/gold/freeze")


def test_gold_status_says_what_is_missing_and_freeze_waits_for_it(client, labelled):
    pid, ids = labelled
    for image_id in ids[:5]:
        review(client, pid, image_id, action="accept")
    status = client.get(f"/api/projects/{pid}/gold").json()
    assert status["frozen"] is False and status["reviewed_images"] == 5
    assert status["ready_to_freeze"] is False
    assert "5 of 6 frames have been checked by a person" in status["blocking"]
    refused = client.post(f"/api/projects/{pid}/gold/freeze")
    assert refused.status_code == 409 and "5 of 6" in refused.json()["error"]["message"]

    review(client, pid, ids[5], action="accept")  # six frames now, but no metal anywhere
    status = client.get(f"/api/projects/{pid}/gold").json()
    assert status["objects_per_class"] == {"glass": 6, "plastic": 6, "metal": 0}
    assert status["blocking"] == ["metal has 0 of 1 examples"]


def test_freeze_makes_a_read_only_gold_set_with_a_block_hold_out(client, labelled):
    pid, ids = labelled
    frozen = make_gold(client, pid, ids)
    assert frozen.status_code == 200, frozen.text
    status = frozen.json()
    assert status["frozen"] and (status["gold_exemplar"], status["gold_holdout"]) == (4, 2)
    assert "hold-out is 2 frames" in status["holdout_note"]

    images = {i["id"]: i for i in client.get(f"/api/projects/{pid}/images").json()["images"]}
    roles = [images[i]["role"] for i in ids]
    # Ordered by time: the first four reviewed are exemplars, the last two the hold-out.
    assert roles == ["gold_exemplar"] * 4 + ["gold_holdout"] * 2 + ["unlabelled"]
    gold_label = client.get(f"/api/projects/{pid}/images/{ids[0]}").json()["label"]
    assert {o["source"] for o in gold_label["objects"]} == {"gold"}

    counts = client.get(f"/api/projects/{pid}").json()["counts"]
    assert (counts["frames"], counts["predicted"], counts["human_done"]) == (1, 1, 0)  # gold left the pool

    assert review(client, pid, ids[0], action="accept").status_code == 403  # gold is never modified
    assert review(client, pid, ids[5], action="reject").status_code == 403
    assert client.post(f"/api/projects/{pid}/gold/freeze").status_code == 409  # only once
    assert client.get(f"/api/projects/{pid}/images", params={"status": "gold"}).json()["images"][0]["role"] == "gold_exemplar"


# --- scoring ----------------------------------------------------------------------------
def _obj(cls, box, score=0.9):
    return {"class": cls, "bbox_xyxy": box, "score": score}


def test_score_counts_everything_it_reports():
    gold = [_obj("glass", [0, 0, 100, 100]), _obj("plastic", [200, 200, 300, 300]), _obj("metal", [400, 0, 450, 50])]
    predicted = [
        _obj("glass", [0, 0, 100, 100]),  # right
        _obj("glass", [200, 200, 300, 300], 0.8),  # right place, wrong class
        _obj("plastic", [500, 500, 550, 550], 0.7),  # nothing there
    ]  # the metal object is missed
    result = evaluator.score([(predicted, gold)], ["glass", "plastic", "metal"])
    assert (result["n_images"], result["n_objects_gold"], result["n_objects_model"], result["matched"]) == (1, 3, 3, 2)
    assert result["mean_iou"] == 1.0
    assert result["precision"] == pytest.approx(2 / 3, abs=1e-3) and result["recall"] == pytest.approx(2 / 3, abs=1e-3)
    assert result["class_agreement"] == 0.5
    assert result["per_class_recall"] == {
        "glass": {"recall": 1.0, "n": 1}, "plastic": {"recall": 0.0, "n": 1}, "metal": {"recall": 0.0, "n": 1},
    }  # fmt: skip
    # glass: both glass predictions rank above nothing else; the first is right -> AP 1. Others 0.
    assert result["map50"] == pytest.approx(1 / 3, abs=1e-3)
    perfect = evaluator.score([(gold, gold)], ["glass", "plastic", "metal"])
    assert perfect["map50"] == 1.0 and perfect["map50_95"] == 1.0 and perfect["class_agreement"] == 1.0


def test_score_with_nothing_to_compare_gives_no_number():
    result = evaluator.score([([], [])], ["glass"])
    assert result["mean_iou"] is None and result["precision"] is None and result["map50"] is None
    assert result["per_class_recall"]["glass"] == {"recall": None, "n": 0}


def test_hold_out_check_needs_the_gold_set_then_scores_and_records_version_zero(client, labelled):
    pid, ids = labelled
    early = client.post(f"/api/projects/{pid}/jobs", json={"type": "holdout_check"})
    assert early.status_code == 409 and "Freeze the gold set first" in early.json()["error"]["message"]

    make_gold(client, pid, ids)
    job = client.post(f"/api/projects/{pid}/jobs", json={"type": "holdout_check"}).json()
    assert job["status"] == "succeeded", job["error"]
    result = job["result"]
    # The hold-out frames were accepted as the model labelled them, so the model agrees fully.
    assert (result["n_images"], result["n_objects_gold"], result["matched"]) == (2, 4, 4)
    assert result["mean_iou"] == 1.0 and result["passed"] is True and result["threshold"] == 0.75
    assert result["eval_set"] == "gold_holdout" and result["label_model"]["version"] == 0

    summary = client.get(f"/api/projects/{pid}/qa/summary").json()
    assert summary["holdout"]["mean_iou"] == 1.0 and summary["holdout"]["n_images"] == 2
    # Scoring reads gold and never writes it.
    assert client.get(f"/api/projects/{pid}/images/{ids[5]}").json()["label"]["objects"][0]["source"] == "gold"


# --- the Gemini teacher loop --------------------------------------------------------------
class ScriptedGemini:
    """Answers from a script, one entry per call. An entry is a function of the box numbers
    in the question, or an Exception to raise."""

    def __init__(self, script):
        self.script, self.calls = list(script), 0

    def __call__(self, parts, schema):
        self.calls += 1
        numbers = [int(n) for n in re.findall(r"(\d+): \w+", parts[-1]["text"])]
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, Exception):
            raise step
        return step(numbers)


def all_ok(numbers, **extra):
    objects = [{"number": n, "class_ok": True, "correct_class": "same", "box_ok": True, "confidence": "high"} for n in numbers]
    return {"objects": objects, "missed_objects": 0, "reason": "All labels look right.", **extra}


def wrong_class(number, correct, confidence="high"):
    def answer(numbers):
        body = all_ok(numbers)
        body["objects"][number - 1].update(class_ok=False, correct_class=correct, confidence=confidence)
        body["reason"] = f"Box {number} is {correct}."
        return body

    return answer


@pytest.fixture
def ready_for_qa(client, labelled, monkeypatch):
    """Gold frozen, hold-out check passed, one frame waiting. Returns a way to run QA."""
    pid, ids = labelled
    make_gold(client, pid, ids)
    assert client.post(f"/api/projects/{pid}/jobs", json={"type": "holdout_check"}).json()["status"] == "succeeded"

    def run(script):
        gemini = ScriptedGemini(script)
        monkeypatch.setattr(teacher_qa, "make_reviewer", lambda ctx: (gemini, "scripted-gemini"))
        job = client.post(f"/api/projects/{pid}/jobs", json={"type": "qa"}).json()
        return job, gemini

    return pid, ids[6], run


def test_qa_waits_for_the_hold_out_check(client, labelled):
    pid, ids = labelled
    refused = client.post(f"/api/projects/{pid}/jobs", json={"type": "qa"})
    assert refused.status_code == 409 and "hold-out check" in refused.json()["error"]["message"]


def test_dry_run_gives_the_worst_case_number_of_gemini_calls(client, ready_for_qa):
    pid, _, _ = ready_for_qa
    job = client.post(f"/api/projects/{pid}/jobs", json={"type": "qa", "dry_run": True}).json()
    assert job["result"]["estimate"] == {"images": 1, "gemini_calls": 6, "gpu_minutes": 0, "gemini_calls_remaining": 2000}
    assert client.get(f"/api/projects/{pid}").json()["gemini_calls_used"] == 0


def test_a_frame_gemini_agrees_with_passes_in_round_zero(client, ready_for_qa):
    pid, image_id, run = ready_for_qa
    job, gemini = run([all_ok])
    assert job["status"] == "succeeded", job["error"]
    result = job["result"]
    assert (result["images"], result["passed"], result["human_review"]) == (1, 1, 0)
    assert result["rounds"] == {"0": 1} and result["gemini_calls"] == 1 == gemini.calls
    assert result["judge_model"] == "scripted-gemini" and result["prompt_version"] == "qa-v2"

    detail = client.get(f"/api/projects/{pid}/images/{image_id}").json()
    assert detail["image"]["label_status"] == "passed" and detail["image"]["round"] == 0
    (verdict,) = detail["verdicts"]
    # Every decision is logged with the judge, the prompt version, the round and the labelling model.
    assert verdict["verdict"] == "pass" and verdict["stage"] == "gemini" and verdict["round"] == 0
    assert verdict["judge_model"] == "scripted-gemini" and verdict["prompt_version"] == "qa-v2"
    assert verdict["label_model"]["recipe"] == "circularnet_rfdetr"

    summary = client.get(f"/api/projects/{pid}/qa/summary").json()
    assert summary["pass_rate"] == 1.0 and summary["n_images"] == 1
    assert summary["gemini_calls"] == {"used": 1, "cap": 2000}
    assert summary["last_qa"]["passed"] == 1 and summary["images"]["waiting_for_qa"] == 0
    assert client.get(f"/api/projects/{pid}").json()["state"] == "qa"


def test_a_wrong_class_is_corrected_and_the_frame_is_checked_again(client, ready_for_qa):
    pid, image_id, run = ready_for_qa
    job, gemini = run([wrong_class(1, "plastic"), all_ok])
    result = job["result"]
    assert result["passed"] == 1 and result["rounds"] == {"1": 1}  # passed after one correction
    assert result["class_fixes_applied"] == 1 and gemini.calls == 2

    detail = client.get(f"/api/projects/{pid}/images/{image_id}").json()
    assert detail["image"]["round"] == 1 and detail["image"]["label_status"] == "passed"
    first = detail["label"]["objects"][0]
    assert first["class"] == "plastic" and first["class_source"] == "gemini" and first["model_class_before"] == "glass"
    assert [v["verdict"] for v in detail["verdicts"]] == ["fail", "pass"]
    assert detail["verdicts"][0]["hints"]["class_fixes"] == [{"object_id": "o1", "class": "plastic", "confidence": "high"}]


def test_a_low_confidence_remark_changes_nothing(client, ready_for_qa):
    pid, image_id, run = ready_for_qa
    job, _ = run([wrong_class(1, "plastic", confidence="low")])
    assert job["result"]["passed"] == 1 and job["result"]["class_fixes_applied"] == 0
    assert client.get(f"/api/projects/{pid}/images/{image_id}").json()["label"]["objects"][0]["class"] == "glass"


def test_a_frame_that_keeps_failing_goes_to_a_person_after_two_retries(client, ready_for_qa):
    pid, image_id, run = ready_for_qa
    # Gemini flips the same box back and forth for ever. The loop must still end.
    flip = [wrong_class(1, "plastic"), wrong_class(1, "glass"), wrong_class(1, "plastic"), wrong_class(1, "glass")]
    job, gemini = run(flip)
    result = job["result"]
    assert job["status"] == "succeeded"
    assert (result["passed"], result["human_review"]) == (0, 1)
    assert gemini.calls == 3  # round 0 and exactly max_retries = 2 more, never a fourth
    detail = client.get(f"/api/projects/{pid}/images/{image_id}").json()
    assert detail["image"]["label_status"] == "human_review" and detail["image"]["round"] == 2
    assert len(detail["verdicts"]) == 3

    events = client.get(f"/api/projects/{pid}/events").json()["events"]
    assert events[0]["type"] == "needs_human_review" and "1 of 1 frames" in events[0]["message"]
    queue = client.get(f"/api/projects/{pid}/images", params={"status": "human_review"}).json()["images"]
    assert [i["id"] for i in queue] == [image_id]


@pytest.mark.parametrize(
    "bad_answer",
    [
        ValueError("truncated JSON"),
        lambda numbers: {"objects": [], "missed_objects": 0, "reason": "no boxes judged"},  # boxes missing
        lambda numbers: {**all_ok(numbers), "missed_objects": "several"},  # not a count
        lambda numbers: "not even an object",
    ],
)
def test_an_unusable_answer_is_retried_once_then_a_person_decides(client, ready_for_qa, bad_answer):
    pid, image_id, run = ready_for_qa
    job, gemini = run([bad_answer])
    result = job["result"]
    assert job["status"] == "succeeded"
    assert gemini.calls == 2 and result["invalid_responses"] == 2  # one retry, no more
    assert (result["passed"], result["human_review"]) == (0, 1)
    assert client.get(f"/api/projects/{pid}/images/{image_id}").json()["image"]["label_status"] == "human_review"


def test_when_gemini_refuses_the_call_nothing_is_decided_and_the_job_says_so(client, ready_for_qa):
    from app.gemini import GeminiUnavailable

    pid, image_id, run = ready_for_qa
    job, gemini = run([GeminiUnavailable("Gemini answered 403: Request rejected in accordance with our terms")])
    assert job["status"] == "failed"
    assert "Gemini could not be used, so no frame was checked" in job["error"] and "403" in job["error"]
    detail = client.get(f"/api/projects/{pid}/images/{image_id}").json()
    assert detail["image"]["label_status"] == "predicted"  # NOT sent to a person: nobody judged it
    assert detail["verdicts"] == []
    counts = client.get(f"/api/projects/{pid}").json()
    assert counts["counts"]["human_review"] == 0 and counts["gemini_calls_used"] == 0  # a refused call is not spent
    assert client.get(f"/api/projects/{pid}/events").json()["events"][0]["type"] == "pipeline_failed"


def test_missed_objects_trigger_a_second_look_that_only_adds(client, ready_for_qa):
    pid, image_id, run = ready_for_qa
    job, _ = run([lambda numbers: all_ok(numbers, missed_objects=1), all_ok])
    result = job["result"]
    assert result["objects_added"] == 1 and result["passed"] == 1 and result["rounds"] == {"1": 1}
    objects = client.get(f"/api/projects/{pid}/images/{image_id}").json()["label"]["objects"]
    assert len(objects) == 3  # the two it had, untouched, plus the one the tiled pass found
    assert objects[0]["bbox_xyxy"] == [10, 10, 110, 110] and "added_in_round" not in objects[0]
    assert objects[2]["bbox_xyxy"] == [260, 10, 310, 60] and objects[2]["added_in_round"] == 1


def test_a_second_look_never_adds_more_objects_than_gemini_said_were_missing():
    label = {"round": 0, "objects": [{"id": "o1", "class": "glass", "bbox_xyxy": [0, 0, 50, 50]}]}
    verdict = {"missed_objects": 1, "bad_masks": [], "hints": {"class_fixes": []}}
    found = [
        {"class": "glass", "bbox_xyxy": [100, 100, 150, 150], "score": 0.3},
        {"class": "glass", "bbox_xyxy": [200, 200, 250, 250], "score": 0.8},  # the better one wins
        {"class": "glass", "bbox_xyxy": [300, 300, 350, 350], "score": 0.2},
    ]
    new_label, _, n_added = teacher_qa.corrected(label, verdict, found, added_max_iou=0.3)
    assert n_added == 1 and len(new_label["objects"]) == 2
    assert new_label["objects"][1]["bbox_xyxy"] == [200, 200, 250, 250]


def test_a_bad_box_is_dropped_before_the_next_round(client, ready_for_qa):
    pid, image_id, run = ready_for_qa

    def bad_box(numbers):
        body = all_ok(numbers)
        body["objects"][1].update(box_ok=False)
        return body

    job, _ = run([bad_box, all_ok])
    assert job["result"]["passed"] == 1
    objects = client.get(f"/api/projects/{pid}/images/{image_id}").json()["label"]["objects"]
    assert [o["class"] for o in objects] == ["glass"]


def test_the_project_cap_on_gemini_calls_is_never_passed(client, ready_for_qa):
    pid, image_id, run = ready_for_qa
    limits = load_agents_config()["limits"]
    saved = limits["gemini_max_calls_per_project"]
    try:
        limits["gemini_max_calls_per_project"] = 2  # worst case for one frame is 6
        refused = client.post(f"/api/projects/{pid}/jobs", json={"type": "qa"})
        assert refused.status_code == 409
        assert "6 Gemini calls" in refused.json()["error"]["message"] and "2 left of 2" in refused.json()["error"]["message"]
    finally:
        limits["gemini_max_calls_per_project"] = saved
    assert client.get(f"/api/projects/{pid}").json()["gemini_calls_used"] == 0
    assert client.get(f"/api/projects/{pid}/images/{image_id}").json()["image"]["label_status"] == "predicted"


def test_rule_checks_fail_an_oversized_box_without_asking_gemini():
    image = {"width": 320, "height": 240}
    label = {"objects": [
        {"id": "o1", "class": "glass", "bbox_xyxy": [0, 0, 300, 230], "polygon_xy": [[0, 0], [300, 0], [300, 230]], "source": "model"},
        {"id": "o2", "class": "glass", "bbox_xyxy": [10, 10, 60, 60], "polygon_xy": None, "source": "model"},
        {"id": "o3", "class": "glass", "bbox_xyxy": [70, 70, 120, 120], "polygon_xy": None, "source": "human"},
        {"id": "o4", "class": "glass", "bbox_xyxy": [130, 130, 180, 180], "polygon_xy": [[130, 130], [180, 130], [180, 180]], "source": "model"},
    ]}  # fmt: skip
    thresholds = load_agents_config()["agents"]["teacher_qa"]["thresholds"]
    # o1 covers most of the frame; o2 is a model object with no outline. A box a person drew (o3) is fine.
    assert teacher_qa.cheap_checks(label, image, thresholds) == ["o1", "o2"]


def test_archived_projects_are_not_served_and_the_saving_is_an_estimate(client, labelled):
    from app import deps

    pid, ids = labelled
    saving = client.get(f"/api/projects/{pid}/qa/summary").json()["annotation_saving"]
    # 7 frames, each with two outlined objects from the stand-in model.
    assert saving["machine_outlines"] == 14 and saving["assumed_seconds_per_outline"] == 60 and saving["minutes"] == 14.0
    assert "estimate" in saving["basis"]
    deps.get_store().update(f"projects/{pid}", {"archived": True})
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert client.get(f"/api/projects/{pid}/images").status_code == 404
    assert pid not in [p["id"] for p in client.get("/api/projects").json()["projects"]]
