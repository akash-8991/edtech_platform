# EdTech learning-delivery platform

Phase 1 foundation (see docs/). `video_engine/` is the separate media tooling prototype.

## Run locally
    cd api && cp .env.example .env && npm i
    # Postgres 16 on :5433 (db: edtech, edtech_test)
    npx prisma generate && npx prisma migrate deploy && npm run db:seed
    npm run dev          # http://localhost:3000   GET /health
    npm test             # unit + e2e (needs Postgres + edtech_test migrated)

Note: npm 11 blocks install scripts; run `npx prisma generate` manually.

## API (v1)
Auth `POST /v1/auth/login` | Admissions `POST /v1/admissions/applications` (HMAC), `POST /v1/applications/import`,
`POST /v1/applications/:id/decision` | Entitlements `/v1/entitlements/:id/{pause,resume,exceptions,revoke,access}`, `/v1/me/entitlements` |
Authoring `/v1/authoring/...` (versions, transition, comments, clone) | Catalogue `/v1/catalogue` | Audit `/v1/audit`, `/v1/audit/verify`

## Phase 2 API additions
Learner: `GET /v1/me/entitlements/:id/progress`, `GET /v1/topics/:id`, `GET /v1/topics/:id/playback?mode=low`, `POST /v1/learning-events` (batch, offline-safe),
`POST /v1/topics/:id/quiz/start`, `POST /v1/quiz-attempts/:id/submit`, `PUT /v1/topics/:id/assignment/upload`, `POST /v1/topics/:id/assignment/submit`,
`/v1/offline/{devices,licenses}`, `/v1/me/notifications` | Authoring: `PUT /v1/authoring/topics/:id/{quiz,assignment}`, `POST .../topics/:id/assets`, `PUT .../assets/:id/files/:label` |
Admin: `POST /v1/entitlements/:id/progression-overrides`, `GET /v1/reports/progress`.
Env: `MEDIA_ROOT`, `MEDIA_TOKEN_SECRET`, `OFFLINE_MASTER_KEY` (64 hex chars; KMS in prod), `OFFLINE_DAYS`.
Media from `video_engine`: `python publish.py <manifest> <out> --api ... --token ... --topic-id ...`.

## Phase 3 API additions (AI content factory)
`POST /v1/ai/curriculum-jobs`, `POST /v1/ai/topic-jobs` (async, 202) | `GET /v1/ai/jobs[/:id]`, `POST /v1/ai/jobs/:id/cancel` |
`GET /v1/ai/quality?versionId`, `POST /v1/ai/quality/:id/resolve` | `GET|POST /v1/ai/prompts...` (draft, evaluate, approve) | `GET /v1/ai/usage` |
`GET|PUT /v1/admin/config[/:key]` (kill switch, budget, glossary, prohibited terms, productivity tools) |
`GET /v1/authoring/versions/:id/diff?against=`, `GET /v1/authoring/topics/:id/manifest`.
Setup: see `.env.example` (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENROUTER_MODEL). Live check: `npm run ai:smoke`.
Pipeline: generate topic -> `video_engine/fetch_manifest.py` -> `video_engine/cli.py build` -> `video_engine/publish.py`.

## Phase 4 API additions (grounded tutor + doubt centre)
Learner: `POST /v1/tutor/ask`, `GET /v1/tutor/conversations[/:id]`, `POST /v1/tutor/messages/:id/feedback`, `POST /v1/tutor/conversations/:id/escalate`,
`POST /v1/doubts`, `GET /v1/me/doubts[/:id]`, `POST /v1/me/doubts/:id/{messages,reopen,rating,appointments}`, `PUT /v1/doubts/upload`, `GET /v1/topics/:id/remediation` |
Teacher: `GET /v1/teacher/tickets[/:id]`, `POST .../{claim,reply,resolve,propose-faq}`, `GET /v1/teacher/appointments`, `POST /v1/teacher/appointments/:id/confirm`, `GET|PUT /v1/teacher/profile` |
Admin: `PUT /v1/doubt-centre/teachers/:userId`, `POST /v1/doubt-centre/tickets/:id/reassign`, `POST /v1/doubt-centre/sweep`, `POST|GET /v1/tutor/index/:versionId`,
`POST /v1/tutor/benchmark`, `GET|POST /v1/faq[...]`, `GET /v1/reports/{tutor,doubts}`. New config keys: `tutor.min_relevance`, `tutor.auto_escalate`, `tutor.per_minute`, `doubt.sla_minutes`, `doubt.max_teachers`.

