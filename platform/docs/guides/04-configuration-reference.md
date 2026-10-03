# Configuration reference

Two kinds of configuration:

1. **Environment variables**: read when a process starts. Set them in `platform/api/.env` for local development (the app loads it automatically, only outside production, and a variable already set in the real environment always wins), or in your orchestrator / secret store in production. Changing one needs a restart.
2. **Runtime settings**: stored in the database, changed live through `PUT /v1/admin/config/<key>` (audited, type-checked). No restart.

> **Production refuses to start** if the configuration is unsafe: placeholder or short secrets, missing Redis, local storage, the no-op scanner, no `PROCESS_ROLE`, wildcard CORS, MFA or rate limiting disabled. The exact list is in `platform/api/src/platform/config-guard.ts` and is shown in the error message.

`R` in the *Prod* column = required in production, `-` = optional.

---

## Core

| Variable | Default | Prod | Meaning |
|---|---|---|---|
| `NODE_ENV` | (unset) | R `production` | `production` turns on every hardening rule (guard, HSTS, MFA, consent, accessibility, JSON logs). Never run production without it. |
| `PORT` | `3000` | - | API listen port. |
| `DATABASE_URL` | - | R | PostgreSQL 16 URL, e.g. `postgresql://user:pass@host:5432/edtech`. With PgBouncer see [Database scaling](#database-scaling). |
| `PROCESS_ROLE` | `all` | R `api` or `worker` | `api` = HTTP only; `worker` (via `node dist/src/worker.js`) = queue and sweeps only; `all` = both in one process (local development). Production refuses `all`. |
| `WORKER_HEALTH_PORT` | `3001` | - | Worker liveness (`/health`) and `/metrics` port. |
| `CORS_ORIGINS` | (empty) | R (or `CORS_NONE=1`) | Comma-separated exact browser origins allowed to call the API, e.g. `https://learn.institute.edu`. Never `*`. |
| `CORS_NONE` | - | - | Set `1` when no browser calls the API directly (so CORS may be empty). |
| `TRUST_PROXY` | `0` | R behind a proxy | Number of reverse-proxy hops in front of the API (ALB/nginx = `1`). Needed so rate limits and logs see the real client IP. |
| `JSON_BODY_LIMIT` | `2mb` | - | Max JSON request size. |
| `UV_THREADPOOL_SIZE` | `8` | - | libuv threads (password hashing, file I/O). |
| `LOG_JSON` / `REQUEST_LOG` / `SPAN_LOG` / `LOG_LEVEL` | prod: on | - | JSON logs; one access-log line per request; one line per external call (span); `LOG_LEVEL=debug` for debug lines. All logs are redacted (emails, phones, IDs, tokens). |

## Secrets and keys

Generate each with `openssl rand -base64 48` (secrets) or `openssl rand -hex 32` (keys). Each needs a real random value in production (24-32+ characters; placeholders such as `change-me`, `dev-only` are refused).

| Variable | Prod | Meaning |
|---|---|---|
| `JWT_SECRET` | R | Signs access tokens and MFA/enrolment tokens. |
| `ADMISSIONS_HMAC_SECRET` | R | Shared with the admissions system; signs inbound application webhooks. |
| `MEDIA_TOKEN_SECRET` | R | Signs playback/stream URLs. |
| `EXAM_RECEIPT_SECRET` | R | Exam receipt codes and the pseudonymous learner id sent to the proctoring vendor. **Cannot be rotated without a vendor re-mapping.** |
| `LAB_QR_SECRET` | R | Signs lab attendance QR codes. |
| `METRICS_TOKEN` | R | Bearer token required by `/metrics`. |
| `DATA_ENC_KEY` | R | 64 hex chars (256-bit). Encrypts TOTP seeds and privacy-export keys at rest. |
| `OFFLINE_MASTER_KEY` | R | 64 hex chars. Wraps offline-package content keys. |
| `*_PREVIOUS` | - | `JWT_SECRET_PREVIOUS`, `MEDIA_TOKEN_SECRET_PREVIOUS`, `LAB_QR_SECRET_PREVIOUS`, `DATA_ENC_KEY_PREVIOUS`, `OFFLINE_MASTER_KEY_PREVIOUS`: retired values (comma-separated) still accepted for verification/decryption during a rotation. See [key rotation](../security/key-rotation.md). |
| `SECRETS_MANAGER_SECRET_ID` | - | AWS Secrets Manager secret holding a JSON object of any of the variables above. Loaded before startup; values there win over plain environment variables; startup fails if it cannot be read. Region from `AWS_REGION` (default `ap-south-1`). |

## Authentication and security

| Variable | Default | Meaning |
|---|---|---|
| `MFA_ENFORCE` | on in production | Force TOTP for all non-learner roles. `0` is refused in production; set `1` locally to rehearse MFA. |
| `MFA_ISSUER` | `EdTech Platform` | Name shown in authenticator apps. |
| `RATE_LIMIT_DISABLED` | - | `1` disables rate limits (tests only; refused in production). |
| `RL_IP_PER_MIN` / `RL_ACTOR_PER_MIN` / `RL_LOGIN_PER_MIN` | `3000` / `1200` / `20` | Per-IP, per-user and per-IP sign-in limits per minute. Shared across instances through Redis. |
| `HASH_CONCURRENCY` | `4` | Concurrent password hashes (CPU-bound). |
| `SESSION_CACHE_MS` | `5000` | Fallback delay for a revoked session to stop working on other instances (immediate when Redis is configured). |
| `SEGREGATION_OF_DUTIES` | `true` | Maker-checker: the same person cannot author and approve. `false` only for single-person demos. |
| `BODY_MAX_DEPTH` / `BODY_MAX_NODES` / `BODY_MAX_ARRAY` | `12` / `50000` / `5000` | Structural limits applied to every JSON body. |

### Single sign-on

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER` | Identity provider issuer URL (discovery is read from `<issuer>/.well-known/openid-configuration`). |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | OAuth client of this platform at the provider. |
| `OIDC_REDIRECT_URI` | Must equal the callback registered at the provider. For the web app that is **`https://<web-host>/sso/callback`** (the page hands the one-time code to `GET /v1/auth/sso/callback` on the API). A non-browser client may register `https://<api-host>/v1/auth/sso/callback` instead. |
| `OIDC_LABEL` | Name on the sign-in button: "Sign in with <label>" (default "your institute account"). |
| `OIDC_MFA_AMR` | Comma list of `amr` values that count as multi-factor (default `mfa,otp,hwk`); staff sign-in is refused without one. |

## Shared state, storage, scanning

| Variable | Default | Prod | Meaning |
|---|---|---|---|
| `REDIS_URL` | - | R | e.g. `redis://host:6379` (or `rediss://` for TLS). Shared rate limits and instant session revocation. Without it, limits are per instance. |
| `STORAGE_DRIVER` | `local` | R `s3` | `local` writes under `MEDIA_ROOT` (single host only); `s3` for any S3-compatible store. |
| `MEDIA_ROOT` | `./.media` | - | Local-driver directory. |
| `S3_BUCKET` | - | R | Bucket name (private; block public access). |
| `S3_REGION` | `ap-south-1` | - | Region. |
| `S3_KMS_KEY_ID` | - | R (AWS) | KMS key for SSE-KMS. Omit only for S3-compatible stores that reject the header (MinIO). |
| `S3_ENDPOINT` | - | - | Custom endpoint for MinIO or another S3-compatible store (enables path-style addressing). |
| `S3_PREFIX` | (empty) | - | Key prefix inside the bucket. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | - | - | Static credentials (local/MinIO only). On AWS use the task/instance IAM role instead. |
| `SCANNER` | `noop` | R `clamav` | `clamav` scans every learner upload with clamd. The no-op scanner marks everything clean and is refused in production. Scanner failure rejects the upload (503); it never accepts. |
| `CLAMD_HOST` / `CLAMD_PORT` | - / `3310` | R / - | clamd address. |
| `CLAMD_TIMEOUT_MS` | `20000` | - | Scan timeout. |
| `SCAN_MAX_BYTES` | `26214400` | - | Largest file scanned inline (25 MB). Larger staff-authored video masters are stored but recorded `skipped_oversize` in the audit trail. |

## Database scaling

| Variable | Default | Meaning |
|---|---|---|
| `DB_CONNECTION_LIMIT` | Prisma default | Per-process pool size. Size so `instances × limit` fits the database/pooler. |
| `DB_POOL_TIMEOUT` | Prisma default (10 s) | Seconds to wait for a free connection. |
| `DB_PGBOUNCER` | `0` | `1` when `DATABASE_URL` points at PgBouncer in **transaction** mode. Run migrations against the direct URL. |
| `DATABASE_REPLICA_URL` | - | Optional read replica for heavy reports (falls back to the primary if it fails). |

## AI

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Enables the Anthropic route. |
| `AI_ANTHROPIC_MODEL` | `claude-opus-5-5` | Model id for that route. |
| `OPENROUTER_API_KEY` | - | Enables the OpenRouter route (used as fallback, or alone). |
| `OPENROUTER_MODEL` | - | OpenRouter model slug (no default is assumed). |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Override for a proxy. |
| `OPENROUTER_EMBED_MODEL` | - | Optional embeddings model for tutor retrieval (otherwise lexical retrieval is used). |
| `AI_ROUTES_JSON` | - | Per-use-case route overrides; every `provider:model` must be allow-listed (`AI_MODEL_ALLOWLIST`, comma-separated, in addition to the defaults). |
| `AI_RATE_PER_HOUR` | `200` | Model-call rate limit per actor per hour. |
| `AI_RETRY_BASE_MS` | `500` | Backoff base for provider retries. |
| `AI_KILL_SWITCH` | - | Start-up value for the kill switch (runtime setting `ai.kill_switch` is preferred). |
| `AI_WORKER` | `1` | `0` stops the in-process job worker (use for API-only processes; `PROCESS_ROLE=api` does this automatically). |
| `AI_WORKER_CONCURRENCY` / `AI_WORKER_POLL_MS` | `3` / `2000` | Jobs run in parallel per worker / poll interval. |

Check connectivity and cost after setting keys: `cd platform/api && npm run ai:smoke`.

## Assessment, exams, proctoring

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_MODE` | `disabled` | `docker` runs untrusted learner code in a locked-down container (needs a Docker daemon reachable by the worker). Untrusted code never runs in the API process. |
| `SANDBOX_IMAGE_PYTHON` | `python:3.12-alpine` | Image for the Python sandbox (**pin a digest in production**; required when the sandbox is on). |
| `PROCTOR_BASE_URL`, `PROCTOR_API_KEY` | - | Proctoring vendor REST endpoint and key. Unset = in-process **mock** (development only). |
| `PROCTOR_WEBHOOK_SECRET` | R if vendor set | Verifies signed vendor webhooks (HMAC). |
| `ACCESSIBILITY_ENFORCE` | on in production | Block review of mandatory video without transcripts/text alternatives. |
| `PRIVACY_ENFORCE_CONSENT` | on in production | Require recorded consent (e.g. for the AI tutor). |
| `PRIVACY_NOTICE_VERSION` | `2026-10` | Version recorded with consents; bump it when the notice changes to re-collect consent. |

## Entitlement policy and learning

| Variable | Default | Meaning |
|---|---|---|
| `POLICY_MAX_PAUSES` | `2` | Pauses allowed per entitlement. |
| `POLICY_MAX_PAUSED_DAYS` | `60` | Total paused days allowed. |
| `POLICY_PAUSE_NOTICE_DAYS` | `0` | Notice required before a pause. |
| `OFFLINE_DAYS` | `7` | Offline licence lifetime. |
| `HLS_TTL_MIN` | `180` | How long one playback's adaptive-stream tokens last (minutes). |
| `FFMPEG_BIN`, `FFPROBE_BIN` | `ffmpeg`, `ffprobe` | Media tools the worker runs for adaptive builds. |
| `TRANSCODE_TIMEOUT_MIN` | `90` | Time limit per ffmpeg/ffprobe call. |
| `CONTRACT_ENFORCE` | `0` (tests: `1`) | Validate every response and request body against its API contract (tests only; no cost in production). |
| `OPENAPI_RECORD` | unset | File to append observed API traffic to, for `npm run contracts:infer`. |
| `STRUCT_CACHE_MS` | `600000` | Cache of published course structure (published versions are immutable). |

## Limits, jobs and maintenance

| Variable | Default | Meaning |
|---|---|---|
| `INTAKE_MAX_BATCH` | `1000` | Applications per import call. |
| `REPORT_CSV_MAX_ROWS` | `100000` | Row cap for CSV exports (audited, flagged if truncated). |
| `IDEMPOTENCY_TTL_HOURS` / `IDEMPOTENCY_STALE_MS` | `24` / `120000` | How long replay keys live / when a crashed in-flight request may be taken over. |
| `INTEGRITY_CHECK_HOURS` | `6` | Worker's scheduled whole-database integrity check interval. |

## Runtime settings (`PUT /v1/admin/config/<key>`)

`GET /v1/admin/config` returns the live values. Roles: `PLATFORM_ADMIN`, `SUPER_ADMIN` (and `ACADEMIC_ADMIN` for academic keys).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ai.kill_switch` | boolean | `false` | Stops every model call immediately. |
| `ai.daily_budget_usd` | number | `100` | Hard daily AI spend cap. |
| `ai.prohibited_terms` | string[] | `[]` | Extra phrases that block generated content. |
| `ai.glossary` | map | `{}` | English technical term → locked Hindi rendering. |
| `tutor.min_relevance` | number | `0.4` | Minimum retrieval relevance before the tutor may answer. |
| `tutor.auto_escalate` | boolean | `true` | Open a doubt ticket automatically when the tutor cannot help. |
| `tutor.per_minute` | number | `6` | Tutor questions per learner per minute. |
| `doubt.sla_minutes` | map | `{P1:60,P2:240,P3:1440}` | First-response SLA by priority. |
| `doubt.max_teachers` | number | `50` | Maximum active doubt-centre teachers. |
| `grading.sample_rate` | number | `0.1` | Share of auto-finalised AI grades also sent to faculty QA. |
| `grading.default_confidence_threshold` | number | `0.8` | Minimum confidence to auto-finalise an AI grade. |
| `grading.appeal_window_days` | number | `7` | Days to appeal a released grade. |
| `grading.similarity_threshold` | number | `0.5` | Similarity that raises an integrity flag. |
| `grading.agreement_tolerance_pct` | number | `10` | AI vs human scores within this many points count as agreeing. |
| `grading.min_agreement` | number | `0.8` | Minimum agreement rate for a grader benchmark pass. |
| `grading.max_ai_attempts` | number | `5` | AI retries before a submission goes to a human. |
| `exam.change_freeze` | boolean | `false` | Blocks exam, session and bank edits during an exam window. |
| `exam.checkin_early_minutes` | number | `15` | How early a learner may check in. |
| `exam.appeal_window_days` | number | `7` | Days to appeal an affected exam result. |
| `exam.device_min_bandwidth_kbps` | number | `500` | Minimum bandwidth in the device check. |
| `lab.cancel_before_hours` | number | `24` | Latest lab booking cancellation. |
| `security.max_sessions` | number | `5` | Concurrent sessions per user (oldest revoked beyond). |
| `security.session_days` | number | `30` | Absolute learner session lifetime. |
| `security.privileged_session_hours` | number | `12` | Absolute staff session lifetime. |
| `retention.notifications_days` | number | `180` | Delete old notifications. |
| `retention.tutor_days` | number | `365` | Redact tutor conversations after the last message. |
| `retention.webhook_days` | number | `90` | Delete proctor webhook payloads. |
| `retention.export_days` | number | `7` | Delete data-export bundles. |
| `retention.sessions_days` | number | `90` | Delete expired/revoked session records. |
| `productivity_tools` | string[] | `[]` | Tools the platform may reference in generated content. |

Retention values are placeholders pending the institute's retention schedule (see the open items in [`../decision-log.md`](../decision-log.md)).

---

## Example: a complete production environment (values are placeholders)

```bash
NODE_ENV=production
PROCESS_ROLE=api                       # the worker deployment sets PROCESS_ROLE=worker
DATABASE_URL=postgresql://edtech_app:***@edtech-db.xxxx.ap-south-1.rds.amazonaws.com:5432/edtech?sslmode=require
REDIS_URL=rediss://edtech-redis.xxxx.cache.amazonaws.com:6379
STORAGE_DRIVER=s3
S3_BUCKET=institute-edtech-prod
S3_REGION=ap-south-1
S3_KMS_KEY_ID=arn:aws:kms:ap-south-1:111122223333:key/xxxxxxxx
SCANNER=clamav
CLAMD_HOST=clamav.edtech.internal
CORS_ORIGINS=https://learn.institute.edu,https://admin.institute.edu
TRUST_PROXY=1
SECRETS_MANAGER_SECRET_ID=edtech/prod/app      # JWT_SECRET, ADMISSIONS_HMAC_SECRET, MEDIA_TOKEN_SECRET, EXAM_RECEIPT_SECRET,
                                               # LAB_QR_SECRET, METRICS_TOKEN, DATA_ENC_KEY, OFFLINE_MASTER_KEY, API keys ...
```
