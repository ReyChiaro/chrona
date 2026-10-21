"""Small Chat Completions transport; no model names, credentials or vendor URLs in code."""

from chrona.infrastructure.i18n import msg
import json
import re
import time
from urllib.parse import urlsplit

import httpx

from chrona.authoring.agents.settings import AgentConfig


class AgentAPIError(ValueError):
    def __init__(self, message, *, status_code=None):
        super().__init__(message)
        self.status_code = status_code


class ChatClient:
    def __init__(self, config: AgentConfig, *, transport=None):
        self.config = config
        self.http = httpx.Client(
            transport=transport,
            follow_redirects=False,
            trust_env=urlsplit(config.base_url).hostname
            not in {"127.0.0.1", "localhost", "::1"},
        )
        self.deadline = time.monotonic() + config.timeout_seconds

    def close(self):
        self.http.close()

    def response_error(self, response):
        # Provider diagnostics are useful, but never return the credential or an unbounded response.
        chunks, remaining = [], 32768
        for chunk in response.iter_bytes():
            if time.monotonic() >= self.deadline:
                raise AgentAPIError(
                    msg(
                        "backend.authoring.agents.client.the-code-agent-reached-the-total-time-limit-for"
                    )
                )
            chunks.append(chunk[:remaining])
            remaining -= len(chunks[-1])
            if not remaining:
                break
        detail = ""
        try:
            body = json.loads(b"".join(chunks))
            error = body.get("error", {}) if isinstance(body, dict) else {}
            detail = (
                error.get("message", "") if isinstance(error, dict) else error
            )
        except (ValueError, TypeError):
            pass
        if not isinstance(detail, str):
            detail = ""
        if key := self.config.api_key.get_secret_value():
            detail = detail.replace(key, "[redacted]")
        detail = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [redacted]", detail)
        detail = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}", "[redacted]", detail)
        detail = re.sub(
            r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", detail
        )
        detail = re.sub(r"\s+", " ", detail).strip()[:600]
        labels = {
            400: msg(
                "backend.authoring.agents.client.the-model-api-rejected-the-request-parameters"
            ),
            401: msg(
                "backend.authoring.agents.client.the-api-key-is-invalid-or-expired"
            ),
            403: msg(
                "backend.authoring.agents.client.the-api-denied-access-check-model-permissions"
            ),
            404: msg(
                "backend.authoring.agents.client.the-api-path-or-model-does-not-exist"
            ),
            429: msg(
                "backend.authoring.agents.client.the-api-rate-limit-or-quota-was-exceeded"
            ),
        }
        message = msg(
            "backend.authoring.agents.client.http",
            p0=labels.get(
                response.status_code,
                msg(
                    "backend.authoring.agents.client.code-model-api-request-failed"
                ),
            ),
            p1=response.status_code,
        )
        return AgentAPIError(
            message + (f"：{detail}" if detail else ""),
            status_code=response.status_code,
        )

    def complete(self, messages, tools, *, tool_choice="auto"):
        if len(json.dumps(messages, ensure_ascii=False)) > 256000:
            raise AgentAPIError(
                msg(
                    "backend.authoring.agents.client.the-code-agent-tool-session-exceeded-its-context-budget"
                )
            )
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise AgentAPIError(
                msg(
                    "backend.authoring.agents.client.the-code-agent-reached-this-request-s-time-limit"
                )
            )
        base = self.config.base_url
        endpoint = (
            base
            if base.endswith("/chat/completions")
            else base + "/chat/completions"
        )
        headers = {"Accept": "application/json"}
        if key := self.config.api_key.get_secret_value():
            headers["Authorization"] = f"Bearer {key}"
        try:
            with self.http.stream(
                "POST",
                endpoint,
                headers=headers,
                json={
                    "model": self.config.model,
                    "messages": messages,
                    "tools": tools,
                    "tool_choice": tool_choice,
                },
                timeout=httpx.Timeout(remaining, connect=min(15, remaining)),
            ) as response:
                if response.status_code >= 300:
                    raise self.response_error(response)
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    if time.monotonic() >= self.deadline:
                        raise AgentAPIError(
                            msg(
                                "backend.authoring.agents.client.the-code-agent-reached-the-total-time-limit-for"
                            )
                        )
                    size += len(chunk)
                    if size > 2 * 1024 * 1024:
                        raise AgentAPIError(
                            msg(
                                "backend.authoring.agents.client.the-code-model-response-is-too-large"
                            )
                        )
                    chunks.append(chunk)
                value = json.loads(b"".join(chunks))
        except httpx.TimeoutException as error:
            raise AgentAPIError(
                msg(
                    "backend.authoring.agents.client.the-code-model-call-timed-out-no-scene-changes"
                )
            ) from error
        except httpx.HTTPError as error:
            raise AgentAPIError(
                msg(
                    "backend.authoring.agents.client.cannot-connect-to-the-code-model-api-check-the"
                )
            ) from error
        except (ValueError, TypeError) as error:
            if isinstance(error, AgentAPIError):
                raise
            raise AgentAPIError(
                msg(
                    "backend.authoring.agents.client.the-api-did-not-return-valid-chat-completions-json"
                )
            ) from error
        try:
            choice = value["choices"][0]
            if choice.get("finish_reason") == "length":
                raise AgentAPIError(
                    msg(
                        "backend.authoring.agents.client.the-model-output-was-truncated-reduce-object-complexity-or"
                    )
                )
            message = choice["message"]
            if not isinstance(message, dict):
                raise TypeError()
            # Preserve provider reasoning fields required by some compatible APIs.
            return message, value.get("usage", {})
        except (KeyError, IndexError, TypeError) as error:
            raise AgentAPIError(
                msg(
                    "backend.authoring.agents.client.the-api-response-is-missing-choices-0-message-check"
                )
            ) from error


def test_connection(config: AgentConfig, *, transport=None):
    if not config.configured:
        raise AgentAPIError(
            msg(
                "backend.authoring.agents.client.enter-an-api-url-and-model-name-first"
            )
        )
    tool = {
        "type": "function",
        "function": {
            "name": "connection_check",
            "description": "Check tool calling support without changing any world.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    }
    started = time.monotonic()
    client = ChatClient(config, transport=transport)
    try:
        # Match the real agent loop. Some reasoning modes allow tools but reject forced tool_choice.
        message, _ = client.complete(
            [
                {
                    "role": "user",
                    "content": "Call connection_check once. Do not generate scene content.",
                }
            ],
            [tool],
        )
        if not any(
            c.get("function", {}).get("name") == "connection_check"
            for c in message.get("tool_calls") or []
        ):
            raise AgentAPIError(
                msg(
                    "backend.authoring.agents.client.the-model-responded-without-tool-calls-select-a-model"
                )
            )
        return {
            "ok": True,
            "model": config.model,
            "protocol": "chat-completions",
            "latencyMs": round((time.monotonic() - started) * 1000),
        }
    finally:
        client.close()
