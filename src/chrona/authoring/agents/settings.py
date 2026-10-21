from chrona.infrastructure.i18n import msg
import json
import os
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)


class AgentConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    enabled: bool = True
    base_url: str = Field("", alias="baseUrl", max_length=2000)
    model: str = Field("", max_length=200)
    api_key: SecretStr = Field(
        default_factory=lambda: SecretStr(""), alias="apiKey"
    )
    timeout_seconds: int = Field(180, alias="timeoutSeconds", ge=15, le=300)
    max_rounds: int = Field(8, alias="maxRounds", ge=2, le=16)

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value):
        value = value.strip().rstrip("/")
        if value:
            url = urlsplit(value)
            if (
                url.scheme not in {"http", "https"}
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
            ):
                raise ValueError(
                    msg(
                        "backend.authoring.agents.settings.the-api-url-must-use-http-s-and-contain"
                    )
                )
        return value

    @field_validator("model")
    @classmethod
    def trim_model(cls, value):
        return value.strip()

    @property
    def configured(self):
        return bool(self.base_url and self.model)

    @property
    def mode(self):
        return (
            "disabled"
            if not self.enabled
            else "api"
            if self.configured
            else "unconfigured"
        )

    def public(self):
        return {
            "enabled": self.enabled,
            "baseUrl": self.base_url,
            "model": self.model,
            "hasApiKey": bool(self.api_key.get_secret_value()),
            "timeoutSeconds": self.timeout_seconds,
            "maxRounds": self.max_rounds,
            "configured": self.configured,
            "mode": self.mode,
            "protocol": "chat-completions",
        }


class AgentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    baseUrl: str = Field(max_length=2000)
    model: str = Field(max_length=200)
    apiKey: SecretStr | None = None
    clearApiKey: bool = False
    timeoutSeconds: int = Field(180, ge=15, le=300)
    maxRounds: int = Field(8, ge=2, le=16)

    @model_validator(mode="after")
    def valid_secret(self):
        if self.apiKey and len(self.apiKey.get_secret_value()) > 4096:
            raise ValueError(
                msg(
                    "backend.authoring.agents.settings.the-key-exceeds-the-length-limit"
                )
            )
        return self


class AgentConfigStore:
    """Secrets stay on the server; a complete immutable snapshot is captured per run."""

    def __init__(self, path: Path, initial: AgentConfig):
        self.path, self.lock = path, threading.RLock()
        self.value = (
            AgentConfig.model_validate_json(path.read_text())
            if path.exists()
            else initial
        )

    def snapshot(self):
        with self.lock:
            return self.value.model_copy(deep=True)

    def prepare(self, update: AgentUpdate):
        with self.lock:
            previous = self.value
            key = (
                update.apiKey.get_secret_value().strip()
                if update.apiKey
                else ""
            )
            # Do not silently send a retained credential to a different destination.
            if (
                update.baseUrl.strip().rstrip("/") != previous.base_url
                and previous.api_key.get_secret_value()
                and not key
                and not update.clearApiKey
            ):
                raise ValueError(
                    msg(
                        "backend.authoring.agents.settings.enter-a-new-key-or-select-clear-saved-key"
                    )
                )
            value = AgentConfig(
                enabled=update.enabled,
                baseUrl=update.baseUrl,
                model=update.model,
                apiKey=""
                if update.clearApiKey
                else key or previous.api_key.get_secret_value(),
                timeoutSeconds=update.timeoutSeconds,
                maxRounds=update.maxRounds,
            )
            if value.enabled and not value.configured:
                raise ValueError(
                    msg(
                        "backend.authoring.agents.settings.a-code-model-requires-an-api-url-and-model"
                    )
                )
            return value

    def save(self, update: AgentUpdate):
        with self.lock:
            value = self.prepare(update)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(f".{uuid.uuid4()}.tmp")
            payload = value.model_dump(mode="json", by_alias=True)
            payload["apiKey"] = value.api_key.get_secret_value()
            try:
                fd = os.open(
                    temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
                )
                with os.fdopen(fd, "w") as output:
                    json.dump(payload, output, ensure_ascii=False, indent=2)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(self.path)
                os.chmod(self.path, 0o600)
            finally:
                temporary.unlink(missing_ok=True)
            self.value = value
            return value.public()
