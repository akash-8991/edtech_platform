"""Captions (WebVTT) and a plain transcript from the reviewed narration: the platform requires a transcript for every mandatory video and
shows synchronised captions when they exist. Timing comes from each scene's duration (the narration is paced to fill the scene), split
into cues of at most two short lines, so captions need no speech recognition and can be produced before any video exists."""
from __future__ import annotations
import re
from manifest import Manifest

MAX_LINE = 42          # characters per caption line (broadcast guideline for readable captions)
MAX_LINES = 2
MIN_CUE_SEC = 1.2


def _ts(sec: float) -> str:
    ms = round(sec * 1000)
    h, ms = divmod(ms, 3_600_000); m, ms = divmod(ms, 60_000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _sentences(text: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?।])\s+", text.strip()) if p.strip()]
    return parts or [text.strip()]


def _wrap(text: str) -> list[str]:
    """Greedy word wrap to MAX_LINE; a word longer than the line stays whole."""
    lines, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > MAX_LINE:
            lines.append(cur); cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur: lines.append(cur)
    return lines


def _chunks(sentence: str) -> list[str]:
    """One cue is at most MAX_LINES lines: a long sentence becomes several cues, never a wall of text."""
    lines, out = _wrap(sentence), []
    for i in range(0, len(lines), MAX_LINES):
        out.append("\n".join(lines[i:i + MAX_LINES]))
    return out


def cues(m: Manifest, lang: str) -> list[tuple[float, float, str]]:
    out, t0 = [], 0.0
    for s in m.scenes:
        text = s.narration[lang]
        pieces = [c for sent in _sentences(text) for c in _chunks(sent)]
        weights = [max(1, len(re.sub(r"\s+", "", p))) for p in pieces]; total = sum(weights)
        at = t0
        for p, w in zip(pieces, weights):
            d = s.duration_sec * w / total
            out.append((at, min(t0 + s.duration_sec, at + max(d, 0.0)), p)); at += d
        t0 += s.duration_sec
    # a cue shorter than MIN_CUE_SEC is unreadable: hold it up to the next cue's start
    fixed = []
    for i, (a, b, p) in enumerate(out):
        nxt = out[i + 1][0] if i + 1 < len(out) else b
        fixed.append((a, max(b, min(a + MIN_CUE_SEC, nxt)), p))
    return fixed


def webvtt(m: Manifest, lang: str) -> str:
    body = [f"{i}\n{_ts(a)} --> {_ts(b)}\n{p}\n" for i, (a, b, p) in enumerate(cues(m, lang), 1)]
    return "WEBVTT\n\n" + "\n".join(body)


def transcript(m: Manifest, lang: str) -> str:
    return "\n\n".join(s.narration[lang].strip() for s in m.scenes) + "\n"
