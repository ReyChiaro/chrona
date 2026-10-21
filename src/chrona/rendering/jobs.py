from chrona.infrastructure.i18n import annotate_payload
"""Persistent metadata for historical videos; new generation uses RouteManager."""
from chrona.infrastructure.i18n import msg, error_message
import json
import logging
import time
import traceback
import uuid
from pathlib import Path

from chrona.infrastructure.events import EventJournal

log = logging.getLogger(__name__)


def atomic_json(path: Path, value):
    temporary = path.with_suffix(f".{uuid.uuid4()}.tmp")
    temporary.write_text(json.dumps(annotate_payload(value), ensure_ascii=False, indent=2))
    temporary.replace(path)


class JobArchive:
    def __init__(self, settings):
        self.settings = settings
        self.root = settings.data_dir.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.journal = EventJournal(self.root)
        self.journal.emit("service.config", msg('backend.rendering.jobs.initial-rendering-service-configuration'), configuration=settings.model_dump(mode="json", exclude={'agent_api_key', 'agent_access_token', 'agent_base_url'}),
            dataPath=str(self.root), profilePath=str(settings.profile_path.resolve()),
            modelPath=str(settings.model_path.resolve()) if settings.model_path else None,
            logPath=str(self.journal.service_path))
        try:
            self.profile = json.loads(settings.profile_path.read_text())
        except Exception as error:
            self.journal.emit("service.initialization.failed", msg('backend.rendering.jobs.failed-to-read-video-configuration'), level="error", error=error_message(error), traceback=traceback.format_exc())
            raise
        self.jobs = {}
        for path in self.root.glob("*/job.json"):
            try:
                job = json.loads(path.read_text())
            except (json.JSONDecodeError, OSError):
                log.exception("Could not restore job metadata from %s", path)
                self.journal.emit("job.restore.failed", msg('backend.rendering.jobs.failed-to-read-a-historical-task'), level="error", path=str(path), traceback=traceback.format_exc())
                continue
            if job["status"] in ("queued", "running"):
                job.update(status="failed", phase=msg('backend.rendering.jobs.the-legacy-task-was-interrupted-submit-again-through-the'), error="SERVICE_RESTARTED")
                atomic_json(path, job)
            self.jobs[job["id"]] = job
            self.journal.emit("job.restored", msg('backend.rendering.jobs.restored-a-historical-task-record'), job_id=job["id"], status=job["status"], jobPath=str(path))

    def describe(self, job):
        result = dict(job)
        now = job.get("finishedAt", time.time())
        if job.get("startedAt") is not None:
            result["elapsedSeconds"] = max(0, now - job["startedAt"])
        return result

    def close(self):
        self.journal.emit("service.stopping", msg('backend.rendering.jobs.the-rendering-service-is-stopping'))
