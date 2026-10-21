from chrona.infrastructure.i18n import msg
from chrona.infrastructure.resources import resource

"""HTTP video-service adapter, independent from the world engine and model runtime."""
import time
import re
from urllib.parse import quote
from pathlib import Path
import httpx


class HttpVideoRenderer:
    def __init__(self, settings):
        self.settings = settings
        self.base = settings.video_service_url.rstrip("/")
        token = settings.video_service_token.get_secret_value()
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._diagnostic_terms = set()

    def client(self):
        return httpx.Client(
            base_url=self.base,
            headers=self.headers,
            timeout=120,
            trust_env=False,
        )

    def capabilities(self):
        with self.client() as client:
            response = client.get("/api/catalog")
            response.raise_for_status()
            catalog = response.json()
            readiness = client.get("/api/readiness")
            readiness.raise_for_status()
        profiles = catalog["profiles"]
        if not profiles:
            raise ValueError(
                msg(
                    "backend.adapters.providers.http-video.the-video-service-has-no-available-model-configuration"
                )
            )
        # Service-owned module/weight names are implementation details of the remote runtime.
        model_root = Path(catalog.get("model_root", "")).name
        if len(model_root) >= 3:
            self._diagnostic_terms.add(model_root)
        for profile in profiles:
            parts = Path(profile.get("config", "")).parts
            for index, part in enumerate(parts):
                if part == "configs" and index and len(parts[index - 1]) >= 3:
                    self._diagnostic_terms.add(parts[index - 1])
        profile_id = self.settings.video_profile or catalog.get(
            "default_profile"
        )
        chosen = (
            next((p for p in profiles if p["id"] == profile_id), None)
            if profile_id
            else profiles[0]
        )
        if chosen is None:
            raise ValueError(
                msg(
                    "backend.adapters.providers.http-video.the-selected-video-profile-does-not-exist-check-dw"
                )
            )
        fixed = chosen["strategy"] == "chunk_causal"
        parameters = [
            {
                "key": "width",
                "label": msg("backend.adapters.providers.http-video.width"),
                "type": "number",
                "default": 768,
                "min": 256,
                "max": 1920,
                "step": 32,
            },
            {
                "key": "height",
                "label": msg("backend.adapters.providers.http-video.height"),
                "type": "number",
                "default": 448,
                "min": 256,
                "max": 1088,
                "step": 32,
            },
            {
                "key": "steps",
                "label": msg(
                    "backend.adapters.providers.http-video.sampling-steps"
                ),
                "type": "number",
                "default": 4 if fixed else chosen["steps"],
                "min": 4 if fixed else 1,
                "max": 4 if fixed else 100,
                "step": 1,
            },
            {
                "key": "guidance",
                "label": msg(
                    "backend.adapters.providers.http-video.guidance-scale"
                ),
                "type": "number",
                "default": chosen["guidance"],
                "min": 1,
                "max": 10,
                "step": 0.1,
            },
            {
                "key": "seed",
                "label": msg("backend.adapters.providers.http-video.seed"),
                "type": "number",
                "default": chosen["seed"],
                "min": 0,
                "max": 2147483647,
                "step": 1,
            },
        ]
        return {
            "id": "http-video",
            "label": msg(
                "backend.adapters.providers.http-video.video-rendering",
                p0=self._public_text(chosen["label"]),
            ),
            "enabled": readiness.json().get("ready", False),
            "samplingNote": msg(
                "backend.adapters.providers.http-video.these-few-step-weights-use-a-fixed-four-step"
            )
            if fixed
            else msg(
                "backend.adapters.providers.http-video.this-bidirectional-diffusion-configuration-supports-1-100-steps-more"
            ),
            "systemPrompt": (
                resource("harness/rendering/prompts/video-system.txt")
            ).read_text(),
            "profile": chosen["id"],
            "fps": min(24, chosen["fps"]),
            "minFrames": 5,
            "maxFrames": chosen["max_frames"],
            "frameMultiple": 4,
            "frameOffset": 1,
            "parameters": parameters,
            "conditions": {
                "referenceVideo": True,
                "firstImage": True,
                "objectReferenceComposite": True,
                "history": True,
            },
        }

    def _public_text(self, value):
        text = str(value or "")
        if not self._diagnostic_terms:
            return text
        pattern = "|".join(
            re.escape(term)
            for term in sorted(self._diagnostic_terms, key=len, reverse=True)
        )
        return re.sub(pattern, "video-service", text, flags=re.IGNORECASE)

    def render_segment(
        self,
        *,
        video,
        image,
        prompt,
        parameters,
        output,
        progress,
        resume_id=None,
        submitted=None,
    ):
        with self.client() as client:
            identifier = resume_id
            if not identifier:
                uploads = []
                for kind, path in (("video", video), ("image", image)):
                    with path.open("rb") as stream:
                        response = client.post(
                            f"/api/uploads?kind={kind}",
                            files={"file": (path.name, stream)},
                        )
                    response.raise_for_status()
                    uploads.append(response.json()["id"])
                body = {
                    **parameters,
                    "proxy_upload": uploads[0],
                    "image_upload": uploads[1],
                    "prompt": prompt[:12000],
                    "gpu_count": 1,
                    "compile": False,
                }
                response = client.post("/api/jobs", json=body)
                response.raise_for_status()
                identifier = response.json()["id"]
                if submitted:
                    submitted(identifier)
            previous = ""
            deadline = time.monotonic() + self.settings.route_timeout_seconds
            while time.monotonic() < deadline:
                response = client.get(f"/api/jobs/{identifier}")
                response.raise_for_status()
                job = response.json()
                log_response = client.get(f"/api/jobs/{identifier}/logs")
                text = (
                    self._public_text(log_response.json().get("text", ""))
                    if log_response.is_success
                    else ""
                )
                if text != previous or job["status"] != "running":
                    progress(
                        msg(
                            "backend.adapters.providers.http-video.video-service",
                            p0=job["status"],
                        ),
                        upstreamId=identifier,
                        upstreamStatus=job["status"],
                        modelLog=text[-6000:],
                    )
                    previous = text
                if job["status"] == "succeeded":
                    artifact = next(
                        p for p in job["artifacts"] if p.endswith("render.mp4")
                    )
                    with client.stream(
                        "GET",
                        f"/api/jobs/{identifier}/artifacts/{quote(artifact, safe='/')}",
                    ) as download:
                        download.raise_for_status()
                        with output.open("wb") as stream:
                            for chunk in download.iter_bytes():
                                stream.write(chunk)
                    return {
                        "upstreamId": identifier,
                        "profile": parameters["profile"],
                    }
                if job["status"] in {
                    "failed",
                    "interrupted",
                    "cancelled",
                    "validated",
                }:
                    raise RuntimeError(
                        msg(
                            "backend.adapters.providers.http-video.video-model-service",
                            p0=job["status"],
                            p1=self._public_text(job.get("error")),
                            p2=text[-2000:],
                        )
                    )
                time.sleep(self.settings.route_poll_seconds)
            raise TimeoutError(
                msg(
                    "backend.adapters.providers.http-video.video-model-task-timed-out-retrying-reconnects-to-the",
                    p0=identifier,
                )
            )
