"""Owner access for credential changes and chargeable model calls."""

from chrona.infrastructure.i18n import msg
import base64
import hashlib
import hmac
import os
import secrets
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

COOKIE = "chrona_agent_session"
SESSION_SECONDS = 12 * 60 * 60


class AgentAccess:
    def __init__(
        self,
        path: Path,
        configured_token="",
        browser_origin="http://127.0.0.1:4173",
    ):
        self.path = path
        origin = urlsplit(browser_origin)
        self.origins = {f"{origin.scheme}://{origin.netloc}"}
        if origin.hostname in {"127.0.0.1", "localhost"}:
            self.origins.update(
                f"{origin.scheme}://{host}:{origin.port or 80}"
                for host in ["127.0.0.1", "localhost"]
            )
        if configured_token:
            if len(configured_token) < 24:
                raise ValueError(
                    msg(
                        "backend.authoring.agents.access.the-agent-access-token-must-contain-at-least-24"
                    )
                )
            self.owner_token = configured_token
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as output:
                    output.write(secrets.token_urlsafe(32))
            except FileExistsError:
                pass
            self.owner_token = path.read_text().strip()
            os.chmod(path, 0o600)
            if len(self.owner_token) < 24:
                raise ValueError(
                    msg(
                        "backend.authoring.agents.access.the-server-agent-access-token-file-is-invalid"
                    )
                )
        self.failures, self.lock = deque(), threading.Lock()

    def _signature(self, payload):
        return (
            base64.urlsafe_b64encode(
                hmac.new(
                    self.owner_token.encode(), payload.encode(), hashlib.sha256
                ).digest()
            )
            .decode()
            .rstrip("=")
        )

    def authorized(self, request: Request):
        authorization = request.headers.get("authorization", "")
        if authorization.startswith("Bearer ") and secrets.compare_digest(
            authorization[7:], self.owner_token
        ):
            return True
        session = request.cookies.get(COOKIE, "")
        try:
            expires, nonce, signature = session.split(".")
            return (
                int(expires) > time.time()
                and len(nonce) == 32
                and secrets.compare_digest(
                    signature, self._signature(f"{expires}.{nonce}")
                )
            )
        except (ValueError, TypeError):
            return False

    def require(self, request: Request):
        self.check_origin(request)
        if not self.authorized(request):
            raise HTTPException(
                401,
                msg(
                    "backend.authoring.agents.access.unlock-agent-settings-with-the-server-access-token-first"
                ),
            )

    def check_origin(self, request: Request):
        origin = request.headers.get("origin")
        if (
            request.headers.get("sec-fetch-site") == "cross-site"
            or origin
            and origin not in self.origins
        ):
            raise HTTPException(
                403,
                msg(
                    "backend.authoring.agents.access.access-the-code-agent-from-this-workspace"
                ),
            )

    def unlock(self, token):
        with self.lock:
            now = time.monotonic()
            while self.failures and self.failures[0] < now - 60:
                self.failures.popleft()
            if len(self.failures) >= 8:
                raise HTTPException(
                    429,
                    msg(
                        "backend.authoring.agents.access.too-many-unlock-attempts-try-again-later"
                    ),
                )
            if (
                not isinstance(token, str)
                or len(token) > 512
                or not secrets.compare_digest(token, self.owner_token)
            ):
                self.failures.append(now)
                raise HTTPException(
                    401,
                    msg(
                        "backend.authoring.agents.access.incorrect-server-access-token"
                    ),
                )
            self.failures.clear()
        payload = (
            f"{int(time.time()) + SESSION_SECONDS}.{secrets.token_hex(16)}"
        )
        return f"{payload}.{self._signature(payload)}"


if __name__ == "__main__":
    from ..config import Settings

    settings = Settings()
    access = AgentAccess(
        settings.data_dir / "agent" / "access.token",
        settings.agent_access_token.get_secret_value(),
    )
    print(access.owner_token)
