# EdTech learning-delivery platform

An AI-assisted, multidisciplinary learning-delivery platform: governed course authoring and publishing, admissions-to-entitlement, gated learning with verified video progress, an AI content factory, a grounded AI tutor and doubt centre, AI-assisted grading with human moderation, labs, proctored exams, and a tamper-evident audit trail, built on a modular NestJS monolith with PostgreSQL.

> **Status: server side complete, not production-launched.** All seven build phases are implemented and tested (360+ automated tests against a real PostgreSQL). **Only a first slice of the learner web client exists** (`platform/web`: sign-in, courses, video with verified watch time, quiz, assignment, notifications, doubts, tutor); there is no mobile app and no staff console. AI providers, the proctoring vendor, the identity provider and the code sandbox have only been run against test doubles. See [`platform/docs/release/gate-evidence.md`](platform/docs/release/gate-evidence.md) for the honest status of every launch gate.

## Where to start

| I want to... | Read |
|---|---|
| run it on my machine in 15 minutes | [Local setup](platform/docs/guides/01-local-setup.md) |
| deploy it to the cloud | [Cloud deployment (AWS reference)](platform/docs/guides/02-cloud-deployment.md) |
| use it as an author, admin, teacher or learner | [User guide](platform/docs/guides/03-user-guide.md) |
| look up a setting | [Configuration reference](platform/docs/guides/04-configuration-reference.md) |
| produce lesson videos | [Video engine](platform/docs/guides/05-video-engine.md) |
| find an endpoint | [API reference](platform/docs/guides/api-reference.md) (all 202 routes and who may call them) |
| understand the design | [Architecture](platform/docs/architecture.md), [decision log](platform/docs/decision-log.md), [traceability](platform/docs/traceability.md) |
| run it in production | [Runbooks](platform/docs/ops/runbooks.md), [SLOs and alerts](platform/docs/ops/slo-and-alerts.md), [DR plan](platform/docs/ops/dr-plan.md), [migrations](platform/docs/ops/migrations.md), [scaling](platform/docs/ops/scaling.md), [key rotation](platform/docs/security/key-rotation.md) |
| review security and privacy | [Threat model](platform/docs/security/threat-model.md), [security review](platform/docs/security/security-review.md), [privacy data map](platform/docs/privacy/data-map-and-retention.md) |

## Repository layout

```
platform/
  api/             NestJS 11 + Prisma 6 + PostgreSQL 16 service (API and background worker), tests, scripts
  web/             learner web client, first slice (React + Vite)
  docs/            guides, architecture, security, privacy, operations, release evidence, quality (coverage)
  ops/             Prometheus alert rules, Grafana dashboard
  docker-compose*.yml   local stack (and a MinIO + ClamAV overlay)
video_engine/      Python media pipeline: script manifest -> scenes + voice -> review master (Higgsfield / ElevenLabs / mock)
```

## Quick start (native)

```bash
git clone https://github.com/akash-8991/edtech_platform.git && cd edtech_platform/platform
# PostgreSQL 16 on :5433 (see the local setup guide for the 5 commands), then:
cd api && cp .env.example .env && npm ci && npx prisma generate && npx prisma migrate deploy && npm run db:seed
npm run dev                                                   # http://localhost:3000
export DATABASE_URL=postgresql://edtech:edtech@localhost:5433/edtech
BASE=http://localhost:3000 npm run walkthrough                # end-to-end check: WALKTHROUGH OK (31 checks passed)
```

Or with Docker only: `cd platform && docker compose up -d --build`.

## Principles the code enforces

Synthetic data only outside production · server-side gating (clients never decide access) · maker-checker for publication, overrides and access changes · append-only, hash-chained audit and exam evidence · no AI-generated learner content without human approval · the institute owns all code and data · no launch with critical security findings, missing auditability, an untested restore, or unapproved AI content.

## License and ownership

Copyright the institute commissioning this work. No open-source license is granted by this repository; add the institute's chosen license before sharing outside the organisation.
