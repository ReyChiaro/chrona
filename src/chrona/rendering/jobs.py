from chrona.infrastructure.i18n import annotate_payload

"""Rendering workspace and atomic metadata persistence."""
from chrona.infrastructure.i18n import msg, error_message
import json
import logging
import traceback
import uuid
from pathlib import Path

from chrona.infrastructure.events import EventJournal

log = logging.getLogger(__name__)


def atomic_json(path: Path, value):
    temporary = path.with_suffix(f".{uuid.uuid4()}.tmp")
    temporary.write_text(
        json.dumps(annotate_payload(value), ensure_ascii=False, indent=2)
    )
    temporary.replace(path)


class RenderWorkspace:
    def __init__(self, settings):
        self.settings = settings
        self.root = settings.data_dir.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.journal = EventJournal(self.root)
        self.journal.emit(
            "service.config",
            msg(
                "backend.rendering.jobs.initial-rendering-service-configuration"
            ),
            configuration=settings.model_dump(
                mode="json",
                exclude={
                    "agent_api_key",
                    "agent_base_url",
                },
            ),
            dataPath=str(self.root),
            profilePath=str(settings.profile_path.resolve()),
            modelPath=str(settings.model_path.resolve())
            if settings.model_path
            else None,
            logPath=str(self.journal.service_path),
        )
        try:
            self.profile = json.loads(settings.profile_path.read_text())
        except Exception as error:
            self.journal.emit(
                "service.initialization.failed",
                msg(
                    "backend.rendering.jobs.failed-to-read-video-configuration"
                ),
                level="error",
                error=error_message(error),
                traceback=traceback.format_exc(),
            )
            raise

    def close(self):
        self.journal.emit(
            "service.stopping",
            msg("backend.rendering.jobs.the-rendering-service-is-stopping"),
        )