## Phase 5 API additions (grading, moderation, appeals)
Learner: `GET /v1/me/submissions[/:id]`, `POST /v1/me/submissions/:id/appeal` (submit is unchanged: `POST /v1/topics/:id/assignment/submit`, now graded asynchronously) |
Authoring: `GET|PUT /v1/authoring/topics/:id/assignment-policy` |
Moderation: `GET /v1/moderation/queue`, `POST /v1/moderation/tasks/:id/{claim,release,decide}`, `GET /v1/moderation/tasks/:id` |
Admin: `POST /v1/grading/submissions/:id/{overrides,complete}`, `POST /v1/grading/overrides/:id/decide`, `GET /v1/grading/submissions/:id/history`, `POST /v1/grading/{benchmark,sweep}`, `GET /v1/reports/grading`; progression override type `DEADLINE_EXTENSION` (hours).
Config keys: `grading.*` (sample rate, confidence default, appeal window, similarity threshold, agreement tolerance/min, max AI attempts). Sandbox: `SANDBOX_MODE=docker`.
Note: raw SQL time comparisons must use `(${date} AT TIME ZONE 'UTC')` (see D-053).

## Phase 6 API additions (labs, exams, proctoring)
Labs: `PUT /v1/authoring/versions/:id/labs/:code`, `POST /v1/labs/slots[/:id/cancel]`, `GET /v1/labs/slots/:id/{roster,qr}`, `POST /v1/labs/slots/:id/attendance`, `GET /v1/me/labs`, `POST /v1/labs/{activities/:id/ack,slots/:id/book,bookings/:id/cancel,attendance,bookings/:id/evidence}`, `PUT /v1/labs/evidence/upload` |
Exam admin: `POST /v1/exams/bank/:programmeId/questions`, `POST /v1/exams`, `/v1/exams/:id/{publish,sessions,eligibility-overrides}`, `POST /v1/exams/accommodations`, `POST /v1/exams/integrity-cases/:submissionId/resolve` |
Learner: `GET /v1/me/exams`, `POST /v1/exams/:id/register`, `POST /v1/exam-sessions/:id/check-in`, `/v1/exam-attempts/:id/{device-check,start,resume,answers,signals,submit}`, `GET /v1/me/exam-attempts/:id`, `POST /v1/me/exam-attempts/:id/appeal`, `GET /v1/me/completion` |
Ops: `POST /v1/proctoring/webhook` (signed), `POST /v1/proctor/attempts/:id/{verify-id,incidents}`, `GET /v1/exam-ops/{incidents,status,appeals}`, `/v1/exam-ops/attempts/:id/{case,verify-log,outcome,release,waive-report,result}`, `POST /v1/exam-ops/incidents/:id/decide`, `POST /v1/exam-ops/sessions/:id/release-ready`, `POST /v1/exam-ops/appeals/:id/decide`, `GET /v1/incidents/:id/evidence`, `GET /v1/reports/exams`.
Vendor contract: `docs/proctor-provider-contract.md`. New role: `LAB_COORDINATOR`.

## Phase 7 (hardening) - what to read
`docs/release/gate-evidence.md` (honest status of every gate), `docs/security/*` (threat model + internal review), `docs/privacy/*`,
`docs/ops/*` (runbooks, SLOs, DR plan), `docs/capacity-model.md` + `docs/perf/` (measurements), `docs/dr/` (drill reports), `docs/accessibility.md`,
`docs/architecture.md`, `docs/release/rollout-and-pilot.md`.
Commands (in `api/`): `npm run loadtest` (needs `npm run build`), `npm run inventory` (after intentional API changes), `bash scripts/dr/restore-drill.sh`,
`npx ts-node scripts/audit-bench.ts`. Auth: `POST /v1/auth/{login,mfa/verify,mfa/enroll/start,mfa/enroll/confirm,refresh,logout,password}`, `GET /v1/auth/sso/{start,callback}`,
`GET|DELETE /v1/me/sessions`; privacy: `/v1/me/{consents,preferences,privacy/requests}`, `/v1/privacy/*`; ops: `GET /health/ready`, `/metrics`, `/v1/ops/integrity`.
