from chrona.infrastructure.i18n import annotate_payload

"""Append-only structured events with cursor reads shared by files and the web UI."""
from datetime import datetime, timezone
import json
import re
import threading
from pathlib import Path


def redact(value):
    if isinstance(value, dict):
        return {
            key: "[redacted]"
            if re.search(
                r"password|secret|token|authorization|credential|api[_-]?key",
                str(key),
                re.I,
            )
            else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", value)
    if isinstance(value, Path):
        return str(value)
    return value


class EventJournal:
    def __init__(self, root: Path):
        self.root = root
        self.service_path = root / "logs" / "service.jsonl"
        self.service_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def path(self, job_id: str | None = None) -> Path:
        return (
            self.root / job_id / "events.jsonl" if job_id else self.service_path
        )

    def emit(
        self, event: str, message: str, *, job_id=None, level="info", **data
    ):
        entry = redact(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "level": level,
                "event": event,
                "message": message,
                "jobId": job_id,
                "data": data,
            }
        )
        entry = annotate_payload(entry)
        line = (
            json.dumps(entry, ensure_ascii=False, default=str) + "\n"
        ).encode("utf-8")
        with self.lock:
            for path in [self.service_path] + (
                [self.path(job_id)] if job_id else []
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("ab") as output:
                    output.write(line)
        return entry

    def read(self, *, job_id=None, after=0, limit=200):
        path = self.path(job_id)
        with self.lock:
            if not path.exists():
                return {"entries": [], "cursor": 0, "hasMore": False}
            size = path.stat().st_size
            if after > size:
                after = 0
            entries = []
            with path.open("rb") as source:
                source.seek(after)
                for _ in range(limit):
                    line = source.readline()
                    if not line:
                        break
                    try:
                        entries.append(json.loads(line))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                cursor = source.tell()
            return {
                "entries": entries,
                "cursor": cursor,
                "hasMore": cursor < size,
            }
