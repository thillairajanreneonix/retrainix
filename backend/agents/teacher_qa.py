"""Agent 8 - teacher / QA (agents.yaml: teacher_qa; plan.md section 5 and Amendment A1).

Step B of the teacher loop, per frame:

    cheap rule checks  ->  Gemini reviews the labels  ->  pass, or correct and review again

A frame gets at most `max_retries` corrections, then goes to a person. The loop is a
`for` over rounds, so it ends whatever Gemini answers. Gemini never judges outlines on its
own word: it flags classes, missing objects and bad boxes, and the decision to pass is
made here from those flags against the project's thresholds.

Every verdict is stored with the judge model, the prompt version, the round and the model
that made the label.
"""
from __future__ import annotations

import logging
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from . import annotator, labels, notifier, orchestrator

if TYPE_CHECKING:
    from app.worker import JobContext

logger = logging.getLogger(__name__)

PROMPT_VERSION = "qa-v2"
CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "objects": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "number": {"type": "INTEGER"},
                    "class_ok": {"type": "BOOLEAN"},
                    "correct_class": {"type": "STRING"},
                    "box_ok": {"type": "BOOLEAN"},
                    "confidence": {"type": "STRING", "enum": ["high", "medium", "low"]},
                },
                "required": ["number", "class_ok", "correct_class", "box_ok", "confidence"],
            },
        },
        "missed_objects": {"type": "INTEGER"},
        "reason": {"type": "STRING"},
    },
    "required": ["objects", "missed_objects", "reason"],
}


