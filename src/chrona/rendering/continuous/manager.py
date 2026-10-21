from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import msg
import hashlib
import importlib
import json
import math
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from pydantic import BaseModel, Field

from chrona.rendering.jobs import atomic_json
from chrona.rendering.media import probe, frame_timestamps
from chrona.rendering.continuous.planning import plan_route
from chrona.rendering.continuous.media import sample_route, segment_video, extract_frame, join_segments
from chrona.rendering.continuous.context import SpatialMemory, video_graph, bind_references
from chrona.rendering.prompting import COMPILER_VERSION
from chrona.rendering.trajectory import sample_observations
from chrona.adapters.lora import AdapterSelection, resolve_adapters
from chrona.adapters.prompt_enhancement.service import PromptEnhancement


from chrona.protocol.generated import RouteRequest


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): result.update(block)
    return result.hexdigest()


class RouteManager:
    def __init__(self, settings, journal):
        self.settings, self.journal = settings, journal
        self.root = settings.data_dir.resolve()
        self.directory = self.root / "routes"; self.directory.mkdir(exist_ok=True)
        self.references = self.root / "references"; self.references.mkdir(exist_ok=True)
        self.memory = SpatialMemory(self.root / "memory")
        self.prompt_enhancement = PromptEnhancement(settings, journal)
        self.provider_spec = settings.video_provider or settings.continuous_provider
        module, name = self.provider_spec.split(":")
        self.provider = getattr(importlib.import_module(module), name)(settings)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="route-renderer")
        self.lock = threading.RLock()
        self.jobs = {}
        self.stopping = False
        for path in self.directory.glob("*/job.json"):
            job = json.loads(path.read_text())
            if job["status"] in {"queued", "running"}:
                job.update(status="failed", error="SERVICE_RESTARTED", phase=msg('backend.rendering.continuous.manager.service-restarted-unfinished-segments-can-be-resumed'))
                atomic_json(path, job)
            self.jobs[job["id"]] = job

    def capabilities(self):
        try: return self.provider.capabilities()
        except Exception as error:
            return {"id": "continuous", "label": msg('backend.rendering.continuous.manager.continuous-video-service'), "enabled": False, "error": error_message(error), "parameters": []}

    def save(self, job):
        atomic_json(self.directory / job["id"] / "job.json", job)

    def submit(self, request: RouteRequest):
        caps = self.capabilities()
        if not caps["enabled"]: raise ValueError(caps.get("error", msg('backend.rendering.continuous.manager.the-continuous-video-provider-is-not-ready')))
        if set(request.budgets) != {"near", "middle", "far"} or any(not 0 <= v <= 32 for v in request.budgets.values()):
            raise ValueError(msg('backend.rendering.continuous.manager.context-budgets-must-contain-near-middle-far-each-within'))
        parameters = validate_parameters(request.parameters, caps["parameters"])
        adapters = resolve_adapters([item.model_dump() for item in request.adapters], caps)
        recording = self.root / request.recording_id
        metadata = json.loads((recording / "recording.json").read_text())
        frames = metadata.get("media", {}).get("frameCount") or probe(recording / "source.webm", count_frames=True)["frameCount"]
        import bisect
        timestamps = frame_timestamps(recording / 'source.webm') if metadata.get('editEvents') else []
        plan = plan_route(frames, request.frame_stride, caps["fps"], request.segment_seconds, request.overlap_frames,
                          minimum=caps["minFrames"], maximum=caps["maxFrames"], multiple=caps["frameMultiple"], offset=caps["frameOffset"],
                          breaks=[bisect.bisect_left(timestamps, e['time']) for e in metadata.get('editEvents', []) if e.get('actions')])
        if len(plan["segments"]) > 1000: raise ValueError(msg('backend.rendering.continuous.manager.a-route-supports-at-most-1000-segments-adjust-segment'))
        enhancement = self.prompt_enhancement.capture(request.prompt_enhancement, plan=plan, parameters=parameters,
            tail_frames=caps.get('referenceTailFrames', 1))
        with self.lock:
            if sum(j["status"] in {"queued", "running"} for j in self.jobs.values()) >= self.settings.queue_limit: raise ValueError(msg('backend.rendering.continuous.manager.the-route-queue-is-full'))
            identifier = str(uuid.uuid4()); folder = self.directory / identifier; folder.mkdir()
            signature = hashlib.sha256(json.dumps({"request": request.model_dump(), "caps": caps, "metadata": metadata,
                "sourceHash": digest(recording / "source.webm"), "promptCompiler": COMPILER_VERSION,
                "promptEnhancement": enhancement}, sort_keys=True).encode()).hexdigest()
            job = {"id": identifier, "kind": "route", "recordingId": request.recording_id, "status": "queued", "phase": msg('backend.rendering.continuous.manager.waiting-for-continuous-video-generation'),
                   "progress": 0, "createdAt": time.time(), "error": None, "videoUrl": None, "signature": signature, "generation": 0,
                   "plan": plan, "parameters": parameters, "adapters": adapters, "promptEnhancement": enhancement, "profile": caps.get("profile"), "provider": self.provider_spec, "conditions": caps.get("conditions", {"firstImage": True}), "referenceTailFrames": caps.get("referenceTailFrames", 1),
                   "segments": [{**s, "status": "pending", "attempts": 0, "error": None} for s in plan["segments"]]}
            atomic_json(folder / "request.json", request.model_dump()); self.jobs[identifier] = job; self.save(job)
            self.journal.emit("route.queued", msg('backend.rendering.continuous.manager.continuous-route-saved'), job_id=identifier, plan=plan, parameters=parameters, adapters=adapters, promptEnhancement=enhancement, outputPath=str(folder / "result.mp4"), signature=signature)
            self.executor.submit(self.run, identifier)
            return json.loads(json.dumps(job))

    def resume(self, identifier, *, rebuild=False):
        with self.lock:
            job = self.jobs[identifier]
            caps = self.capabilities()
            if not caps.get("enabled"):
                raise ValueError(msg('backend.rendering.continuous.manager.the-video-model-is-not-ready-restore-the-service'))
            original_provider = job.get("provider", "chrona.adapters.providers.http_video:HttpVideoRenderer")
            if original_provider != self.provider_spec or (job.get("profile") and job["profile"] != caps.get("profile")):
                raise ValueError(msg('backend.rendering.continuous.manager.this-task-s-model-differs-from-the-current-configuration'))
            self.verify_adapters(job, caps)
            if job.get('promptEnhancement', {}).get('enabled'):
                self.prompt_enhancement.current(job['promptEnhancement'])
            if job["status"] in {"queued", "running"}: raise ValueError(msg('backend.rendering.continuous.manager.the-route-is-running'))
            if rebuild:
                job["generation"] += 1
                for segment in job["segments"]: segment.update(status="pending", attempts=0, upstreamId=None, error=None)
            else:
                for segment in job["segments"]:
                    if segment["status"] != "succeeded": segment.update(status="pending", attempts=0, error=None)
            job.update(status="queued", error=None, videoUrl=None, phase=msg('backend.rendering.continuous.manager.rebuilding-render-cache') if rebuild else msg('backend.rendering.continuous.manager.resuming-unfinished-segments'))
            self.save(job); self.executor.submit(self.run, identifier)
            return json.loads(json.dumps(job))

    def run(self, identifier):
        job = self.jobs[identifier]; folder = self.directory / identifier
        request = RouteRequest.model_validate_json((folder / "request.json").read_text())
        recording = self.root / job["recordingId"]
        try:
            self.verify_adapters(job, self.capabilities())
            if job.get('promptEnhancement', {}).get('enabled'):
                self.prompt_enhancement.current(job['promptEnhancement'])
            job.update(status="running", startedAt=time.time()); self.save(job)
            metadata = json.loads((recording / "recording.json").read_text())
            plan, fps = job["plan"], job["plan"]["outputFps"]
            parameters = job["parameters"]
            sampled = folder / "sampled.mp4"
            sample_route(recording / "source.webm", sampled, plan, int(parameters["width"]), int(parameters["height"]))
            timestamps = frame_timestamps(recording / "source.webm")
            atomic_json(folder / "trajectory.json", {"plan": plan,
                "observations": sample_observations(metadata.get("observations", []), timestamps, plan["frameStride"], plan)})
            adapter_style = json.dumps(job['adapters'], sort_keys=True) if job.get('adapters') else ''
            enhancement_style = json.dumps(job['promptEnhancement'], sort_keys=True) if job.get('promptEnhancement', {}).get('enabled') else ''
            style = hashlib.sha256((self.provider_spec + str(job.get("profile")) + adapter_style + enhancement_style + COMPILER_VERSION + request.prompt + request.system_prompt).encode()).hexdigest()
            outputs = []
            for index, segment in enumerate(job["segments"]):
                if self.stopping: raise RuntimeError("SERVICE_STOPPING")
                target = folder / f"segment-{index:04d}"; target.mkdir(exist_ok=True)
                output = target / "result.mp4"
                cache_path = target / "cache.json"
                if segment["status"] == "succeeded" and output.exists() and cache_path.exists():
                    cache = json.loads(cache_path.read_text())
                    if cache["signature"] == job["signature"] and cache["sha256"] == digest(output):
                        outputs.append(output); continue
                start_time = timestamps[segment["sourceStart"]]
                end_time = timestamps[segment["sourceEnd"]]
                snapshots = metadata.get("contextSnapshots", [])
                eligible = [s for s in snapshots if s['time'] <= start_time + 1e-6]
                first = eligible[-1] if eligible else (snapshots[0] if snapshots else {})
                eligible_end = [s for s in snapshots if s['time'] <= end_time + 1e-6]
                last = eligible_end[-1] if eligible_end else first
                visible = [s for s in snapshots if start_time <= s["time"] <= end_time]
                if first and (not visible or visible[0] != first): visible.insert(0, first)
                image_supported = job.get("conditions", {}).get("firstImage", True)
                memories = self.memory.retrieve(first, style) if image_supported else []
                reference, image = target / "reference.mp4", target / "first-image.png"
                segment_video(sampled, reference, segment, fps, tail_frames=job.get("referenceTailFrames", 1))
                extract_frame(reference, image, 0)
                continuity = {"mode": "proxy-first-frame"}
                if image_supported and index and segment['overlapFrames']:
                    previous = job["segments"][index - 1]
                    offset = segment["start"] - previous["start"]
                    extract_frame(outputs[-1], image, offset)
                    continuity = {"mode": "previous-generated-frame", "segment": index - 1, "frame": offset}
                elif not segment.get('stateBoundary') and memories and memories[0]["confidence"] > 0.75:
                    import shutil
                    shutil.copyfile(self.memory.root / f"{memories[0]['id']}.png", image)
                    continuity = {"mode": "spatial-memory", "id": memories[0]["id"], "confidence": memories[0]["confidence"]}
                if segment.get('stateBoundary'): continuity = {'mode': 'edited-world-proxy', 'reason': 'world edit; never blend or reuse the prior appearance'}
                if not image_supported: continuity = {'mode': 'reference-video-only'}
                bindings = bind_references(image, first, self.references) if image_supported and job.get('conditions', {}).get('objectReferenceComposite', True) else []
                harness = video_graph.invoke({"snapshots": visible, "direction": request.prompt, "system": request.system_prompt,
                    "budgets": request.budgets, "memories": memories, "continuity": continuity, "referenceBindings": bindings})
                prompt_path = target / "prompt.txt"
                source_prompt = target / 'prompt-source.txt'; source_prompt.write_text(harness['prompt'])
                atomic_json(target / "shot.json", {"description": harness["shot"], "compilation": harness["promptManifest"]})
                self.journal.emit("route.prompt.compiled", msg('backend.rendering.continuous.manager.visual-prompt-compiled'), job_id=identifier, segment=index,
                    prompt=harness["prompt"], compiler=harness["promptManifest"]["version"],
                    estimatedUnits=harness["promptManifest"]["estimatedUnits"], warnings=harness["promptManifest"]["warnings"],
                    promptPath=str(source_prompt), shotPath=str(target / "shot.json"))
                atomic_json(target / "conditions.json", {"trace": harness["trace"], "promptCompiler": harness["promptManifest"]["version"], "context": visible, "memories": memories,
                    "continuity": continuity, "bindings": bindings, "sourceTimes": [start_time, end_time], "plan": segment})
                def report(message, value=None, **details):
                    if self.stopping: raise InterruptedError('SERVICE_STOPPING')
                    event = details.pop('event', 'route.segment.progress')
                    with self.lock:
                        segment.update(phase=message, updatedAt=time.time())
                        job.update(phase=msg('backend.rendering.continuous.manager.segment', p0=index + 1, p1=len(job['segments']), p2=message), progress=(index + (value or 0)) / len(job["segments"]))
                        if details.get('stage'):
                            job['stage'] = details['stage']
                        if details.get('stage') == 'sampling':
                            job['sampling'] = {key: details.get(key) for key in ('completed', 'total', 'samplingSeconds', 'samplingEtaSeconds')}
                        self.save(job); self.journal.emit(event, job["phase"], job_id=identifier, segment=index, **details)
                def submitted(upstream_id):
                    segment["upstreamId"] = upstream_id; self.save(job)
                effective_prompt = harness['prompt']
                if job.get('promptEnhancement', {}).get('enabled'):
                    segment.update(status='running', error=None); self.save(job)
                    def enhancement_report(message, **details):
                        report(message, stage='prompt-enhancement', **details)
                    effective_prompt = self.prompt_enhancement.enhance_segment(captured=job['promptEnhancement'],
                        folder=target, video=reference, image=image if image_supported else None, harness=harness,
                        direction=request.prompt, system=request.system_prompt, duration=segment['validFrames'] / fps,
                        report=enhancement_report, cancelled=lambda: self.stopping)
                if prompt_path.exists() and prompt_path.read_text() != effective_prompt:
                    # A changed prompt must not reconnect to an upstream task with old conditions.
                    segment['upstreamId'] = None
                prompt_path.write_text(effective_prompt)
                for attempt in range(request.retries + 1):
                    segment.update(status="running", attempts=segment["attempts"] + 1, error=None); self.save(job)
                    report(msg('backend.rendering.continuous.manager.preparing-model-conditioning'), referencePath=str(reference), imagePath=str(image) if image_supported else None, promptPath=str(target / "prompt.txt"), continuity=continuity, bindings=bindings)
                    try:
                        result = self.provider.render_segment(video=reference, image=image if image_supported else None, prompt=effective_prompt, parameters={**parameters,
                            "profile": job["profile"], "fps": fps, "frames": segment["frames"]}, output=output,
                            progress=report, resume_id=segment.get("upstreamId"), submitted=submitted, adapters=job.get('adapters', []))
                        info = probe(output, count_frames=True)
                        if info["frameCount"] < segment["validFrames"]: raise RuntimeError(msg('backend.rendering.continuous.manager.the-model-produced-too-few-frames'))
                        atomic_json(cache_path, {"signature": job["signature"], "sha256": digest(output), "generation": job["generation"]})
                        segment.update(status="succeeded", result=result); self.save(job)
                        frame = target / "keyframe.png"; extract_frame(output, frame, segment["validFrames"] - 1)
                        self.memory.save(f"{identifier}-{index:04d}", frame, last, style)
                        outputs.append(output); report(msg('backend.rendering.continuous.manager.segment-saved'), outputPath=str(output), media=info)
                        break
                    except Exception as error:
                        segment.update(status="failed", error=error_message(error))
                        if not isinstance(error, (TimeoutError, http_network_errors())): segment["upstreamId"] = None
                        self.save(job); report(msg('backend.rendering.continuous.manager.segment-failed-retry-available'), error=error_message(error), attempt=attempt)
                        if attempt == request.retries: raise
                self.save(job)
            job.update(phase=msg('backend.rendering.continuous.manager.blending-overlapping-views-and-joining-the-full-route'), progress=0.97); self.save(job)
            join_segments(outputs, job["segments"], folder / "result.mp4", fps, audio=bool(parameters.get("audio", False)))
            result = probe(folder / "result.mp4", count_frames=True)
            if result["frameCount"] != plan["outputFrames"]: raise RuntimeError(msg('backend.rendering.continuous.manager.the-joined-frame-count-does-not-match-the-full'))
            job.update(status="succeeded", phase=msg('backend.rendering.continuous.manager.video-generation-complete'), progress=1, result=result, finishedAt=time.time(), videoUrl=f"/api/render/jobs/{identifier}/video")
            self.save(job); self.journal.emit("route.succeeded", msg('backend.rendering.continuous.manager.continuous-video-saved'), job_id=identifier, result=result, outputPath=str(folder / "result.mp4"))
        except Exception as error:
            for segment in job['segments']:
                if segment['status'] == 'running': segment.update(status='failed', error=error_message(error))
            job.update(status="failed", phase=msg('backend.rendering.continuous.manager.continuous-video-paused-completed-segments-are-preserved'), error=error_message(error), finishedAt=time.time()); self.save(job)
            self.journal.emit("route.failed", job["phase"], job_id=identifier, level="error", error=error_message(error), traceback=traceback.format_exc())

    def verify_adapters(self, job, caps):
        saved = job.get('adapters', [])
        current = resolve_adapters([{'id': item['id'], 'scale': item['scale']} for item in saved], caps)
        if current != saved:
            raise ValueError(msg('backend.rendering.continuous.manager.the-lora-weight-version-changed-restore-the-original-file'))

    def describe(self, job):
        value = json.loads(json.dumps(job))
        if job.get("startedAt") is not None:
            value["elapsedSeconds"] = max(0, job.get("finishedAt", time.time()) - job["startedAt"])
        return value

    def preload(self):
        if not hasattr(self.provider, "load"):
            return None
        def report(message, value=None, *, event="model.loading", **details):
            self.journal.emit(event, message, **details)
        def load():
            try:
                self.provider.load(report=report)
                report(msg('backend.rendering.continuous.manager.the-current-video-model-is-ready'), event="model.ready")
            except Exception as error:
                report(msg('backend.rendering.continuous.manager.video-model-warmup-failed-generation-tasks-can-retry-loading'), event="model.failed", level="error", error=error_message(error), traceback=traceback.format_exc())
        return self.executor.submit(load)

    def close(self):
        self.stopping = True
        self.executor.shutdown(wait=False, cancel_futures=True)


def http_network_errors():
    import httpx
    return httpx.TransportError


def validate_parameters(parameters, fields):
    definitions = {field["key"]: field for field in fields}
    if set(parameters) - set(definitions):
        raise ValueError(msg('backend.rendering.continuous.manager.some-parameters-are-not-supported-by-the-current-model'))
    result = {}
    for key, field in definitions.items():
        value = parameters.get(key, field["default"])
        if field.get("type") == "boolean":
            if not isinstance(value, bool): raise ValueError(msg('backend.rendering.continuous.manager.must-be-a-boolean', p0=field['label']))
        elif (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
              or not field['min'] <= value <= field['max']
              or abs((value - field['min']) / field['step'] - round((value - field['min']) / field['step'])) > 1e-5):
            raise ValueError(msg('backend.rendering.continuous.manager.must-be-within-with-step', p0=field['label'], p1=field['min'], p2=field['max'], p3=field['step']))
        result[key] = value
    return result
