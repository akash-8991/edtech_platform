"""Offline providers so the pipeline, QA and tests run with no keys or spend."""
from __future__ import annotations
import subprocess, shutil
from pathlib import Path


class MockVideo:
    name = "mock"
    def generate(self, prompt, out: Path, duration, image=None):
        if shutil.which("ffmpeg"):
            subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=0x1e3a5f:s=1280x720:d={duration}",
                            "-pix_fmt", "yuv420p", str(out)], check=True, capture_output=True)
        else:
            out.write_bytes(b"MOCKVIDEO")
        return {"provider": "mock", "prompt": prompt}


class MockTTS:
    name = "mock"
    def speak(self, text, lang, out: Path):
        out.write_bytes(b"MOCKAUDIO")
        return {"provider": "mock", "lang": lang}
