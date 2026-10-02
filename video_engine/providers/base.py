from __future__ import annotations
from pathlib import Path
from typing import Protocol


class VideoProvider(Protocol):
    name: str
    def generate(self, prompt: str, out: Path, duration: float, image: str | None = None) -> dict:
        """Write a clip to `out`; return provenance metadata (model, request id, params)."""


class TTSProvider(Protocol):
    name: str
    def speak(self, text: str, lang: str, out: Path) -> dict: ...
