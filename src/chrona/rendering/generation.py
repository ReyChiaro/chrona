"""One public generation API for short shots, long routes and archived results."""
from chrona.infrastructure.i18n import msg
import math
from pydantic import Field

from chrona.protocol.media import ContextItem, TrajectorySampling
from chrona.rendering.continuous.manager import RouteRequest
from chrona.rendering.harness import prompt_defaults


from chrona.protocol.generated import VideoRequest as VideoRequestModel


class VideoRequest(VideoRequestModel):
    def route_request(self):
        values = self.model_dump(include=set(RouteRequest.model_fields))
        if self.trajectory:
            values['frame_stride'] = self.trajectory.frame_stride
        evidence = self.context_buffer + self.history_keyframes
        if any(item.kind != 'text' for item in evidence):
            raise ValueError(msg('backend.rendering.generation.bind-images-through-scene-object-references-historical-keyframes-are'))
        text = [item.text for item in evidence if item.text and item.confidence > 0.75]
        if text:
            values['prompt'] += '\n' + '\n'.join(text)
        return RouteRequest.model_validate(values)


class VideoGeneration:
    def __init__(self, archive, coordinator):
        self.archive, self.coordinator = archive, coordinator

    def capabilities(self):
        caps = self.coordinator.capabilities()
        fps = caps.get('fps', self.archive.profile['recording']['fps'])
        minimum, maximum = caps.get('minFrames', 5), caps.get('maxFrames', 721)
        min_seconds = max(0.5, math.ceil(minimum / fps * 2) / 2)
        max_seconds = max(min_seconds, math.floor(maximum / fps * 2) / 2)
        default_seconds = min(max_seconds, max(min_seconds, 3.5))
        return {**prompt_defaults(), **caps, 'recording': self.archive.profile['recording'],
                'promptEnhancement': self.coordinator.prompt_enhancement.capabilities(),
                'fps': fps, 'minFrames': minimum, 'maxFrames': maximum,
                'frameMultiple': caps.get('frameMultiple', 4), 'frameOffset': caps.get('frameOffset', 1),
                'providerState': 'ready' if caps.get('enabled') else 'unavailable', 'providerError': caps.get('error', ''),
                'segmentation': {'minSeconds': min_seconds, 'maxSeconds': max_seconds,
                    'defaultSeconds': default_seconds, 'defaultOverlapFrames': min(9, max(1, (round(default_seconds * fps) - 1) // 2))}}

    def submit(self, request):
        return self.coordinator.submit(request.route_request())

    def get(self, identifier):
        with self.coordinator.lock:
            if identifier in self.coordinator.jobs:
                return self.coordinator.describe(self.coordinator.jobs[identifier])
        if identifier in self.archive.jobs:
            return self.archive.describe(self.archive.jobs[identifier])
        raise KeyError(identifier)

    def list(self):
        with self.coordinator.lock:
            jobs = [self.coordinator.describe(job) for job in self.coordinator.jobs.values()]
        jobs += [self.archive.describe(job) for job in self.archive.jobs.values()]
        return sorted(jobs, key=lambda j: j['createdAt'], reverse=True)[:100]

    def video_path(self, identifier):
        job = self.get(identifier)
        if job['status'] != 'succeeded':
            raise FileNotFoundError(msg('backend.rendering.generation.the-video-is-not-complete-yet'))
        root = self.coordinator.directory if identifier in self.coordinator.jobs else self.archive.root
        path = root / identifier / 'result.mp4'
        if not path.is_file(): raise FileNotFoundError(msg('backend.rendering.generation.video-file-not-found'))
        return path

    def resume(self, identifier, *, rebuild=False):
        if identifier in self.archive.jobs:
            raise ValueError(msg('backend.rendering.generation.legacy-videos-can-be-viewed-and-downloaded-submit-the'))
        return self.coordinator.resume(identifier, rebuild=rebuild)
