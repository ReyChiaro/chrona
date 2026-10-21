from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import LocalizedJSONResponse, install_i18n
from chrona.infrastructure.i18n import msg
from contextlib import asynccontextmanager
import json
import uuid
import math
import traceback
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile, Query, Request, Response
from fastapi.responses import FileResponse

from chrona.infrastructure.config import Settings
from chrona.protocol.media import SceneSnapshot, RecordingEdit
from chrona.rendering.jobs import JobArchive, atomic_json
from chrona.rendering.media import probe
from chrona.rendering.continuous.manager import RouteManager
from chrona.rendering.generation import VideoGeneration, VideoRequest
from chrona.authoring.content_agent import propose
from chrona.authoring.agents.manager import SceneAgentManager
from chrona.authoring.agents.settings import AgentUpdate
from chrona.authoring.agents.client import test_connection
from chrona.authoring.agents.access import COOKIE, SESSION_SECONDS
from chrona.adapters.prompt_enhancement.routes import enhancement_routes
from pydantic import ValidationError


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    manager = JobArchive(settings)
    try:
        routes = RouteManager(settings, manager.journal)
    except Exception as error:
        manager.journal.emit("service.initialization.failed", msg('backend.api.app.video-provider-initialization-failed'), level="error", error=error_message(error), traceback=traceback.format_exc())
        raise
    generation = VideoGeneration(manager, routes)
    agents = SceneAgentManager(settings, manager.journal)

    @asynccontextmanager
    async def lifespan(app):
        if settings.preload:
            routes.preload()
        manager.journal.emit("service.started", msg('backend.api.app.rendering-api-started'), preload=settings.preload)
        yield
        manager.close()
        routes.close()

    app = FastAPI(title="Chrona Rendering", lifespan=lifespan, default_response_class=LocalizedJSONResponse)
    install_i18n(app)
    app.state.manager = manager
    app.state.generation = generation
    app.state.routes = routes
    app.state.agents = agents
    app.include_router(enhancement_routes(routes.prompt_enhancement, agents.access, manager.journal))

    def require_enhancement_access(request, identifier):
        job = generation.get(str(identifier))
        if job.get('promptEnhancement', {}).get('enabled'): agents.access.require(request)

    def config_error(error):
        return '; '.join(e['msg'] for e in error.errors(include_input=False)) if isinstance(error, ValidationError) else error_message(error)

    from chrona.api.authoring import authoring_routes
    app.include_router(authoring_routes(agents, manager.journal))

    @app.post("/api/render/references", status_code=201)
    async def upload_reference(file: UploadFile = File(...)):
        import hashlib
        import io
        from PIL import Image, UnidentifiedImageError
        content = await file.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024: raise HTTPException(400, msg('backend.api.app.the-reference-image-exceeds-10-mb'))
        try:
            image = Image.open(io.BytesIO(content))
            if image.width * image.height > 25000000: raise ValueError(msg('backend.api.app.the-reference-image-dimensions-are-too-large'))
            image = image.convert("RGB"); image.thumbnail((2048, 2048))
            buffer = io.BytesIO(); image.save(buffer, format="PNG"); normalized = buffer.getvalue()
            identifier = hashlib.sha256(normalized).hexdigest()
            (routes.references / f"{identifier}.png").write_bytes(normalized)
        except (ValueError, OSError, UnidentifiedImageError) as error:
            raise HTTPException(400, msg('backend.api.app.cannot-read-the-reference-image')) from error
        manager.journal.emit("reference.saved", msg('backend.api.app.object-reference-image-saved'), referenceId=identifier, path=str(routes.references / f"{identifier}.png"))
        return {"id": identifier, "url": f"/api/render/references/{identifier}"}

    @app.get("/api/render/references/{identifier}")
    def reference_image(identifier: str):
        import re
        if not re.fullmatch(r"[a-f0-9]{64}", identifier): raise HTTPException(400, msg('backend.api.app.invalid-reference-image-id'))
        path = routes.references / f"{identifier}.png"
        if not path.is_file(): raise HTTPException(404, msg('backend.api.app.reference-image-not-found'))
        return FileResponse(path, media_type="image/png")

    @app.get("/api/render/routes/capabilities", include_in_schema=False)
    @app.get("/api/render/capabilities")
    def capabilities():
        return generation.capabilities()

    @app.post("/api/render/routes", status_code=202, include_in_schema=False)
    @app.post("/api/render/jobs", status_code=202)
    def submit(data: VideoRequest, request: Request):
        if data.prompt_enhancement: agents.access.require(request)
        try: return generation.submit(data)
        except FileNotFoundError as error: raise HTTPException(404, error_message(error)) from error
        except ValueError as error: raise HTTPException(400, error_message(error)) from error

    @app.get("/api/render/routes", include_in_schema=False)
    @app.get("/api/render/jobs")
    def jobs():
        return {"jobs": generation.list()}

    @app.get("/api/render/routes/{identifier}", include_in_schema=False)
    @app.get("/api/render/jobs/{identifier}")
    def status(identifier: uuid.UUID):
        try: return generation.get(str(identifier))
        except KeyError as error: raise HTTPException(404, msg('backend.api.app.task-not-found')) from error

    @app.post("/api/render/routes/{identifier}/retry", status_code=202, include_in_schema=False)
    @app.post("/api/render/jobs/{identifier}/retry", status_code=202)
    def retry(identifier: uuid.UUID, request: Request):
        try:
            require_enhancement_access(request, identifier)
            return generation.resume(str(identifier))
        except KeyError as error: raise HTTPException(404, msg('backend.api.app.task-not-found')) from error
        except ValueError as error: raise HTTPException(409, error_message(error)) from error

    @app.post("/api/render/routes/{identifier}/rebuild", status_code=202, include_in_schema=False)
    @app.post("/api/render/jobs/{identifier}/rebuild", status_code=202)
    def rebuild(identifier: uuid.UUID, request: Request):
        try:
            require_enhancement_access(request, identifier)
            return generation.resume(str(identifier), rebuild=True)
        except KeyError as error: raise HTTPException(404, msg('backend.api.app.task-not-found')) from error
        except ValueError as error: raise HTTPException(409, error_message(error)) from error

    @app.get("/api/render/routes/{identifier}/video", include_in_schema=False)
    @app.get("/api/render/jobs/{identifier}/video")
    def result(identifier: uuid.UUID):
        try: path = generation.video_path(str(identifier))
        except (KeyError, FileNotFoundError) as error: raise HTTPException(404, msg('backend.api.app.the-video-has-not-been-generated-yet')) from error
        return FileResponse(path, media_type="video/mp4", filename="rendered-world.mp4")

    @app.get("/api/render/health")
    def health():
        caps = generation.capabilities()
        return {"status": "ok", "providerState": caps['providerState'], "error": caps['providerError']}

    @app.post("/api/render/recordings", status_code=201)
    async def upload(video: UploadFile = File(...), metadata: UploadFile | str = File(...)):
        try:
            if not isinstance(metadata, str):
                content = await metadata.read(settings.metadata_limit_mb * 1024 * 1024 + 1)
                if len(content) > settings.metadata_limit_mb * 1024 * 1024:
                    raise ValueError(msg('backend.api.app.camera-trajectory-metadata-exceeds-the-configured-size-limit'))
                metadata = content.decode("utf8")
            data = json.loads(metadata)
            duration = float(data["duration"])
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError(msg('backend.api.app.recording-duration-must-be-positive'))
            if len(data.get("observations", [])) > settings.observation_limit:
                raise ValueError(msg('backend.api.app.the-observation-trajectory-is-too-long'))
            if len(data.get('contextSnapshots', [])) > settings.observation_limit:
                raise ValueError(msg('backend.api.app.the-context-trajectory-is-too-long'))
            data['contextSnapshots'] = [SceneSnapshot.model_validate(s).model_dump(exclude_none=True) for s in data.get('contextSnapshots', [])]
            if len(data.get('editEvents', [])) > 10000: raise ValueError(msg('backend.api.app.too-many-edits-in-a-single-recording'))
            data['editEvents'] = [RecordingEdit.model_validate(e).model_dump() for e in data.get('editEvents', [])]
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(400, error_message(error)) from error
        identifier = str(uuid.uuid4())
        directory = manager.root / identifier
        directory.mkdir()
        path = directory / "source.webm"
        manager.journal.emit("recording.receiving", msg('backend.api.app.receiving-the-recorded-video'), recordingId=identifier, inputPath=str(path))
        try:
            size = 0
            with path.open("wb") as output:
                while chunk := await video.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.upload_limit_mb * 1024 * 1024:
                        raise ValueError(msg('backend.api.app.the-recording-exceeds-the-size-limit'))
                    output.write(chunk)
            info = probe(path, count_frames=True)
            if abs(info["duration"] - duration) > 1.5:
                raise ValueError(msg('backend.api.app.the-recording-does-not-match-its-timing-metadata'))
            atomic_json(directory / "recording.json", {**data, "media": info, "size": size})
            manager.journal.emit("recording.saved", msg('backend.api.app.recorded-video-and-camera-metadata-saved'), recordingId=identifier,
                inputPath=str(path), metadataPath=str(directory / "recording.json"), bytes=size, media=info)
        except Exception as error:
            import shutil
            manager.journal.emit("recording.failed", msg('backend.api.app.failed-to-read-or-save-the-recorded-video'), level="error", recordingId=identifier, inputPath=str(path), error=error_message(error))
            shutil.rmtree(directory)
            raise HTTPException(400, msg('backend.api.app.cannot-read-the-recorded-video', p0=error)) from error
        return {"id": identifier, "duration": duration, "frameCount": info["frameCount"], "sourceUrl": f"/api/render/recordings/{identifier}/video"}

    @app.get("/api/render/recordings/{identifier}/video")
    def recording_video(identifier: uuid.UUID):
        path = manager.root / str(identifier) / "source.webm"
        if not path.exists():
            raise HTTPException(404, msg('backend.api.app.recording-not-found'))
        return FileResponse(path, media_type="video/webm")

    @app.get("/api/render/logs")
    def service_logs(after: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=1000)):
        return manager.journal.read(after=after, limit=limit)

    @app.get("/api/render/logs/download")
    def download_service_logs():
        return FileResponse(manager.journal.service_path, media_type="application/x-ndjson", filename="render-service.jsonl")

    @app.get("/api/render/jobs/{identifier}/logs")
    def job_logs(identifier: uuid.UUID, after: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=1000)):
        if str(identifier) not in manager.jobs and str(identifier) not in routes.jobs:
            raise HTTPException(404, msg('backend.api.app.task-not-found'))
        return manager.journal.read(job_id=str(identifier), after=after, limit=limit)

    @app.get("/api/render/jobs/{identifier}/logs/download")
    def download_job_logs(identifier: uuid.UUID):
        if str(identifier) not in manager.jobs and str(identifier) not in routes.jobs:
            raise HTTPException(404, msg('backend.api.app.task-not-found'))
        path = manager.journal.path(str(identifier))
        return FileResponse(path, media_type="application/x-ndjson", filename=f"render-{identifier}.jsonl")

    return app
