"""manifest -> per-scene clips + voice -> review master + provenance ledger.

Per-scene cache keys make partial regeneration cheap: editing one scene regenerates only that scene (VID-005),
and prior versions are kept, never overwritten (TRD §8).
"""
from __future__ import annotations
import hashlib, json, shutil, subprocess
from pathlib import Path
from manifest import Manifest, Scene
from qa import run_qa


def _h(*a) -> str:
    return hashlib.sha256(json.dumps(a, sort_keys=True).encode()).hexdigest()[:12]


def build(m: Manifest, out_dir: Path, video, tts, force_qa: bool = False) -> dict:
    issues = run_qa(m)
    if issues and not force_qa:
        raise SystemExit("QA failed:\n  " + "\n  ".join(issues))
    out_dir.mkdir(parents=True, exist_ok=True)
    ledger, masters = [], {}
    for lang in m.languages:
        parts = []
        for s in m.scenes:
            vclip = out_dir / "assets" / f"{s.id}.{_h(s.visual_prompt, s.reference_image, s.duration_sec)}.v.mp4"
            aclip = out_dir / "assets" / f"{s.id}.{_h(s.narration[lang], m.glossary)}.{lang}.mp3"
            vclip.parent.mkdir(exist_ok=True)
            if not vclip.exists():  # visual is language-neutral: reuse across en/hi
                meta = video.generate(s.visual_prompt, vclip, s.duration_sec, s.reference_image)
                ledger.append({"scene": s.id, "kind": "video", "file": vclip.name, **meta, "sources": s.sources})
            if not aclip.exists():
                text = _apply_glossary(s.narration[lang], m.glossary)
                meta = tts.speak(text, lang, aclip)
                ledger.append({"scene": s.id, "kind": "audio", "lang": lang, "file": aclip.name, **meta})
            parts.append((vclip, aclip))
        masters[lang] = _compose(parts, out_dir / f"{m.topic_id}.{lang}.master.mp4")
    (out_dir / "provenance.json").write_text(json.dumps(ledger, indent=2))
    return {"masters": masters, "qa_issues": issues, "assets": len(ledger)}


def _apply_glossary(text: str, glossary: dict[str, str]) -> str:
    for term, locked in glossary.items():
        text = text.replace(term, locked)
    return text


def _compose(parts, out: Path) -> str:
    if not shutil.which("ffmpeg"):
        return "skipped (ffmpeg not installed)"
    segs = []
    for i, (v, a) in enumerate(parts):
        seg = out.parent / f"_seg{i}.mp4"
        subprocess.run(["ffmpeg", "-y", "-i", str(v), "-i", str(a), "-map", "0:v", "-map", "1:a",
                        "-c:v", "libx264", "-c:a", "aac", "-shortest", str(seg)], check=True, capture_output=True)
        segs.append(seg)
    lst = out.parent / "_concat.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in segs))
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)],
                   check=True, capture_output=True)
    return str(out)
