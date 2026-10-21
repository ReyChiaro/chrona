import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest
from PIL import Image
from fastapi.testclient import TestClient
from chrona.api.app import create_app
from chrona.infrastructure.config import Settings
from chrona.rendering.continuous.planning import plan_route
from chrona.rendering.continuous.context import SpatialMemory, video_graph, bind_references
from chrona.protocol.media import SceneSnapshot


def test_route_plan_covers_every_sample_once_after_overlap_and_retains_endpoint():
    for frames in [2, 5, 82, 434, 10001]:
        for stride in [1, 4, 500]:
            plan = plan_route(frames, stride, 24, 3.5, 9)
            assert plan["selectedFrames"][0] == 0 and plan["selectedFrames"][-1] == frames - 1
            reconstructed = []
            for s in plan["segments"]:
                assert (s["frames"] - 1) % 4 == 0
                assert s["frames"] >= s["validFrames"]
                reconstructed += plan["selectedFrames"][s["start"] + s["overlapFrames"]:s["end"]]
            assert reconstructed == plan["selectedFrames"]
    with pytest.raises(ValueError): plan_route(100, 1, 24, 0.5, 100)


def context(state="pink", x=0):
    return {"time": 0, "worldId": "world-a", "tick": 10, "worldSeconds": 12, "revision": 1,
        "camera": {"x": x, "y": 2, "z": 0, "yaw": 0, "pitch": 0},
        "objects": [{"id": "tree:1", "kind": "pine", "label": "cherry", "band": "near", "distance": 8,
                     "position": {"x": 0, "y": 0, "z": -8}, "stateHash": state, "bounds": [0.2, 0.2, 0.5, 0.8], "constraint": {"objectId": "tree:1", "text": "pink petals", "referenceIds": []}}]}


def test_context_budget_reference_binding_and_spatial_memory_state_confidence(tmp_path):
    a = context()
    result = video_graph.invoke({"snapshots": [a], "direction": "natural light", "budgets": {"near": 1, "middle": 0, "far": 0}, "memories": []})
    assert "tree:1" not in result["prompt"] and "pink petals" in result["prompt"]
    assert result["shot"]["bindings"][0]["objectId"] == "tree:1"
    assert result["trace"][0]["selected"] == 1
    image = tmp_path / "frame.png"; Image.new("RGB", (100, 100), "green").save(image)
    memory = SpatialMemory(tmp_path / "memory"); memory.save("one", image, a, "style")
    assert memory.retrieve(a, "style")[0]["confidence"] == 1
    assert not memory.retrieve(context("cut-down"), "style")
    assert not memory.retrieve(a, "other-style")
    references = tmp_path / "references"; references.mkdir()
    identifier = "a" * 64; Image.new("RGB", (100, 100), "pink").save(references / f"{identifier}.png")
    a["objects"][0]["constraint"]["referenceIds"] = [identifier]
    bindings = bind_references(image, a, references)
    after = Image.open(image)
    assert bindings[0]["objectId"] == "tree:1"
    assert after.getpixel((0, 0)) == (0, 128, 0)
    assert after.getpixel((30, 30)) != (0, 128, 0)
    with pytest.raises(ValueError): SceneSnapshot.model_validate(a | {"camera": {"x": float('nan')}})
    a['objects'][0]['constraint']['referenceIds'] = ['../../private/image']
    with pytest.raises(ValueError): SceneSnapshot.model_validate(a)


class RouteCopyProvider:
    """Only a test fixture. Segment 2 fails once to verify durable retry/cache behaviour."""
    def __init__(self, settings): self.calls = []; self.failed = False; self.adapter_digest = 'b' * 64
    def capabilities(self):
        return {"enabled": True, "profile": "test", "fps": 24, "minFrames": 5, "maxFrames": 81, "frameMultiple": 4, "frameOffset": 1,
                "parameters": [{"key": k, "label": k, "default": 384, "min": 256, "max": 512, "step": 32} for k in ["width", "height"]],
                "adapters": {"maxActive": 4, "maxScale": 2, "items": [
                    {"id": 'a' * 24, "label": "test.safetensors", "kind": "lora", "sha256": self.adapter_digest}]}}
    def render_segment(self, *, video, image, prompt, parameters, output, progress, **kwargs):
        self.last_adapters = kwargs.get('adapters', [])
        index = int(video.parent.name.split("-")[-1]); self.calls.append(index)
        if index == 1 and not self.failed:
            self.failed = True; raise RuntimeError("intentional test failure")
        shutil.copyfile(video, output); return {"testAdapter": True}


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg integration runs on render host")
def test_route_api_resume_join_rebuild_and_world_cache_isolation(tmp_path):
    world = tmp_path / "worlds"; world.mkdir(); (world / "saved.json").write_text('{"tick":123,"camera":{"x":5}}')
    original = (world / "saved.json").read_bytes()
    settings = Settings(data_dir=tmp_path / "render", video_provider="test_continuous:RouteCopyProvider", preload=False)
    app = create_app(settings)
    source = tmp_path / "source.webm"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=384x384:rate=24", "-t", "5", "-c:v", "libvpx-vp9", str(source)], check=True)
    with TestClient(app) as client:
        upload = client.post("/api/render/recordings", files={"video": ("source.webm", source.read_bytes())}, data={"metadata": json.dumps({"duration": 5, "observations": [], "contextSnapshots": [context()]})})
        assert upload.status_code == 201, upload.text
        body = {"recording_id": upload.json()["id"], "prompt": "realistic trees", "segment_seconds": 3.5, "overlap_frames": 9, "retries": 0,
                "adapters": [{"id": 'a' * 24, "scale": 0.65}]}
        response = client.post("/api/render/jobs", json=body); assert response.status_code == 202, response.text
        identifier = response.json()["id"]
        def wait():
            for _ in range(400):
                job = client.get(f"/api/render/jobs/{identifier}").json()
                if job["status"] in {"failed", "succeeded"}: return job
                time.sleep(0.05)
            pytest.fail("route timed out")
        job = wait(); assert job["status"] == "failed", job
        assert job["segments"][0]["status"] == "succeeded"
        first_path = app.state.routes.directory / identifier / "segment-0000/result.mp4"
        first = first_path.read_bytes()
        assert client.post(f"/api/render/jobs/{identifier}/retry").status_code == 202
        job = wait(); assert job["status"] == "succeeded", job
        assert app.state.routes.provider.calls == [0, 1, 1]
        assert app.state.routes.provider.last_adapters == job['adapters']
        assert job['adapters'][0]['sha256'] == 'b' * 64
        app.state.routes.provider.adapter_digest = 'c' * 64
        mismatch = client.post(f"/api/render/jobs/{identifier}/retry")
        assert mismatch.status_code == 409 and 'version changed' in mismatch.text
        app.state.routes.provider.adapter_digest = 'b' * 64
        assert first_path.read_bytes() == first
        assert job["result"]["frameCount"] == 120
        assert client.get(job["videoUrl"]).status_code == 200
        assert client.post(f"/api/render/jobs/{identifier}/rebuild").status_code == 202
        assert wait()["status"] == "succeeded"
        assert app.state.routes.provider.calls == [0, 1, 1, 0, 1]
        assert (world / "saved.json").read_bytes() == original
        assert client.get(f"/api/render/jobs/{identifier}/logs").status_code == 200
