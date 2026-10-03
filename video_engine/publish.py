"""Register a built master + provenance with the platform authoring API (draft versions only).

    python publish.py examples/sample_topic.json out/ --api http://localhost:3000 --token $JWT --topic-id <uuid>

Uploads <topic_id>.<lang>.master.mp4 per language; interactions get absolute timestamps from scene offsets.
The platform re-checks checksum, stores provenance, and the asset then rides the normal faculty/admin approval.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import httpx
from manifest import Manifest


def interactions(m: Manifest) -> tuple[list[dict], float]:
    out, t = [], 0.0
    for s in m.scenes:
        for i, ix in enumerate(s.interactions):
            out.append({"id": f"{s.id}-{i}", "atSec": t + ix.at_sec, "kind": ix.kind, "prompt": ix.prompt,
                        "options": list(ix.branches), "required": ix.kind == "pause_quiz"})
        t += s.duration_sec
    return out, t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest"); ap.add_argument("out")
    ap.add_argument("--api", required=True); ap.add_argument("--token", required=True); ap.add_argument("--topic-id", required=True)
    ap.add_argument("--abr", action="store_true", help="after upload, ask the platform to build the adaptive (HLS) ladder from each master")
    a = ap.parse_args()
    m = Manifest.model_validate_json(Path(a.manifest).read_text())
    out = Path(a.out)
    ledger = json.loads((out / "provenance.json").read_text())
    ix, dur = interactions(m)
    h = {"Authorization": f"Bearer {a.token}"}
    with httpx.Client(base_url=a.api, headers=h, timeout=600) as c:
        for lang in m.languages:
            master = out / f"{m.topic_id}.{lang}.master.mp4"
            if not master.exists():
                raise SystemExit(f"missing {master} (build with ffmpeg installed)")
            r = c.post(f"/v1/authoring/topics/{a.topic_id}/assets", json={
                "language": lang, "durationSec": dur, "interactions": ix,
                "provenance": {"tool": "video_engine", "topic": m.topic_id, "ledger": ledger, "sources": sorted({x for s in m.scenes for x in s.sources})},
                "rights": {"generated": True}})
            r.raise_for_status(); asset = r.json()["id"]
            data = master.read_bytes()
            u = c.put(f"/v1/authoring/assets/{asset}/files/master", content=data,
                      headers={"content-type": "application/octet-stream", "x-checksum-sha256": hashlib.sha256(data).hexdigest()})
            u.raise_for_status(); print(f"{lang}: asset {asset} uploaded")
            for label, name, mime in (('captions', f"{m.topic_id}.{lang}.captions.vtt", 'text/vtt'), ('transcript', f"{m.topic_id}.{lang}.transcript.txt", 'text/plain')):
                f = out / name
                if f.exists():
                    blob = f.read_bytes()
                    c.put(f"/v1/authoring/assets/{asset}/files/{label}", content=blob, headers={"content-type": "application/octet-stream", "x-checksum-sha256": hashlib.sha256(blob).hexdigest()}).raise_for_status(); print(f"{lang}: {label} uploaded")
            if a.abr:  # the platform builds 240p to 1080p renditions (never upscaling) in its worker; poll GET /v1/authoring/assets/<id>/renditions
                c.post(f"/v1/authoring/assets/{asset}/transcode").raise_for_status(); print(f"{lang}: adaptive build queued")


if __name__ == "__main__":
    main()
