import json
import shutil
import subprocess
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from chrona.api.app import create_app
from chrona.infrastructure.config import Settings
from chrona.rendering.continuous.manager import validate_parameters


class CopyProvider:
    """Explicit test adapter; never registered by a deployed service."""
    def __init__(self, settings):
        pass

    def load(self, *, report=None):
        pass

    def render(self, *, video, prompt, parameters, output, progress):
        assert "reference video" in prompt
        progress("test adapter", 0.5, event='sampling.step', stage='sampling', completed=1, total=2,
                 samplingSeconds=1, samplingEtaSeconds=1)
        shutil.copy(video, output)
        return {"testAdapter": True}


@pytest.fixture
def app(tmp_path):
    return create_app(Settings(data_dir=tmp_path, provider="test_render_service:CopyProvider", video_provider="chrona.adapters.providers.local_reference:LocalReferenceRenderer", preload=False))


@pytest.mark.parametrize("prompt_fields", [{"prompt": "Render natural stone and timber"}, {"prompt": ""}, {}, {"prompt": " \n\t "}], ids=["description", "empty", "omitted", "whitespace"])
def test_api_recording_job_result_and_persistence(app, tmp_path, prompt_fields):
    source = tmp_path / "sample.webm"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "testsrc2=size=384x384:rate=24", "-t", "5.3", "-c:v", "libvpx-vp9", str(source)], check=True)
    with TestClient(app) as client:
        caps = client.get("/api/render/capabilities").json()
        assert caps["enabled"] and "systemPrompt" in caps
        response = client.post("/api/render/recordings", files={"video": ("sample.webm", source.read_bytes(), "video/webm")},
            data={"metadata": json.dumps({"duration": 5.3, "observations": []})})
        assert response.status_code == 201, response.text
        recording = response.json()
        body = {"recording_id": recording["id"], **prompt_fields, "parameters": {"audio": False}}
        invalid = client.post("/api/render/jobs", json={**body, "parameters": {"unknown": 3}})
        assert invalid.status_code == 400
        image = client.post("/api/render/jobs", json={**body, "history_keyframes": [{"kind": "keyframe", "asset_id": "x"}]})
        assert image.status_code == 422
        response = client.post("/api/render/jobs", json=body)
        assert response.status_code == 202, response.text
        identifier = response.json()["id"]
        for _ in range(600):
            job = client.get(f"/api/render/jobs/{identifier}").json()
            if job["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.1)
        assert job["status"] == "succeeded", job
        assert client.get(job["videoUrl"]).status_code == 200
        events = client.get(f"/api/render/jobs/{identifier}/logs").json()
        assert events["entries"][0]["event"] == "route.queued"
        assert events["entries"][-1]["event"] == "route.succeeded"
        assert any(e['event'] == 'sampling.step' and e['data']['completed'] == 1 for e in events['entries'])
        assert events["entries"][0]["data"]["outputPath"].endswith("result.mp4")
        assert client.get(f"/api/render/jobs/{identifier}/logs?after={events['cursor']}").json()["entries"] == []
        downloaded = client.get(f"/api/render/jobs/{identifier}/logs/download")
        assert downloaded.status_code == 200
        assert "attachment" in downloaded.headers["content-disposition"]
        assert json.loads(downloaded.text.splitlines()[0])["event"] == "route.queued"
        service = client.get("/api/render/logs").json()
        assert service["entries"][0]["event"] == "service.config"
        assert client.get("/api/render/logs/download").status_code == 200
        assert client.get(f"/api/render/jobs/{uuid.uuid4()}/logs").status_code == 404
        assert (tmp_path / "routes" / identifier / "request.json").exists()
        folder = tmp_path / "routes" / identifier
        saved = json.loads((folder / "request.json").read_text())
        assert saved["prompt"] == prompt_fields.get("prompt", "")
        compiled = (folder / "segment-0000" / "prompt.txt").read_text()
        assert "Re-render the low-poly reference video" in compiled
        if not saved["prompt"].strip():
            assert caps["prompt"].strip() not in compiled
        assert len(client.get("/api/render/jobs").json()["jobs"]) == 1
        assert client.get("/api/render/jobs/not-an-id").status_code == 422
    replacement = create_app(Settings(data_dir=tmp_path, provider="test_render_service:CopyProvider", video_provider="chrona.adapters.providers.local_reference:LocalReferenceRenderer", preload=False))
    assert replacement.state.routes.jobs[identifier]["status"] == "succeeded"
    assert any(entry["event"] == "route.succeeded" for entry in replacement.state.manager.journal.read(job_id=identifier)["entries"])
    replacement.state.manager.close(); replacement.state.routes.close()


def test_invalid_media_and_parameters_do_not_enter_queue(app):
    with TestClient(app) as client:
        bad = client.post("/api/render/recordings", files={"video": ("bad.webm", b"not video")},
            data={"metadata": json.dumps({"duration": 5.3})})
        assert bad.status_code == 400
        assert client.post("/api/render/jobs", json={"recording_id": "../escape", "prompt": "x"}).status_code == 422
        fields = app.state.routes.capabilities()['parameters']
        with pytest.raises(ValueError):
            validate_parameters({"width": 961}, fields)
        with pytest.raises(ValueError):
            validate_parameters({"steps": float("nan")}, fields)


def test_restart_marks_interrupted_job_failed(tmp_path):
    identifier = str(uuid.uuid4())
    directory = tmp_path / "routes" / identifier
    directory.mkdir(parents=True)
    (directory / "job.json").write_text(json.dumps({"id": identifier, "status": "running"}))
    app = create_app(Settings(data_dir=tmp_path, provider="test_render_service:CopyProvider", video_provider="chrona.adapters.providers.local_reference:LocalReferenceRenderer", preload=False))
    assert app.state.routes.jobs[identifier]["status"] == "failed"
    app.state.manager.close(); app.state.routes.close()
