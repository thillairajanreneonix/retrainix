"""Agent 5 - data intake (agents.yaml: data_intake; plan.md A1.2).

Video in, frames out: sample at a fixed interval, drop near-duplicates by perceptual
hash, drop the blurriest frames, store the rest at original resolution. One capture
session per video, so later splits can be made by session and never by adjacent frames.
"""
from __future__ import annotations

import math
import statistics
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from . import orchestrator

if TYPE_CHECKING:
    from app.worker import JobContext


def blur_score(gray: np.ndarray) -> float:
    """Variance of the Laplacian: higher is sharper."""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def phash(gray: np.ndarray) -> int:
    """64-bit perceptual hash (DCT of a 32x32 thumbnail, low 8x8 block, median split)."""
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    low = cv2.dct(small)[:8, :8].flatten()
    bits = low > np.median(low[1:])  # ignore the DC term when picking the threshold
    return int("".join("1" if b else "0" for b in bits), 2)


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def sampling_step(fps: float, total_frames: int, every_seconds: float, max_frames: int) -> int:
    """Frames to advance between samples: the configured interval, widened if the video is
    long enough that it would otherwise yield more than max_frames."""
    step = max(1, round(fps * every_seconds))
    if total_frames > 0 and math.ceil(total_frames / step) > max_frames:
        step = math.ceil(total_frames / max_frames)
    return step


def reliable_timing(fps: float, total_frames: int) -> bool:
    """Can frames be counted to tell time? True for ordinary files. A recording made in a
    browser usually has no frame count and reports a frame rate that is really its clock
    resolution (1000 "fps"), so counting frames would sample it wrongly."""
    return 0 < fps <= 240 and total_frames > 0


class TimestampSampler:
    """Picks one frame per interval from each frame's own timestamp."""

    def __init__(self, every_seconds: float, assumed_fps: float = 30.0) -> None:
        self.every_ms = every_seconds * 1000.0
        self.assumed_ms = 1000.0 / assumed_fps
        self.next_ms = 0.0
        self.last_ms = 0.0

    def time_ms(self, index: int, reported_ms: float) -> float:
        """The frame's time. Some files report no timestamps at all (always 0); those are
        read as if they ran at the assumed rate, which is said in the job result."""
        self.last_ms = reported_ms if reported_ms > 0 or index == 0 else index * self.assumed_ms
        return self.last_ms

    def take(self, ms: float) -> bool:
        if ms + 1e-6 < self.next_ms:
            return False
        while self.next_ms <= ms + 1e-6:
            self.next_ms += self.every_ms
        return True


def extract_frames_job(ctx: JobContext) -> dict[str, Any]:
    store, pid = ctx.store, ctx.project_id
    cfg = ctx.config["agents"]["data_intake"]["video"]
    max_images = int(ctx.config["limits"]["max_images_per_project"])

    asset_id = ctx.job["params"]["asset_id"]
    asset_path = f"projects/{pid}/assets/{asset_id}"
    asset = store.get(asset_path)
    if asset is None:
        raise LookupError(f"asset {asset_id} does not exist")
    project = store.get(f"projects/{pid}")
    room = max_images - int(project["counts"].get("frames", 0))

    store.update(asset_path, {"status": "processing"})
    try:
        result = _extract(ctx, asset, cfg, room)
    except Exception:
        store.update(asset_path, {"status": "failed"})
        raise

    store.update(
        asset_path,
        {
            "status": "ready",
            "frames_extracted": result["frames_extracted"],
            "frames_kept": result["frames_kept"],
        },
    )
    if result["frames_kept"]:
        store.increment(f"projects/{pid}", {"counts.frames": result["frames_kept"]})
        orchestrator.advance(store, ctx.config, pid, "data_uploaded")
    return result


