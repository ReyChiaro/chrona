"""Canonical messages, shared catalogs and request-local HTTP presentation.

Domain values remain English. Only explicitly marked machine fields are
localized; user prompts, names, recipes and historical evidence stay intact.
"""

import json
import re
import threading
from collections import OrderedDict
from contextvars import ContextVar
from functools import lru_cache

from chrona.infrastructure.resources import resource

DEFAULT_LOCALE = "en"
LOCALE_REGISTRY = json.loads(
    resource("locales/registry.json").read_text(encoding="utf-8")
)
LOCALES = {
    locale["code"]: locale["enabled"] for locale in LOCALE_REGISTRY["locales"]
}
_request_locale = ContextVar("chrona_request_locale", default=DEFAULT_LOCALE)
_emitted = OrderedDict()
_lock = threading.RLock()
_machine_fields = {
    "error",
    "detail",
    "message",
    "phase",
    "summary",
    "providerError",
    "samplingNote",
    "failures",
    "warnings",
    "unsupported",
}


@lru_cache(maxsize=2)
def catalog(locale="en"):
    return json.loads(
        resource(f"locales/{locale}.json").read_text(encoding="utf-8")
    )


def normalize_locale(value=None):
    tag = str(value or "").strip().replace("_", "-").lower()
    aliases = sorted(
        (
            (alias.lower(), locale)
            for locale in LOCALE_REGISTRY["locales"]
            for alias in locale["aliases"]
        ),
        key=lambda item: len(item[0]),
        reverse=True,
    )
    for alias, locale in aliases:
        if tag == alias or tag.startswith(alias + "-"):
            return locale["code"] if locale["enabled"] else DEFAULT_LOCALE
    return DEFAULT_LOCALE


def negotiate_locale(header=None):
    candidates = []
    for index, item in enumerate(str(header or "").split(",")):
        tag, *options = item.strip().split(";")
        try:
            quality = next(
                (
                    float(x.strip()[2:])
                    for x in options
                    if x.strip().startswith("q=")
                ),
                1.0,
            )
        except ValueError:
            quality = 0
        if 0 < quality <= 1:
            candidates.append((quality, -index, tag))
    for _, _, tag in sorted(candidates, reverse=True):
        if re.match(r"^en(?:-|$)|^zh(?:-(?:hans|cn|sg)(?:-|$)|$)", tag, re.I):
            return normalize_locale(tag)
    return DEFAULT_LOCALE


def format_message(key, params=None, locale="en"):
    params = params or {}
    template = catalog(normalize_locale(locale)).get(
        key, catalog().get(key, key)
    )

    def replace(match):
        name = match[1]
        if name not in params:
            return match[0]
        value = params[name]
        if (
            isinstance(value, dict)
            and isinstance(value.get("key"), str)
            and value["key"] in catalog()
        ):
            return format_message(value["key"], value.get("params"), locale)
        return "" if value is None else str(value)

    return re.sub(r"\{([a-zA-Z]\w*)\}", replace, template)


def _parameter(value):
    if isinstance(value, Message):
        return value.descriptor
    if isinstance(value, BaseException):
        message = error_message(value)
        return message.descriptor if isinstance(message, Message) else message
    if isinstance(value, dict):
        return {str(key): _parameter(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_parameter(child) for child in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


class Message(str):
    def __new__(cls, key, params=None):
        params = _parameter(params or {})
        instance = super().__new__(cls, format_message(key, params))
        instance.descriptor = {"key": key, "params": params or {}}
        return instance

    def __reduce__(self):
        return Message, (self.descriptor["key"], self.descriptor["params"])


def msg(key, **params):
    if key not in catalog():
        raise KeyError(f"Unknown message key: {key}")
    value = Message(key, params)
    with _lock:
        _emitted[str(value)] = value.descriptor
        if len(_emitted) > 8192:
            _emitted.popitem(last=False)
    return value


def describe(value):
    if isinstance(value, Message):
        return value.descriptor
    if isinstance(value, str):
        with _lock:
            return _emitted.get(value)
    return None


def error_message(error):
    """Preserve a typed message when a built-in exception wraps it."""
    if getattr(error, "args", None) and isinstance(error.args[0], Message):
        return error.args[0]
    return str(error)


def annotate_payload(value, locale="en"):
    """Attach message descriptors without translating user content."""
    if isinstance(value, list):
        return [annotate_payload(item, locale) for item in value]
    if not isinstance(value, dict):
        return value
    result = {
        key: annotate_payload(child, locale)
        for key, child in value.items()
        if key != "_i18n"
    }
    metadata = dict(value.get("_i18n") or {})
    for field, child in value.items():
        if field == "_i18n":
            continue
        descriptor = metadata.get(field)
        # A Message is an explicit marker, even for labels; ordinary labels are user data.
        if isinstance(child, Message) or field in _machine_fields:
            if isinstance(child, str):
                previous = descriptor if isinstance(descriptor, dict) else None
                descriptor = describe(child) or (
                    previous
                    if previous
                    and any(
                        format_message(
                            previous["key"], previous.get("params"), language
                        )
                        == child
                        for language in ("en", "zh-Hans")
                    )
                    else None
                )
                if not descriptor:
                    metadata.pop(field, None)
                if descriptor:
                    metadata[field] = descriptor
                    result[field] = format_message(
                        descriptor["key"], descriptor.get("params"), locale
                    )
            elif isinstance(child, list):
                old = descriptor if isinstance(descriptor, list) else []
                descriptors = []
                for i, text in enumerate(child):
                    previous = old[i] if i < len(old) else None
                    matches = (
                        isinstance(previous, dict)
                        and isinstance(text, str)
                        and any(
                            format_message(
                                previous["key"],
                                previous.get("params"),
                                language,
                            )
                            == text
                            for language in ("en", "zh-Hans")
                        )
                    )
                    descriptors.append(
                        describe(text) or (previous if matches else None)
                    )
                if any(descriptors):
                    metadata[field] = descriptors
                    result[field] = [
                        format_message(item["key"], item.get("params"), locale)
                        if item
                        else text
                        for text, item in zip(child, descriptors)
                    ]
                else:
                    metadata.pop(field, None)
            else:
                metadata.pop(field, None)
        label_key = value.get(field + "Key")
        if isinstance(label_key, str) and label_key in catalog():
            metadata[field] = {"key": label_key}
            result[field] = format_message(label_key, locale=locale)
    if metadata:
        result["_i18n"] = metadata
    return result


def install_i18n(app):
    from fastapi.responses import JSONResponse
    from starlette.exceptions import HTTPException

    @app.middleware("http")
    async def language_context(request, call_next):
        token = _request_locale.set(
            negotiate_locale(request.headers.get("accept-language"))
        )
        try:
            response = await call_next(request)
            response.headers["Content-Language"] = _request_locale.get()
            vary = response.headers.get("Vary", "")
            response.headers["Vary"] = ", ".join(
                filter(None, [vary, "Accept-Language"])
            )
            return response
        finally:
            _request_locale.reset(token)

    @app.exception_handler(HTTPException)
    async def localized_http_error(request, error):
        body = {"detail": error.detail}
        descriptor = describe(error.detail)
        if descriptor:
            body.update(
                code=descriptor["key"], params=descriptor.get("params", {})
            )
        return LocalizedJSONResponse(
            body, status_code=error.status_code, headers=error.headers
        )


from fastapi.responses import JSONResponse


class LocalizedJSONResponse(JSONResponse):
    def render(self, content):
        return super().render(annotate_payload(content, _request_locale.get()))
