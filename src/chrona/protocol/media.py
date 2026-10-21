from typing import Protocol
from pathlib import Path
from .generated import *


class RenderProvider(Protocol):
    """All vendor-specific model APIs stay behind this interface."""
    def load(self, *, report=None) -> None: ...
    def render(self, *, video: Path, prompt: str, parameters: dict, output: Path, progress) -> dict: ...
    def unload(self) -> None: ...
