"""Shared fixtures: an offline app (memory store, local files, jobs run in-request)."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    from app import deps, settings

    monkeypatch.setenv("STORE_BACKEND", "memory")
    monkeypatch.setenv("BLOB_BACKEND", "local")
    monkeypatch.setenv("JOB_RUNNER", "sync")
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("STATIC_DIR", str(tmp_path / "no-frontend"))
    settings.get_settings.cache_clear()
    deps.reset_for_tests()

    from app import worker
    from app.routes import live

    # Uploads in most tests are followed by an explicit pre-label step; the automatic one
    # (agents.yaml annotator_model.auto_after_upload) is switched on by the tests written for it.
    monkeypatch.setattr(worker, "auto_prelabel_enabled", lambda config: False)
    live.reset_for_tests()

    from app.main import create_app

    yield TestClient(create_app())

    settings.get_settings.cache_clear()
    deps.reset_for_tests()


def _texture(rng: np.random.Generator, width: int, height: int) -> np.ndarray:
    """A blocky random image: sharp edges, and different enough frame to frame that the
    perceptual hashes are far apart even after video compression."""
    blocks = rng.integers(0, 256, size=(height // 20, width // 20, 3), dtype=np.uint8)
    return cv2.resize(blocks, (width, height), interpolation=cv2.INTER_NEAREST)


@pytest.fixture
def belt_video(tmp_path) -> Path:
    """12 seconds at 10 fps, 320x240:
    seconds 0-5   a new sharp texture every second          -> kept
    seconds 6-8   the second-5 texture, unchanged           -> duplicates
    seconds 9-10  new textures, heavily blurred             -> blurry
    second  11    a new sharp texture                       -> kept
    """
    width, height, fps = 320, 240, 10
    path = tmp_path / "belt.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    assert writer.isOpened()
    rng = np.random.default_rng(7)
    last = None
    for second in range(12):
        if second <= 5 or second == 11:
            frame = _texture(rng, width, height)
            last = frame if second == 5 else last
        elif second <= 8:
            frame = last
        else:
            frame = cv2.GaussianBlur(_texture(rng, width, height), (0, 0), sigmaX=25)
        for _ in range(fps):
            writer.write(frame)
    writer.release()
    return path


@pytest.fixture
def project(client) -> dict:
    r = client.post(
        "/api/projects",
        json={
            "name": "Mixed belt",
            "classes": ["Glass", "plastic", " metal "],
            "recipe": "circularnet_rfdetr",
            "prelabel_recipe": "circularnet_rfdetr",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def upload_video(client: TestClient, project_id: str, video: Path) -> dict:
    """The browser's three steps: ask for a URL, PUT the file, mark it complete."""
    r = client.post(
        f"/api/projects/{project_id}/uploads",
        json={
            "kind": "video",
            "filename": video.name,
            "content_type": "video/mp4",
            "size_bytes": video.stat().st_size,
        },
    )
    assert r.status_code == 201, r.text
    upload = r.json()
    assert upload["method"] == "PUT"
    put = client.put(upload["upload_url"], content=video.read_bytes(), headers=upload["headers"])
    assert put.status_code == 200, put.text
    done = client.post(f"/api/projects/{project_id}/assets/{upload['asset_id']}/complete")
    assert done.status_code == 202, done.text
    return {"asset_id": upload["asset_id"], "job": done.json()}
