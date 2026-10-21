"""Versioned, local LoRA catalog and model-neutral job adapter selections."""

from chrona.infrastructure.i18n import msg
import hashlib
import json
from pathlib import Path
import struct

from pydantic import BaseModel, Field


from chrona.protocol.generated import AdapterSelection


def resolve_adapters(selections, capabilities):
    catalog = capabilities.get("adapters") or {}
    if not selections:
        return []
    if len(selections) > catalog.get("maxActive", 0):
        raise ValueError(
            msg(
                "backend.adapters.lora.the-number-of-selected-lora-adapters-exceeds-this-model"
            )
        )
    items = {item["id"]: item for item in catalog.get("items", [])}
    result, seen = [], set()
    for selection in selections:
        identifier, scale = selection["id"], selection["scale"]
        if identifier in seen:
            raise ValueError(
                msg(
                    "backend.adapters.lora.the-same-lora-adapter-cannot-be-selected-twice"
                )
            )
        seen.add(identifier)
        if identifier not in items:
            raise ValueError(
                msg(
                    "backend.adapters.lora.a-lora-adapter-was-removed-or-is-unavailable-refresh"
                )
            )
        if not 0 <= scale <= catalog.get("maxScale", 2):
            raise ValueError(
                msg(
                    "backend.adapters.lora.lora-strength-exceeds-this-model-s-supported-range"
                )
            )
        result.append({**items[identifier], "scale": scale})
    return result


class LocalLoraCatalog:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self._cache = {}

    def _describe(self, path, *, refresh=False):
        stat = path.stat()
        stamp = (stat.st_size, stat.st_mtime_ns)
        cached = self._cache.get(path)
        if cached and cached[0] == stamp and not refresh:
            return cached[1]
        # Read only the safetensors header here; tensor shape/target checks remain with the model loader.
        with path.open("rb") as stream:
            size = stream.read(8)
            if len(size) != 8:
                raise ValueError(
                    msg("backend.adapters.lora.invalid-safetensors-file")
                )
            length = struct.unpack("<Q", size)[0]
            if not 0 < length <= min(16 * 1024 * 1024, stat.st_size - 8):
                raise ValueError(
                    msg("backend.adapters.lora.invalid-safetensors-header")
                )
            header = json.loads(stream.read(length))
        keys = [key for key in header if key != "__metadata__"]
        namespaced = keys and all(
            "lora" in key
            and key.startswith(("transformer.", "transformer_ref."))
            for key in keys
        )
        peft = keys and all(
            key.endswith((".lora_A.default.weight", ".lora_B.default.weight"))
            for key in keys
        )
        if not (namespaced or peft):
            raise ValueError(
                msg(
                    "backend.adapters.lora.a-supported-minimax-h3-diffusers-or-original-peft-transformer"
                )
            )
        fingerprint = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                fingerprint.update(chunk)
        relative = path.relative_to(self.root).as_posix()
        item = {
            "id": hashlib.sha256(relative.encode()).hexdigest()[:24],
            "label": relative,
            "sha256": fingerprint.hexdigest(),
            "kind": "lora",
        }
        self._cache[path] = (stamp, item)
        return item

    def capabilities(self):
        items, warnings = [], []
        if self.root.is_dir():
            for path in sorted(self.root.rglob("*.safetensors")):
                if not path.is_file() or not path.resolve().is_relative_to(
                    self.root
                ):
                    continue
                try:
                    items.append(self._describe(path))
                except (ValueError, OSError, TypeError) as error:
                    warnings.append(f"{path.relative_to(self.root)}: {error}")
        return {
            "maxActive": 4,
            "maxScale": 2,
            "items": items,
            "warnings": warnings,
        }

    def files(self, adapters):
        candidates = {}
        for path in self.root.rglob("*.safetensors"):
            if path.is_file() and path.resolve().is_relative_to(self.root):
                identifier = hashlib.sha256(
                    path.relative_to(self.root).as_posix().encode()
                ).hexdigest()[:24]
                candidates[identifier] = path
        result = []
        for item in adapters:
            path = candidates.get(item["id"])
            if (
                path is None
                or self._describe(path, refresh=True)["sha256"]
                != item["sha256"]
            ):
                raise ValueError(
                    msg(
                        "backend.adapters.lora.lora-weights-have-changed-restore-the-original-file-to"
                    )
                )
            result.append((item, path))
        return result


class LoraSession:
    """Never fuse adapters into the base model; switching jobs restores its original weights."""

    def __init__(self, catalog):
        self.catalog, self.active = catalog, []

    def apply(self, pipeline, adapters, report):
        files = self.catalog.files(adapters)
        if self.active == adapters:
            return
        if self.active:
            pipeline.unload_lora_weights()
            self.active = []
            report(
                msg(
                    "backend.adapters.lora.removed-lora-from-the-previous-task"
                ),
                event="model.lora.cleared",
                stage="loading",
            )
        if not adapters:
            return
        names = []
        try:
            for index, (item, path) in enumerate(files):
                name = f"adapter_{index}_{item['sha256'][:12]}"
                report(
                    msg("backend.adapters.lora.loading-lora"),
                    event="model.lora.loading",
                    stage="loading",
                    adapter=item,
                    loadPath=str(path),
                )
                pipeline.load_lora_weights(
                    str(path.parent),
                    weight_name=path.name,
                    adapter_name=name,
                    load_into_transformer_ref=True,
                    local_files_only=True,
                    use_safetensors=True,
                )
                if name not in pipeline.get_list_adapters().get(
                    "transformer_ref", []
                ):
                    raise ValueError(
                        msg(
                            "backend.adapters.lora.lora-did-not-match-the-reference-video-transformer-check"
                        )
                    )
                names.append(name)
            pipeline.set_adapters(
                names, adapter_weights=[item["scale"] for item in adapters]
            )
            self.active = [dict(item) for item in adapters]
            report(
                msg("backend.adapters.lora.lora-loaded-for-this-task"),
                event="model.lora.ready",
                stage="loading",
                adapters=adapters,
            )
        except Exception:
            pipeline.unload_lora_weights()
            self.active = []
            raise
