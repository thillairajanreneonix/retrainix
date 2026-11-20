"""Video intake end to end (plan.md A1.2; agents.yaml data_intake)."""
import cv2
import numpy as np

from agents import data_intake
from tests.conftest import upload_video


def test_sampling_step_follows_the_interval_and_the_frame_cap():
    step = data_intake.sampling_step
    assert step(fps=30, total_frames=3000, every_seconds=1, max_frames=300) == 30
    # 10 minutes at 30 fps would give 600 samples; widened so it yields at most 300.
    wide = step(fps=30, total_frames=18000, every_seconds=1, max_frames=300)
    assert wide == 60 and 18000 / wide <= 300
    assert step(fps=0.5, total_frames=10, every_seconds=1, max_frames=300) == 1


def test_browser_recordings_are_sampled_by_timestamp_not_by_frame_count():
    # An ordinary file: a sane frame rate and a frame count.
    assert data_intake.reliable_timing(25.7, 870) is True
    # What a browser recording reports: its clock resolution as "fps", and no frame count.
    assert data_intake.reliable_timing(1000.0, 0) is False
    assert data_intake.reliable_timing(1000.0, -9223372036854775808) is False
    assert data_intake.reliable_timing(0.0, 300) is False

    sampler = data_intake.TimestampSampler(every_seconds=1.0)
    # 4 seconds of frames 33 ms apart, with a 400 ms gap in the middle (a dropped stretch).
    times = [i * 33.0 for i in range(60)] + [2380.0 + i * 33.0 for i in range(50)]
    taken = [ms for i, ms in enumerate(times) if sampler.take(sampler.time_ms(i, ms))]
    # Just under 4 seconds of footage: one frame for each second that began.
    assert taken == [0.0, 1023.0, 2380.0, 3007.0]

    # A file that reports no timestamps at all is read as 30 frames a second.
    blind = data_intake.TimestampSampler(every_seconds=1.0)
    taken = [i for i in range(90) if blind.take(blind.time_ms(i, 0.0))]
    assert taken == [0, 30, 60]


def test_an_upload_remembers_whether_it_came_from_a_camera(client, project, belt_video):
    pid = project["id"]
    body = {"kind": "video", "filename": "camera-20261120-204500.webm", "content_type": "video/webm",
            "size_bytes": belt_video.stat().st_size, "source": "camera"}  # fmt: skip
    upload = client.post(f"/api/projects/{pid}/uploads", json=body).json()
    client.put(upload["upload_url"], content=belt_video.read_bytes(), headers=upload["headers"])
    job = client.post(f"/api/projects/{pid}/assets/{upload['asset_id']}/complete").json()
    assert job["status"] == "succeeded", job["error"]  # the container is read by content, not by its name
    assert job["result"]["timing"] == "frame_index" and job["result"]["stopped_at_max_frames"] is False
    asset = client.get(f"/api/projects/{pid}/assets").json()["assets"][0]
    assert asset["source"] == "camera" and asset["filename"].endswith(".webm")
    assert client.post(f"/api/projects/{pid}/uploads", json={**body, "source": "phone"}).status_code == 422


def test_phash_separates_different_frames_and_blur_score_ranks_sharpness():
    rng = np.random.default_rng(1)
    a = cv2.resize(rng.integers(0, 256, (12, 16), dtype=np.uint8), (320, 240),
                   interpolation=cv2.INTER_NEAREST)  # fmt: skip
    b = cv2.resize(rng.integers(0, 256, (12, 16), dtype=np.uint8), (320, 240),
                   interpolation=cv2.INTER_NEAREST)  # fmt: skip
    assert data_intake.hamming(data_intake.phash(a), data_intake.phash(a)) == 0
    assert data_intake.hamming(data_intake.phash(a), data_intake.phash(b)) > 10
    assert data_intake.blur_score(a) > 10 * data_intake.blur_score(cv2.GaussianBlur(a, (0, 0), 25))


def test_video_upload_becomes_deduplicated_sharp_frames(client, project, belt_video):
    pid = project["id"]
    up = upload_video(client, pid, belt_video)

    job = client.get(f"/api/projects/{pid}/jobs/{up['job']['id']}").json()
    assert job["type"] == "extract_frames"
    assert job["status"] == "succeeded", job["error"]
    result = job["result"]
    # 12 one-second samples: 7 distinct sharp, 3 unchanged, 2 blurred (see the fixture).
    assert result["frames_extracted"] == 12
    assert result["dropped_duplicate"] == 3
    assert result["dropped_blurry"] == 2
    assert result["frames_kept"] == 7
    assert (
        result["frames_kept"] + result["dropped_duplicate"] + result["dropped_blurry"]
        + result["dropped_over_limit"] == result["frames_extracted"]
    )  # every sampled frame is accounted for
    assert job["progress"]["done"] == job["progress"]["total"] > 0

    asset = client.get(f"/api/projects/{pid}/assets").json()["assets"][0]
    assert asset["status"] == "ready" and asset["frames_kept"] == 7
    assert asset["job_id"] == job["id"]

    project_now = client.get(f"/api/projects/{pid}").json()
    assert project_now["counts"]["frames"] == 7
    assert project_now["state"] == "data_uploaded"