def _extract(
    ctx: JobContext, asset: dict[str, Any], cfg: dict[str, Any], room: int
) -> dict[str, Any]:
    store, blobs, pid = ctx.store, ctx.blobs, ctx.project_id
    asset_id = asset["id"]

    with tempfile.TemporaryDirectory(prefix="retrainix-") as tmp:
        video_path = Path(tmp) / ("video" + Path(asset["filename"]).suffix.lower())
        blobs.download_to(asset["key"], video_path)

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"{asset['filename']} could not be opened as a video")
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        every = float(cfg["sample_every_seconds"])
        max_frames = int(cfg["max_frames_per_video"])
        by_index = reliable_timing(fps, total)
        step = sampling_step(fps, total, every, max_frames) if by_index else 0
        expected = math.ceil(total / step) if by_index else 0
        sampler = TimestampSampler(every)

        # Pass 1: read sequentially (seeking is unreliable in some codecs), score every
        # sampled frame and park it on disk as JPEG. Memory stays flat.
        samples: list[dict[str, Any]] = []
        index = 0
        seconds = 0.0
        stopped_at_max = False
        while True:
            if not cap.grab():
                break
            if by_index:
                seconds = index / fps
                wanted = index % step == 0
            else:
                seconds = sampler.time_ms(index, cap.get(cv2.CAP_PROP_POS_MSEC)) / 1000.0
                wanted = sampler.take(seconds * 1000.0)
                if wanted and len(samples) >= max_frames:
                    stopped_at_max = True  # longer than the cap covers, and its length is unknown up front
                    break
            if wanted:
                ok, frame = cap.retrieve()
                if ok and frame is not None:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    jpg = Path(tmp) / f"{index:06d}.jpg"
                    cv2.imwrite(str(jpg), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
                    samples.append(
                        {
                            "index": index,
                            "seconds": seconds,
                            "path": jpg,
                            "width": int(frame.shape[1]),
                            "height": int(frame.shape[0]),
                            "blur": blur_score(gray),
                            "phash": phash(gray),
                        }
                    )
                    if len(samples) % 10 == 0:
                        ctx.progress(len(samples), max(expected, len(samples)) * 2)
            index += 1
        cap.release()

        if not samples:
            raise ValueError(f"no frames could be read from {asset['filename']}")

        # Blur is judged against this video's own median, not an absolute number: a dark
        # belt has a low Laplacian variance even when it is perfectly sharp.
        median_blur = statistics.median(s["blur"] for s in samples)
        blur_floor = median_blur * float(cfg["min_blur_ratio"])
        max_distance = int(cfg["phash_max_distance"])

        kept: list[dict[str, Any]] = []
        dropped_blurry = dropped_duplicate = dropped_over_limit = 0
        for sample in samples:
            if sample["blur"] < blur_floor:
                dropped_blurry += 1
            elif any(hamming(sample["phash"], k["phash"]) <= max_distance for k in kept):
                dropped_duplicate += 1
            elif len(kept) >= room:
                dropped_over_limit += 1
            else:
                kept.append(sample)

        # Pass 2: store what survived.
        docs: list[tuple[str, dict[str, Any]]] = []
        for n, sample in enumerate(kept, start=1):
            image_id = f"f_{asset_id}_{sample['index']:06d}"
            key = f"projects/{pid}/frames/{image_id}.jpg"
            blobs.write_bytes(key, sample["path"].read_bytes(), "image/jpeg")
            docs.append(
                (
                    f"projects/{pid}/images/{image_id}",
                    {
                        "project_id": pid,
                        "gcs_uri": blobs.uri(key),
                        "key": key,
                        "width": sample["width"],
                        "height": sample["height"],
                        "asset_id": asset_id,
                        "session_id": asset["session_id"],
                        "role": "unlabelled",
                        "phash": f"{sample['phash']:016x}",
                        "blur_score": round(sample["blur"], 1),
                        "label_status": "none",
                        "round": 0,
                        "label_uri": None,
                        "object_count": 0,
                        "timestamp_s": round(sample["seconds"], 2),
                    },
                )
            )
            if n % 10 == 0:
                ctx.progress(len(samples) + n, len(samples) + len(kept))
        store.set_many(docs)
        ctx.progress(len(samples) + len(kept), len(samples) + len(kept))

    return {
        "frames_extracted": len(samples),
        "frames_kept": len(kept),
        "dropped_duplicate": dropped_duplicate,
        "dropped_blurry": dropped_blurry,
        "dropped_over_limit": dropped_over_limit,
        "video_seconds": round(index / fps, 1) if by_index else round(seconds, 1),
        "sample_every_seconds": round(step / fps, 2) if by_index else every,
        "timing": "frame_index" if by_index else "timestamps",
        "stopped_at_max_frames": stopped_at_max,
        "median_blur_score": round(median_blur, 1),
        "blur_floor": round(blur_floor, 1),
    }
