import json
import subprocess
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from chrona.api.app import create_app
from chrona.infrastructure.config import Settings
from chrona.rendering.media import frame_timestamps, probe
from chrona.rendering.trajectory import plan_trajectory, sample_observations


def test_long_route_plan_preserves_endpoints_and_alignment():
    limits = {"fps": 24, "minDuration": 5, "maxDuration": 15, "frameMultiple": 17, "frameOffset": 5}
    with pytest.raises(ValueError, match="at least every 7 frames"):
        plan_trajectory(2400, 1, limits)
    plan = plan_trajectory(2400, 7, limits)
    assert plan["sampledFrames"] == 344
    assert plan["outputFrames"] == 345
    times = [i / 24 for i in range(2400)]
    observations = [{"time": i, "observation": {"tick": i * 60}} for i in range(101)]
    selected = sample_observations(observations, times, 7, plan)
    assert selected[0]["sourceFrame"] == 0
    assert selected[-1]["sourceFrame"] == 2399
    assert selected[-1]["observation"]["tick"] == 6000
    assert selected[-1]["outputTime"] == 343 / 24


def read_frame(path, index):
    return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{index})",
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout


def test_unbounded_upload_and_whole_route_downsampling_use_actual_video_frames(tmp_path):
    source = tmp_path / "route.webm"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24",
        "-t", "5.3", "-c:v", "libvpx-vp9", str(source)], check=True)
    profile = {"label": "Test", "recording": {"fps": 24, "width": 64, "height": 64, "bitsPerSecond": 100000},
        "reference": {"fps": 24, "minDuration": 1, "maxDuration": 2, "frameMultiple": 1, "frameOffset": 0}, "parameters": [{"key": k, "label": k, "type": "number", "default": 64, "min": 64, "max": 64, "step": 1} for k in ['width', 'height']]}
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(profile))
    app = create_app(Settings(data_dir=tmp_path / "data", provider="test_render_service:CopyProvider", video_provider="chrona.adapters.providers.local_reference:LocalReferenceRenderer", profile_path=profile_path))
    with TestClient(app) as client:
        # Upload a metadata file, which does not hit the small multipart text-field limit.
        response = client.post("/api/render/recordings", files={
            "video": ("route.webm", source.read_bytes(), "video/webm"),
            "metadata": ("trajectory.json", json.dumps({"duration": 5.3, "observations": []}), "application/json")})
        assert response.status_code == 201, response.text
        recording = response.json()
        assert recording["frameCount"] == len(frame_timestamps(source))
        body = {"recording_id": recording["id"], "prompt": "Natural materials"}
        full = client.post("/api/render/jobs", json=body)
        assert full.status_code == 202, full.text
        assert len(full.json()['segments']) > 1, 'Long takes must split without forcing downsampling'
        response = client.post("/api/render/jobs", json={**body, "frame_stride": 3})
        assert response.status_code == 202, response.text
        identifier = response.json()["id"]
        for _ in range(800):
            job = client.get(f"/api/render/jobs/{identifier}").json()
            if job["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.05)
        assert job["status"] == "succeeded", job
        plan = job["plan"]
        reference = tmp_path / "data" / "routes" / identifier / "sampled.mp4"
        assert probe(reference, count_frames=True)["frameCount"] == plan["outputFrames"]
        a, b = read_frame(source, recording["frameCount"] - 1), read_frame(reference, plan["outputFrames"] - 1)
        assert len(a) == len(b) == 64 * 64 * 3
        assert sum(abs(x - y) for x, y in zip(a, b)) / len(a) < 9, "The final viewpoint must survive downsampling"
        saved = json.loads((reference.parent / "trajectory.json").read_text())
        assert saved["plan"] == plan
        assert client.get(job["videoUrl"]).status_code == 200
        for _ in range(800):
            full_job = client.get(f"/api/render/jobs/{full.json()['id']}").json()
            if full_job['status'] in ('succeeded', 'failed'): break
            time.sleep(0.05)
        assert full_job['status'] == 'succeeded', full_job
        assert full_job['result']['frameCount'] == recording['frameCount']
