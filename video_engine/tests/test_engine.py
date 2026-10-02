import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pytest
from manifest import Manifest
from pipeline import build
from qa import run_qa
from providers.mock import MockVideo, MockTTS

SAMPLE = Path(__file__).resolve().parents[1] / "examples" / "sample_topic.json"


def load():
    return Manifest.model_validate_json(SAMPLE.read_text())


def test_sample_qa_clean():
    assert run_qa(load()) == []


def test_missing_hindi_rejected():
    d = json.loads(SAMPLE.read_text()); d["scenes"][0]["narration"].pop("hi")
    with pytest.raises(Exception):
        Manifest.model_validate(d)


def test_unreachable_scene_flagged():
    d = json.loads(SAMPLE.read_text())
    d["scenes"][0]["interactions"] = [{"kind": "pause_quiz", "at_sec": 1, "prompt": "q", "branches": {"x": "s1"}}]
    d["scenes"].append({**d["scenes"][1], "id": "s3"})
    m = Manifest.model_validate(d)
    assert "s3" not in m.unreachable_scenes()  # reachable by sequential flow


def test_build_caches_partial_regen(tmp_path):
    m = load()
    r1 = build(m, tmp_path, MockVideo(), MockTTS())
    assert r1["assets"] == 2 + 4  # 2 videos (shared across langs) + 4 audio
    r2 = build(m, tmp_path, MockVideo(), MockTTS())
    assert r2["assets"] == 0
    m.scenes[1].visual_prompt = "changed"
    r3 = build(m, tmp_path, MockVideo(), MockTTS())
    assert r3["assets"] == 1  # only the changed scene's video; audio untouched
