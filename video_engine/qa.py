"""Automated pre-review checks (TRD §8). Human faculty review is still mandatory."""
from __future__ import annotations
from manifest import Manifest

PROHIBITED = ["guaranteed placement", "100% pass"]


def run_qa(m: Manifest) -> list[str]:
    issues = [f"unreachable scene: {s}" for s in m.unreachable_scenes()]
    for s in m.scenes:
        for lang, text in s.narration.items():
            low = text.lower()
            issues += [f"{s.id}/{lang}: prohibited term '{p}'" for p in PROHIBITED if p in low]
            # ~2.5 words/sec speaking rate; flag narration that overruns the scene
            if lang == "en" and len(text.split()) / 2.5 > s.duration_sec * 1.3:
                issues.append(f"{s.id}: narration too long for {s.duration_sec}s")
        for i in s.interactions:
            if i.at_sec > s.duration_sec:
                issues.append(f"{s.id}: interaction at {i.at_sec}s beyond scene end")
        if not s.sources:
            issues.append(f"{s.id}: no source references (provenance)")
    return issues
