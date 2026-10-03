# Video engine: turning a script into a lesson video

`video_engine/` is a separate Python tool. The platform's AI content factory produces a **script manifest** (scenes, narration, on-screen text, in-video questions, in English and Hindi); the engine turns it into per-scene video and voice, composes a review master per language, and records provenance. The result is uploaded to the platform as a **draft** asset and goes through the normal faculty/admin approval before any learner sees it.

```
platform: AI topic job ──► script manifest ──► video_engine: QA gate ──► scenes (Higgsfield) + voice (TTS)
                                                         └──► review master per language (ffmpeg) + provenance ledger
                                                                              │
                      faculty + admin approval ◄── draft asset ◄── publish.py (checksum verified by the platform)
```

**Maturity: prototype.** Verified: manifest validation, QA gate, mock pipeline, unit tests (4 pass). **Never run against the real Higgsfield or ElevenLabs services**, and **Captions (WebVTT) and a transcript are now produced for every language** (`captions.py`, written next to the masters and uploaded by `publish.py`). Adaptive-bitrate (HLS) packaging is done **by the platform** after upload (`publish.py --abr`; see [Adaptive video](07-adaptive-video.md)). Not yet built: lip-synced avatar scenes, a review UI. The platform's accessibility rule needs a **transcript** for every mandatory video, which you must still supply (the narration text in the manifest is the source).

## 1. Install

```bash
cd video_engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
brew install ffmpeg            # macOS;  Debian/Ubuntu: sudo apt install ffmpeg
python -m pytest -q tests      # 4 passed
```

Without `ffmpeg`, the build still runs but reports `skipped (ffmpeg not installed)` for the masters.

## 2. Try it without any account (mock mode, no spend)

```bash
python cli.py qa examples/sample_topic.json                       # content/safety QA gate -> "QA clean"
python cli.py build examples/sample_topic.json --out out/ --mock  # placeholder scenes + silent voice, composed into out/*.mp4 if ffmpeg exists
```

The output folder holds per-scene assets, one master per language (`<topic>.<lang>.master.mp4`) and a provenance ledger recording the provider, model, prompt and time of every generated asset (the platform stores this with the asset, required for AI-generated content).

## 3. Real generation

```bash
cp .env.example .env     # then fill in the values below and load them:  set -a; source .env; set +a
```

| Variable | Meaning |
|---|---|
| `HF_KEY` | Higgsfield credentials `key-id:key-secret` from cloud.higgsfield.ai |
| `HF_T2V_MODEL`, `HF_I2V_MODEL` | model endpoint ids for text-to-video / image-to-video. **Config, not code**, so a model change or vendor swap needs no deploy. Check each model's argument names in the Higgsfield docs (https://docs.higgsfield.ai/docs/models.md). |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_EN`, `ELEVENLABS_VOICE_HI` | optional text-to-speech (multilingual model for Hindi) |

```bash
python cli.py build examples/sample_topic.json --out out/          # real calls: costs money; run the mock first
python cli.py build topic.json --out out/ --force-qa               # continue despite QA findings (recorded; use sparingly)
```

Providers are swappable (`providers/base.py`); add a class implementing the same interface and select it in `cli.py` to use another video or voice service. The QA gate runs before any spend and blocks scripts with unsafe or unsupported content.

## 4. The full path with the platform

Run the platform ([local setup](01-local-setup.md)), sign in as an author and set `TOKEN`:

```bash
export API=http://localhost:3000
TOKEN=$(curl -s -X POST $API/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"author@synthetic.test","password":"Dev-Only-Pass1"}' | jq -r .accessToken)
TOPIC=<topic uuid from your draft course version>

# 1. the platform generates the script (needs AI keys, see the user guide §3.1), then:
python fetch_manifest.py --api $API --token $TOKEN --topic-id $TOPIC > topic.json      # downloads the latest generated manifest

# 2. check, then build
python cli.py qa topic.json
python cli.py build topic.json --out out/ --mock          # drop --mock for real generation

# 3. upload the masters as a DRAFT asset (checksum is verified server-side; interactions get absolute timestamps from scene offsets)
python publish.py topic.json out/ --api $API --token $TOKEN --topic-id $TOPIC
```

Then the asset rides the standard approval (author → faculty → approver; user guide §3): it cannot reach learners until a version containing it is published. Tokens expire after 15 minutes; sign in again if a long build outlives it.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `masters: skipped (ffmpeg not installed)` | install ffmpeg |
| `QA` issues listed | edit the script manifest (or the topic in the platform) and rebuild; `--force-qa` records an override |
| `401` from `fetch_manifest.py`/`publish.py` | the token expired, or the user lacks the author role |
| `404 ... manifest` | no completed AI topic job for that topic yet (check `GET /v1/ai/jobs`) |
| `409` on publish | the topic's version is no longer a DRAFT (frozen in review or published): create a new version |
