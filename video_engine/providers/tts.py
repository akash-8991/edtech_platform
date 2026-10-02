from __future__ import annotations
import os
from pathlib import Path
import httpx


class ElevenLabsTTS:
    name = "elevenlabs"

    def __init__(self):
        self.key = os.environ["ELEVENLABS_API_KEY"]
        self.voices = {"en": os.environ["ELEVENLABS_VOICE_EN"], "hi": os.environ["ELEVENLABS_VOICE_HI"]}

    def speak(self, text, lang, out: Path):
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{self.voices[lang]}",
            headers={"xi-api-key": self.key},
            json={"text": text, "model_id": "eleven_multilingual_v2"}, timeout=120)
        r.raise_for_status()
        out.write_bytes(r.content)
        return {"provider": self.name, "voice": self.voices[lang], "model": "eleven_multilingual_v2"}