# --- what Gemini is shown ------------------------------------------------------------
def render_numbered(image_bgr: np.ndarray, objects: list[dict[str, Any]]) -> bytes:
    """The frame with each label drawn as a yellow box carrying its number (1-based)."""
    canvas = image_bgr.copy()
    for n, obj in enumerate(objects, start=1):
        x0, y0, x1, y1 = (int(v) for v in obj["bbox_xyxy"])
        cv2.rectangle(canvas, (x0, y0), (x1, y1), (0, 255, 255), 2)
        tag_w = 12 + 10 * len(str(n))
        cv2.rectangle(canvas, (x0, max(0, y0 - 18)), (x0 + tag_w, max(18, y0)), (0, 255, 255), -1)
        cv2.putText(canvas, str(n), (x0 + 3, max(14, y0 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 2)
    return cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes()


def render_example(image_bgr: np.ndarray, objects: list[dict[str, Any]]) -> bytes:
    """A gold exemplar with every box carrying its class name: what correct looks like."""
    canvas = image_bgr.copy()
    for obj in objects:
        x0, y0, x1, y1 = (int(v) for v in obj["bbox_xyxy"])
        cv2.rectangle(canvas, (x0, y0), (x1, y1), (80, 220, 80), 2)
        cv2.putText(canvas, obj["class"], (x0 + 2, max(14, y0 - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 220, 80), 2)
    return cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


def build_parts(
    classes: list[str], numbered_jpeg: bytes, objects: list[dict[str, Any]], examples: list[bytes]
) -> list[dict[str, Any]]:
    listing = ", ".join(f"{n}: {o['class']}" for n, o in enumerate(objects, start=1)) or "(no boxes)"
    parts: list[dict[str, Any]] = [
        {
            "text": (
                "You are checking machine-made labels on photos of a recycling conveyor belt seen "
                f"from above. The only allowed classes are: {', '.join(classes)}."
            )
        }
    ]
    if examples:
        parts.append(
            {
                "text": (
                    f"First, {len(examples)} reference photo(s) from the same belt that a person has "
                    "labelled correctly. Each green box carries the correct class name. Use them to "
                    "learn what each class looks like here."
                )
            }
        )
        parts.extend({"jpeg": e} for e in examples)
    parts.append({"text": "Now the photo to check. Each yellow box has a number."})
    parts.append({"jpeg": numbered_jpeg})
    parts.append(
        {
            "text": (
                f"Proposed class for each numbered box: {listing}.\n"
                "For every numbered box report: whether the proposed class is right (class_ok); the "
                "right class from the allowed list, or 'unknown' if it cannot be told from the photo "
                "(correct_class - repeat the proposed class when it is right); whether the box "
                "sits on one object (box_ok - false only when it covers no object at all, covers "
                "several separate objects, or misses most of its object; a slightly loose box is "
                "fine, and so is an object that the edge of the photo cuts off); and how sure you "
                "are. Then count the clearly visible objects lying on the belt that have NO box "
                "(missed_objects). Ignore the belt itself, its texture and scratches, its edges, "
                "shadows and reflections. Judge only what is visible; do not guess."
            )
        }
    )
    return parts


# --- the decision, made here ----------------------------------------------------------
def cheap_checks(label: dict[str, Any], image: dict[str, Any], thresholds: dict[str, Any]) -> list[str]:
    """Ids of objects that fail a rule no model is needed for: a box covering most of the
    frame, or a model object with no outline at all (an empty mask)."""
    frame_area = float(image["width"] * image["height"])
    max_ratio = float(thresholds["max_object_area_ratio"])
    bad = []
    for obj in label["objects"]:
        x0, y0, x1, y1 = obj["bbox_xyxy"]
        huge = (x1 - x0) * (y1 - y0) > max_ratio * frame_area
        empty_mask = obj["source"] == "model" and obj.get("polygon_xy") is None
        if huge or empty_mask:
            bad.append(obj["id"])
    return bad


def judge(
    answer: dict[str, Any], label: dict[str, Any], classes: list[str], thresholds: dict[str, Any]
) -> dict[str, Any]:
    """Turn Gemini's per-box answer into a verdict. Raises ValueError when the answer does
    not cover the boxes it was asked about - that counts as an invalid response."""
    objects = label["objects"]
    by_number = {}
    for item in answer.get("objects", []):
        if not isinstance(item, dict) or not isinstance(item.get("number"), int):
            raise ValueError("an object entry has no number")
        by_number[item["number"]] = item
    missing = [n for n in range(1, len(objects) + 1) if n not in by_number]
    if missing:
        raise ValueError(f"no answer for box(es) {missing[:5]}")
    missed = answer.get("missed_objects")
    if not isinstance(missed, int) or missed < 0:
        raise ValueError("missed_objects is not a count")

    min_rank = CONFIDENCE_RANK[thresholds["min_fix_confidence"]]
    class_fixes, bad_masks = [], []
    for n, obj in enumerate(objects, start=1):
        item = by_number[n]
        sure = CONFIDENCE_RANK.get(item.get("confidence"), 0) >= min_rank
        if not sure:
            continue  # a low-confidence remark changes nothing
        if item.get("box_ok") is False:
            bad_masks.append(obj["id"])
        elif item.get("class_ok") is False:
            correct = str(item.get("correct_class", "")).strip().lower()
            if correct in classes and correct != obj["class"]:
                class_fixes.append({"object_id": obj["id"], "class": correct, "confidence": item["confidence"]})
            elif correct not in classes:
                bad_masks.append(obj["id"])  # "unknown": not one of the project's classes

    too_many_missed = missed > int(thresholds["max_missed_objects"])
    passed = not class_fixes and not bad_masks and not too_many_missed
    return {
        "verdict": "pass" if passed else "fail",
        "class_ok": not class_fixes,
        "missed_objects": missed,
        "bad_masks": bad_masks,
        "hints": {
            "class_fixes": class_fixes,
            "retry_profile": "tiled_lowconf" if too_many_missed else None,
            "note": "",
        },
        "reason": str(answer.get("reason", ""))[:600],
    }


def corrected(
    label: dict[str, Any], verdict: dict[str, Any], extra: list[dict[str, Any]], added_max_iou: float
) -> tuple[dict[str, Any], int, int]:
    """The next round of a failed label: flagged objects dropped, class fixes applied, and
    any objects from a second prediction that do not overlap what is already there added.
    Returns the label, the number of class fixes and the number of objects added."""
    fixes = {f["object_id"]: f["class"] for f in verdict["hints"]["class_fixes"]}
    drop = set(verdict["bad_masks"])
    next_no = int(label["round"]) + 1
    kept, n_fixed = [], 0
    for obj in label["objects"]:
        if obj["id"] in drop:
            continue
        obj = dict(obj)
        if obj["id"] in fixes:
            obj["model_class_before"] = obj.get("model_class_before", obj["class"])
            obj["class"] = fixes[obj["id"]]
            obj["class_source"] = "gemini"
            n_fixed += 1
        kept.append(obj)
    # Add at most as many objects as Gemini said were missing, best score first. Without the
    # cap the wider prediction also brings in belt marks (measured 20 Nov: 216 additions on
    # 26 frames, many of them flagged as false in the next round).
    n_added = 0
    for obj in sorted(extra, key=lambda o: o.get("score") or 0, reverse=True):
        if n_added >= int(verdict["missed_objects"]):
            break
        if all(annotator.box_iou(tuple(obj["bbox_xyxy"]), tuple(k["bbox_xyxy"])) <= added_max_iou for k in kept):
            kept.append({**obj, "round": next_no, "added_in_round": next_no})
            n_added += 1
    return labels.next_round(label, kept), n_fixed, n_added


# --- the job --------------------------------------------------------------------------
def make_reviewer(ctx: JobContext) -> tuple[Any, str]:
    """(callable(parts, schema) -> dict, judge model id). A separate function so tests can
    put a scripted reviewer in its place."""
    from app.gemini import GeminiClient  # noqa: PLC0415

    client = GeminiClient()
    return client.generate_json, client.model


def waiting_images(ctx: JobContext) -> list[dict[str, Any]]:
    images = ctx.store.list(f"projects/{ctx.project_id}/images", where={"label_status": "predicted"})
    return [i for i in images if i.get("role", "unlabelled") == "unlabelled"]


def qa_job(ctx: JobContext) -> dict[str, Any]:
    from app.store import now_iso  # noqa: PLC0415

    store, blobs, pid = ctx.store, ctx.blobs, ctx.project_id
    cfg = ctx.config["agents"]["teacher_qa"]
    thresholds = cfg["thresholds"]
    max_retries = int(thresholds["max_retries"])
    cap = int(ctx.config["limits"]["gemini_max_calls_per_project"])
    project = store.get(f"projects/{pid}")
    classes = project["classes"]
    images = waiting_images(ctx)
    remaining = cap - int(project.get("gemini_calls_used", 0))

    if ctx.job["dry_run"]:
        return {
            "estimate": {
                "images": len(images),
                # Worst case: every frame fails every round, and every answer needs its one retry.
                "gemini_calls": len(images) * (max_retries + 1) * 2,
                "gpu_minutes": 0,
                "gemini_calls_remaining": max(0, remaining),
            }
        }
    if not images:
        raise ValueError("there are no pre-labelled frames waiting for the check")

    review, judge_model = make_reviewer(ctx)
    started = time.time()
    from app.gemini import GeminiUnavailable  # noqa: PLC0415

    calls: dict[str, Any] = {"used": 0, "invalid": 0, "last_error": None, "down": None}
    lock = threading.Lock()

    def take_call() -> bool:
        with lock:
            if calls["used"] >= remaining:
                return False
            calls["used"] += 1
            return True

    # Reference examples: gold exemplars with their correct class names drawn on.
    examples: list[bytes] = []
    exemplars = store.list(f"projects/{pid}/images", where={"role": "gold_exemplar"})
    for image in exemplars[: int(thresholds["gold_examples_in_prompt"])]:
        frame = cv2.imdecode(np.frombuffer(blobs.read_bytes(image["key"]), np.uint8), cv2.IMREAD_COLOR)
        examples.append(render_example(frame, labels.read_label(blobs, image)["objects"]))

    def verdict_doc(image: dict[str, Any], label: dict[str, Any], stage: str, body: dict[str, Any]) -> None:
        verdict_id = f"v_{image['id']}_r{label['round']}_{stage}_{int(time.time() * 1000)}"
        store.set(
            f"projects/{pid}/verdicts/{verdict_id}",
            {
                "image_id": image["id"],
                "round": label["round"],
                "stage": stage,
                **body,
                "judge_model": judge_model if stage == "gemini" else "rules",
                "prompt_version": PROMPT_VERSION,
                "label_model": label.get("label_model"),
                "created_at": now_iso(),
            },
        )

    def ask_gemini(image: dict[str, Any], label: dict[str, Any]) -> dict[str, Any] | str:
        """A verdict, or "invalid" / "cap" / "unavailable" when no verdict could be had."""
        if calls["down"]:
            return "unavailable"  # Gemini already refused in this run: do not keep knocking
        frame = cv2.imdecode(np.frombuffer(blobs.read_bytes(image["key"]), np.uint8), cv2.IMREAD_COLOR)
        parts = build_parts(classes, render_numbered(frame, label["objects"]), label["objects"], examples)
        for _attempt in range(2):  # invalid JSON -> one retry -> human review
            if not take_call():
                return "cap"
            asked = time.time()
            try:
                verdict = judge(review(parts, RESPONSE_SCHEMA), label, classes, thresholds)
                logger.info("gemini %s r%s %s in %.0fs", image["id"], label["round"], verdict["verdict"], time.time() - asked)
                return verdict
            except GeminiUnavailable as exc:
                # The call failed; that says nothing about the label. Measured 20 Nov: after
                # ~250 image requests in a few hours Vertex AI refused every call with 403
                # "Request rejected in accordance with our terms of use and policies", and the
                # run of that moment sent 23 frames to a person for no reason. Never again.
                logger.error("gemini unavailable for %s r%s: %s", image["id"], label["round"], exc)
                with lock:
                    calls["used"] -= 1  # the call produced nothing; it does not count against the cap
                    calls["down"] = str(exc)
                return "unavailable"
            except Exception as exc:  # an unusable answer, whatever the cause
                logger.warning("gemini %s r%s unusable after %.0fs: %s", image["id"], label["round"], time.time() - asked, exc)
                with lock:
                    calls["invalid"] += 1
                    calls["last_error"] = f"{type(exc).__name__}: {exc}"[:300]
        return "invalid"

    model_box: dict[str, Any] = {}
    tmp = tempfile.TemporaryDirectory(prefix="retrainix-model-")

    def second_look(image: dict[str, Any], label: dict[str, Any], profile_name: str) -> list[dict[str, Any]]:
        """Objects a wider prediction finds; used only when Gemini reports missed objects."""
        if "model" not in model_box:
            model_box["model"], _, model_box["class_map"] = annotator.active_model(ctx, project, Path(tmp.name))
        acfg = ctx.config["agents"]["annotator_model"]
        frame = cv2.imdecode(np.frombuffer(blobs.read_bytes(image["key"]), np.uint8), cv2.IMREAD_COLOR)
        detections = annotator.one_label_per_object(
            model_box["model"].predict(frame, acfg["profiles"][profile_name]), float(acfg["cross_class_nms_iou"])
        )
        label_model = {**(label.get("label_model") or {}), "profile": profile_name}
        found, _ = annotator.to_master_label(
            image, detections, model_box["class_map"], label_model, float(thresholds["min_mask_area_px"])
        )
        return found["objects"]

    result = {
        "images": len(images), "passed": 0, "human_review": 0, "rounds": {},
        "gemini_calls": 0, "invalid_responses": 0, "cheap_check_failures": 0,
        "class_fixes_applied": 0, "objects_added": 0, "stopped_at_cap": False,
        "judge_model": judge_model, "prompt_version": PROMPT_VERSION,
    }  # fmt: skip
    pending = [(image, labels.read_label(blobs, image)) for image in images]
    finished = 0

    def finish(image: dict[str, Any], status: str) -> None:
        nonlocal finished
        labels.set_status(store, pid, image, status)
        result[status] += 1
        finished += 1
        ctx.progress(finished, len(images))

    try:
        for attempt in range(max_retries + 1):  # bounded: the loop always ends
            if not pending or calls["down"]:
                break
            last = attempt == max_retries
            verdicts: list[tuple[dict[str, Any], dict[str, Any], Any]] = []

            # 1. Rules first: no Gemini call is spent on a label a rule can fail.
            to_gemini = []
            for image, label in pending:
                bad = cheap_checks(label, image, thresholds)
                if bad:
                    result["cheap_check_failures"] += 1
                    verdict = {
                        "verdict": "fail", "class_ok": True, "missed_objects": 0, "bad_masks": bad,
                        "hints": {"class_fixes": [], "retry_profile": None, "note": "dropped by rule"},
                        "reason": f"{len(bad)} object(s) failed a rule check (oversized box or empty outline).",
                    }  # fmt: skip
                    verdict_doc(image, label, "cheap_check", verdict)
                    verdicts.append((image, label, verdict))
                else:
                    to_gemini.append((image, label))

            # 2. Gemini, in parallel - one call takes around 20 seconds.
            with ThreadPoolExecutor(max_workers=int(thresholds["gemini_parallel"])) as pool:
                answers = list(pool.map(lambda pair: ask_gemini(*pair), to_gemini))
            for (image, label), answer in zip(to_gemini, answers, strict=True):
                if isinstance(answer, dict):
                    verdict_doc(image, label, "gemini", answer)
                verdicts.append((image, label, answer))

            # 3. Pass, correct for another round, or hand to a person.
            pending = []
            for image, label, verdict in verdicts:
                if verdict == "cap":
                    result["stopped_at_cap"] = True
                    continue  # left as "predicted": it has not been checked
                if verdict == "unavailable":
                    continue  # left as "predicted": Gemini did not judge it
                if verdict == "invalid":
                    finish(image, "human_review")
                    continue
                if verdict["verdict"] == "pass":
                    result["rounds"][str(attempt)] = result["rounds"].get(str(attempt), 0) + 1
                    finish(image, "passed")
                    continue
                if last:
                    finish(image, "human_review")
                    continue
                profile = verdict["hints"]["retry_profile"]
                extra = second_look(image, label, profile) if profile else []
                new_label, n_fixed, n_added = corrected(
                    label, verdict, extra, float(thresholds["added_object_max_iou"])
                )
                result["class_fixes_applied"] += n_fixed
                result["objects_added"] += n_added
                labels.write_round(store, blobs, pid, image, new_label, "predicted")
                pending.append((image, new_label))
    finally:
        tmp.cleanup()
        if calls["used"]:
            store.increment(f"projects/{pid}", {"gemini_calls_used": calls["used"]})

    result["gemini_calls"] = calls["used"]
    result["gemini_unavailable"] = calls["down"]
    if calls["down"] and not (result["passed"] or result["human_review"]):
        raise RuntimeError(f"Gemini could not be used, so no frame was checked: {calls['down']}")
    result["invalid_responses"] = calls["invalid"]
    result["last_invalid_reason"] = calls["last_error"]
    result["seconds"] = round(time.time() - started, 1)
    orchestrator.advance(store, ctx.config, pid, "qa")
    if result["human_review"]:
        notifier.emit(
            store, pid, "needs_human_review",
            f"{result['human_review']} of {result['images']} frames need a person to check them.",
            job_id=ctx.job["id"],
        )  # fmt: skip
    return result
