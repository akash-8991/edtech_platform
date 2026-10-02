# Video Engine (EdTech platform, TRD §8 / FRD VID-001..007)

manifest (JSON scenes) -> QA gate -> per-scene video (Higgsfield) + voice (TTS, en/hi) -> review master + provenance ledger.
Hand off to the platform's transcoding/HLS/DRM stage after faculty + admin approval.

    pip install -r requirements.txt
    brew install ffmpeg            # needed to compose masters
    python cli.py build examples/sample_topic.json --mock     # no keys, no spend
    cp .env.example .env           # add HF_KEY + model ids, then drop --mock

Providers are swappable (`providers/base.py`); Higgsfield model endpoint ids live in env.
Check each model's argument names at https://docs.higgsfield.ai/docs/models.md.
Not yet built: scene-level lip-synced avatar, captions (SRT), HLS/offline packaging, review UI.
