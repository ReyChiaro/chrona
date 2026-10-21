"""Current video generation API."""

from chrona.infrastructure.i18n import msg
import math
from pydantic import Field

from chrona.rendering.continuous.manager import RouteRequest
from chrona.rendering.harness import prompt_defaults
from chrona.protocol.generated import VideoRequest


class VideoGeneration:
    def __init__(self, workspace, coordinator):
        self.workspace, self.coordinator = workspace, coordinator

    def capabilities(self):
        caps = self.coordinator.capabilities()
        fps = caps.get("fps", self.workspace.profile["recording"]["fps"])
        minimum, maximum = caps.get("minFrames", 5), caps.get("maxFrames", 721)
        min_seconds = max(0.5, math.ceil(minimum / fps * 2) / 2)
        max_seconds = max(min_seconds, math.floor(maximum / fps * 2) / 2)
        default_seconds = min(max_seconds, max(min_seconds, 3.5))
        return {
            **prompt_defaults(),
            **caps,
            "recording": self.workspace.profile["recording"],
            "promptEnhancement": self.coordinator.prompt_enhancement.capabilities(),
            "fps": fps,
            "minFrames": minimum,
            "maxFrames": maximum,
            "frameMultiple": caps.get("frameMultiple", 4),
            "frameOffset": caps.get("frameOffset", 1),
            "providerState": "ready" if caps.get("enabled") else "unavailable",
            "providerError": caps.get("error", ""),
            "segmentation": {
                "minSeconds": min_seconds,
                "maxSeconds": max_seconds,
                "defaultSeconds": default_seconds,
                "defaultOverlapFrames": min(
                    9, max(1, (round(default_seconds * fps) - 1) // 2)
                ),
            },
        }

    def submit(self, request):
        return self.coordinator.submit(
            RouteRequest.model_validate(request.model_dump())
        )

    def get(self, identifier):
        with self.coordinator.lock:
            if identifier in self.coordinator.jobs:
                return self.coordinator.describe(
                    self.coordinator.jobs[identifier]
                )
        raise KeyError(identifier)

    def list(self):
        with self.coordinator.lock:
            jobs = [
                self.coordinator.describe(job)
                for job in self.coordinator.jobs.values()
            ]
        return sorted(jobs, key=lambda j: j["createdAt"], reverse=True)[:100]

    def video_path(self, identifier):
        job = self.get(identifier)
        if job["status"] != "succeeded":
            raise FileNotFoundError(
                msg(
                    "backend.rendering.generation.the-video-is-not-complete-yet"
                )
            )
        root = self.coordinator.directory
        path = root / identifier / "result.mp4"
        if not path.is_file():
            raise FileNotFoundError(
                msg("backend.rendering.generation.video-file-not-found")
            )
        return path

    def resume(self, identifier, *, rebuild=False):
        return self.coordinator.resume(identifier, rebuild=rebuild)