def test_frames_are_listed_in_pages_and_served_at_original_and_reduced_size(
    client, project, belt_video
):
    pid = project["id"]
    asset_id = upload_video(client, pid, belt_video)["asset_id"]

    first = client.get(f"/api/projects/{pid}/images", params={"limit": 5}).json()
    assert len(first["images"]) == 5 and first["next_cursor"]
    rest = client.get(
        f"/api/projects/{pid}/images", params={"limit": 5, "cursor": first["next_cursor"]}
    ).json()
    assert len(rest["images"]) == 2 and rest["next_cursor"] is None
    ids = [i["id"] for i in first["images"] + rest["images"]]
    assert ids == sorted(ids) and len(set(ids)) == 7

    image = first["images"][0]
    assert image["role"] == "unlabelled" and image["label_status"] == "none"
    assert image["session_id"] == asset_id  # one capture session per video
    assert (image["width"], image["height"]) == (320, 240)

    def decoded_width(response):
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/jpeg"
        return cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR).shape[1]

    url = f"/api/projects/{pid}/images/{image['id']}/file"
    assert decoded_width(client.get(url)) == 320  # the original is never resized in storage
    assert decoded_width(client.get(url, params={"w": 160})) == 160
    assert decoded_width(client.get(url, params={"w": 1000})) == 320  # never upscaled

    detail = client.get(f"/api/projects/{pid}/images/{image['id']}").json()
    assert detail["image"]["id"] == image["id"] and detail["label"] is None
    passed = client.get(f"/api/projects/{pid}/images", params={"status": "passed"}).json()
    assert passed["images"] == []


def test_upload_rules(client, project, belt_video, tmp_path):
    pid = project["id"]
    start = {"kind": "video", "filename": "belt.mp4", "content_type": "video/mp4", "size_bytes": 10}

    too_big = client.post(f"/api/projects/{pid}/uploads", json={**start, "size_bytes": 2 * 1024**3})
    assert too_big.status_code == 413
    wrong_type = client.post(
        f"/api/projects/{pid}/uploads", json={**start, "content_type": "text/plain"}
    )
    assert wrong_type.status_code == 422

    # Completing before the file has arrived is refused, and nothing is started.
    upload = client.post(f"/api/projects/{pid}/uploads", json=start).json()
    early = client.post(f"/api/projects/{pid}/assets/{upload['asset_id']}/complete")
    assert early.status_code == 409
    assert client.get(f"/api/projects/{pid}/jobs").json()["jobs"] == []

    # A file path cannot escape its upload folder.
    sneaky = client.post(
        f"/api/projects/{pid}/uploads", json={**start, "filename": "../../etc/passwd.mp4"}
    ).json()
    assert ".." not in sneaky["upload_url"]

    # Completing twice starts only one job.
    up = upload_video(client, pid, belt_video)
    again = client.post(f"/api/projects/{pid}/assets/{up['asset_id']}/complete")
    assert again.status_code == 409
    assert len(client.get(f"/api/projects/{pid}/jobs").json()["jobs"]) == 1


def test_a_file_that_is_not_a_video_fails_the_job_and_notifies(client, project, tmp_path):
    pid = project["id"]
    fake = tmp_path / "notes.mp4"
    fake.write_bytes(b"this is not a video" * 100)
    up = upload_video(client, pid, fake)

    job = client.get(f"/api/projects/{pid}/jobs/{up['job']['id']}").json()
    assert job["status"] == "failed" and "notes.mp4" in job["error"]
    asset = client.get(f"/api/projects/{pid}/assets").json()["assets"][0]
    assert asset["status"] == "failed"
    assert client.get(f"/api/projects/{pid}").json()["counts"]["frames"] == 0

    events = client.get(f"/api/projects/{pid}/events", params={"unread": True}).json()["events"]
    assert [e["type"] for e in events] == ["pipeline_failed"]
    read = client.post(f"/api/projects/{pid}/events/{events[0]['id']}/read").json()
    assert read["read"] is True
    assert client.get(f"/api/projects/{pid}/events", params={"unread": True}).json()["events"] == []


def test_an_unknown_job_type_is_refused(client, project):
    pid = project["id"]
    assert client.post(f"/api/projects/{pid}/jobs", json={"type": "nonsense"}).status_code == 422
    # extract_frames and evaluate are started by the app itself, never by a user.
    assert client.post(f"/api/projects/{pid}/jobs", json={"type": "evaluate"}).status_code == 422
