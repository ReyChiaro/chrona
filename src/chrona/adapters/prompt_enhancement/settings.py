from chrona.infrastructure.i18n import msg
import json
import os
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class EnhancementConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    enabled: bool = False
    base_url: str = Field(
        "https://api.minimax.cn", alias="baseUrl", max_length=2000
    )
    model: str = Field("MiniMax-H3", min_length=1, max_length=200)
    api_key: SecretStr = Field(
        default_factory=lambda: SecretStr(""), alias="apiKey", repr=False
    )
    timeout_seconds: int = Field(300, alias="timeoutSeconds", ge=15, le=900)
    poll_seconds: float = Field(
        3, alias="pollSeconds", ge=1, le=30, allow_inf_nan=False
    )

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value):
        value = value.strip().rstrip("/")
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
                    "backend.adapters.prompt_enhancement.settings.the-api-url-must-use-http-s-and-contain"
                )
            )
        return value

    @field_validator("model")
    @classmethod
    def valid_model(cls, value):
        if not value.strip():
            raise ValueError(
                msg(
                    "backend.adapters.prompt_enhancement.settings.the-model-name-cannot-be-empty"
                )
            )
        return value.strip()

    @field_validator("api_key")
    @classmethod
    def valid_key(cls, value):
        text = value.get_secret_value().strip()
        if len(text) > 4096 or any(ord(c) < 32 for c in text):
            raise ValueError(
                msg(
                    "backend.adapters.prompt_enhancement.settings.invalid-api-key-format"
                )
            )
        return SecretStr(text)

    @property
    def configured(self):
        return bool(self.api_key.get_secret_value())

    def identity(self):
        return {
            "provider": "minimax-context-ir",
            "baseUrl": self.base_url,
            "model": self.model,
        }

    def public(self):
        return {
            **self.identity(),
            "enabled": self.enabled,
            "configured": self.configured,
            "hasApiKey": self.configured,
            "timeoutSeconds": self.timeout_seconds,
            "pollSeconds": self.poll_seconds,
        }


class EnhancementUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    baseUrl: str = Field(max_length=2000)
    model: str = Field(min_length=1, max_length=200)
    apiKey: SecretStr | None = Field(None, repr=False)
    clearApiKey: bool = False
    timeoutSeconds: int = Field(300, ge=15, le=900)
    pollSeconds: float = Field(3, ge=1, le=30, allow_inf_nan=False)


class EnhancementStore:
    """Only the private server settings file contains the credential."""

    def __init__(self, settings):
        self.path = settings.data_dir / "prompt-enhancement" / "settings.json"
        self.lock = threading.RLock()
        self.value = (
            EnhancementConfig.model_validate_json(self.path.read_text())
            if self.path.exists()
            else EnhancementConfig(
                enabled=settings.prompt_enhancement_enabled,
                baseUrl=settings.prompt_enhancement_base_url,
                model=settings.prompt_enhancement_model,
                apiKey=settings.prompt_enhancement_api_key,
                timeoutSeconds=settings.prompt_enhancement_timeout_seconds,
                pollSeconds=settings.prompt_enhancement_poll_seconds,
            )
        )

    def snapshot(self):
        with self.lock:
            return self.value.model_copy(deep=True)

    def prepare(self, update):
        with self.lock:
            previous = self.value
            key = (
                update.apiKey.get_secret_value().strip()
                if update.apiKey
                else ""
            )
            base = update.baseUrl.strip().rstrip("/")
            if (
                base != previous.base_url
                and previous.configured
                and not key
                and not update.clearApiKey
            ):
                raise ValueError(
                    msg(
                        "backend.adapters.prompt_enhancement.settings.enter-a-new-key-or-clear-the-saved-key"
                    )
                )
            value = EnhancementConfig(
                enabled=update.enabled,
                baseUrl=base,
                model=update.model,
                apiKey=""
                if update.clearApiKey
                else key or previous.api_key.get_secret_value(),
                timeoutSeconds=update.timeoutSeconds,
                pollSeconds=update.pollSeconds,
            )
            if value.enabled and not value.configured:
                raise ValueError(
                    msg(
                        "backend.adapters.prompt_enhancement.settings.configure-a-prompt-enhancement-api-key-first"
                    )
                )
            return value

    def save(self, update):
        with self.lock:
            value = self.prepare(update)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(f".settings-{uuid.uuid4()}.tmp")
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
