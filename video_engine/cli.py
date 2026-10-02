"""python cli.py build examples/sample_topic.json --out out/ [--mock] [--force-qa]"""
from __future__ import annotations
import argparse, json
from pathlib import Path
from manifest import Manifest
from pipeline import build


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "qa"])
    ap.add_argument("manifest")
    ap.add_argument("--out", default="out")
    ap.add_argument("--mock", action="store_true", help="no API calls, no spend")
    ap.add_argument("--force-qa", action="store_true")
    a = ap.parse_args()
    m = Manifest.model_validate_json(Path(a.manifest).read_text())
    if a.cmd == "qa":
        from qa import run_qa
        print("\n".join(run_qa(m)) or "QA clean"); return
    if a.mock:
        from providers.mock import MockVideo, MockTTS
        video, tts = MockVideo(), MockTTS()
    else:
        from providers.higgsfield import HiggsfieldProvider
        from providers.tts import ElevenLabsTTS
        video, tts = HiggsfieldProvider(), ElevenLabsTTS()
    print(json.dumps(build(m, Path(a.out), video, tts, a.force_qa), indent=2))


if __name__ == "__main__":
    main()
