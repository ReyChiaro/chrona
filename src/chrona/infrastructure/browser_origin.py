"""Reject cross-site browser requests without requiring a login or access token."""

from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from chrona.infrastructure.i18n import msg


class BrowserOriginGuard:
    def __init__(self, browser_origin: str):
        origin = urlsplit(browser_origin)
        self.origins = {f"{origin.scheme}://{origin.netloc}"}
        if origin.hostname in {"127.0.0.1", "localhost"}:
            port = origin.port or (443 if origin.scheme == "https" else 80)
            self.origins.update(
                f"{origin.scheme}://{host}:{port}"
                for host in ["127.0.0.1", "localhost"]
            )

    def __call__(self, request: Request) -> None:
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (
            origin and origin not in self.origins
        ):
            raise HTTPException(
                403,
                msg(
                    "backend.infrastructure.browser_origin.access-this-service-from-this-workspace"
                ),
            )
