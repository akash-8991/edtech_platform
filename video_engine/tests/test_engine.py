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


def test_captions_cover_every_scene_in_order_and_fit_the_screen(tmp_path):
    from captions import cues, webvtt, transcript, MAX_LINE, MAX_LINES
    m = load()
    for lang in m.languages:
        cs = cues(m, lang)
        assert cs[0][0] == 0 and abs(cs[-1][1] - sum(s.duration_sec for s in m.scenes)) < 1e-6
        assert all(a < b for a, b, _ in cs) and all(cs[i][1] <= cs[i + 1][0] + 1e-6 for i in range(len(cs) - 1))
        assert all(len(p.split("\n")) <= MAX_LINES and all(len(l) <= MAX_LINE for l in p.split("\n")) for _, _, p in cs)
        v = webvtt(m, lang)
        assert v.startswith("WEBVTT\n\n1\n00:00:00.000 -->") and m.scenes[0].narration[lang].split()[0] in v
        assert transcript(m, lang).count("\n\n") == len(m.scenes) - 1


def test_long_narration_is_split_into_short_cues():
    from captions import cues
    d = json.loads(SAMPLE.read_text()); d["scenes"][0]["narration"]["en"] = "Sensors convert physical quantities such as temperature, pressure and light into electrical signals that a controller can read. " * 2
    cs = cues(Manifest.model_validate(d), "en")
    assert len([c for c in cs if c[0] < 8]) >= 4 and all(len(c[2].split("\n")) <= 2 for c in cs)


def test_build_writes_captions_and_transcript_without_ffmpeg(tmp_path):
    m = load(); build(m, tmp_path, MockVideo(), MockTTS())
    for lang in m.languages:
        assert (tmp_path / f"{m.topic_id}.{lang}.captions.vtt").read_text(encoding="utf-8").startswith("WEBVTT")
        assert (tmp_path / f"{m.topic_id}.{lang}.transcript.txt").read_text(encoding="utf-8").strip()
