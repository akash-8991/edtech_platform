# Local setup: run the platform on your machine

Goal: a running API with a database, seeded synthetic users, and a passing end-to-end walkthrough, in about 15 minutes. Everything here uses **synthetic data only**; never point a local setup at real learner data.

Two ways to run it. Pick one:

| | Path A: native | Path B: Docker Compose |
|---|---|---|
| Best for | developing and debugging the code | trying it quickly, or mirroring production components |
| You install | Node, PostgreSQL, (Redis) | Docker only |
| Verified | yes (macOS) | yes (macOS, Docker 29): image builds, stack starts, walkthrough passes |

---

## 1. Prerequisites

| Tool | Version | Check | Install (macOS / Debian-Ubuntu) |
|---|---|---|---|
| Node.js | 22 or newer (tested on 22 in CI and 26 locally) | `node -v` | `brew install node` / use [nvm](https://github.com/nvm-sh/nvm): `nvm install 22` |
| npm | 10+ | `npm -v` | ships with Node |
| PostgreSQL | **16** | `psql --version` | `brew install postgresql@16` / `sudo apt install postgresql-16` |
| Redis | 7 (optional locally, required in production) | `redis-server --version` | `brew install redis` / `sudo apt install redis-server` |
| curl, jq, uuidgen | any | `jq --version` | `brew install jq` / `sudo apt install jq curl uuid-runtime` |
| Docker | 24+ (Path B, optional sandbox) | `docker version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Python 3.11 + ffmpeg | only for the [video engine](05-video-engine.md) | `python3 -V` | `brew install python ffmpeg` |

macOS: put PostgreSQL's binaries on your PATH for this shell: `export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"`.

## 2. Get the code

```bash
git clone https://github.com/akash-8991/edtech_platform.git
cd edtech_platform/platform
```

Layout you will use: `api/` (the NestJS service), `docs/` (all documentation), `ops/` (alert rules, dashboards), `docker-compose*.yml`, and `../video_engine/` (media pipeline).

---

## Path A: native

### A1. Start PostgreSQL (a private cluster on port 5433)

The project's convention is a throw-away local cluster in `platform/.pgdata` on **port 5433**, so it never collides with another PostgreSQL on your machine.

```bash
cd platform                                       # the folder that contains api/ and docker-compose.yml
export LC_ALL=en_US.UTF-8                         # PostgreSQL refuses to start without a valid locale on macOS
initdb -D "$PWD/.pgdata" -U edtech -A trust -E UTF8 --locale=en_US.UTF-8
pg_ctl -D "$PWD/.pgdata" -o "-p 5433" -l "$PWD/.pgdata/server.log" start
createdb -h localhost -p 5433 -U edtech edtech         # the app database
createdb -h localhost -p 5433 -U edtech edtech_test    # used by the automated tests
psql -h localhost -p 5433 -U edtech -d edtech -c "select version()"     # prints PostgreSQL 16.x
```

`-A trust` (no password) is for this local-only cluster. To stop it later: `pg_ctl -D "$PWD/.pgdata" stop`; to start it again, repeat only the `pg_ctl ... start` line.

Prefer an existing server or Docker? Any PostgreSQL 16 works. With Docker: `docker run -d --name edtech-pg -e POSTGRES_USER=edtech -e POSTGRES_PASSWORD=edtech -e POSTGRES_DB=edtech -p 5433:5432 postgres:16`, then `docker exec edtech-pg createdb -U edtech edtech_test`, and adapt the password in the URLs below.

### A2. (Optional) Start Redis

Without Redis, rate limits and session revocation are per process, which is fine for one local instance. To mirror production:

```bash
redis-server --port 6379 --daemonize yes
redis-cli ping            # PONG
# then add to api/.env:  REDIS_URL=redis://localhost:6379
```

### A3. Configure

```bash
cd api
cp .env.example .env
```

The defaults already point at `postgresql://edtech:edtech@localhost:5433/edtech` and use development secrets. The app loads `.env` automatically **outside production** (a variable already exported in your shell wins over the file). The values you may want to set now are in the [configuration reference](04-configuration-reference.md); none are required for a first run.

### A4. Install, create the schema, seed

```bash
npm ci                                  # install exact dependencies from package-lock.json
npx prisma generate                     # generate the database client (npm 11 skips install scripts, so run this explicitly)
npx prisma migrate deploy               # create all tables, triggers and indexes
npm run db:seed                         # 8 synthetic staff users, password Dev-Only-Pass1
```

Seeded users (all `@synthetic.test`, password `Dev-Only-Pass1`): `superadmin`, `admin` (academic admin), `platform` (platform admin), `author`, `faculty`, `approver`, `auditor`, `support`.

### A5. Run the API

```bash
npm run dev                             # ts-node, restarts are manual; listens on http://localhost:3000
```

With `PROCESS_ROLE` unset the single process also runs the background worker (queue, sweeps, integrity check). To run them separately, as in production:

```bash
PROCESS_ROLE=api npm run dev            # terminal 1: HTTP only
npm run build && npm run start:worker   # terminal 2: worker only (liveness on :3001)
```

### A6. Check it works

```bash
curl -s localhost:3000/health            # {"status":"ok"}
curl -s localhost:3000/health/ready      # {"status":"ready"}   (the database answers)
curl -s -X POST localhost:3000/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@synthetic.test","password":"Dev-Only-Pass1"}' | jq '{roles, expiresIn}'
```

### A7. Run the end-to-end walkthrough

```bash
export DATABASE_URL=postgresql://edtech:edtech@localhost:5433/edtech    # only used to give the demo learner a password
BASE=http://localhost:3000 npm run walkthrough
# ... WALKTHROUGH OK  (31 checks passed)
```

It authors and publishes a course, admits a learner, and has the learner watch, take the quiz and submit, then checks reports, the audit chain and integrity. If a check fails it stops and prints the HTTP status and body.

### A8. Run the automated tests

```bash
DATABASE_URL=postgresql://edtech:edtech@localhost:5433/edtech_test npx prisma migrate deploy    # once: schema for the test database
npm test                                 # ~360 tests, ~45 s. Needs PostgreSQL on :5433 and, for two suites, Redis on :6379
npm run test:cov                         # same, with coverage gates; writes ../docs/quality/coverage.md and coverage/lcov-report
```

Tests truncate tables in `edtech_test`; they never touch `edtech`. Without Redis, `test/hardening.spec.ts` falls back to the in-process limiter paths and its Redis assertions fail: start Redis (A2) or set `TEST_REDIS_URL`. Optional suites: `TEST_REPLICA_URL=postgresql://edtech:edtech@127.0.0.1:5434/edtech_test` runs the read-replica tests against a real streaming replica (skipped otherwise).

### A9. Daily commands

| Task | Command (in `platform/api`) |
|---|---|
| Type-check | `npx tsc --noEmit` |
| Build for production | `npm run build` (output in `dist/`) |
| Start built API / worker | `npm start` / `npm run start:worker` |
| New migration after editing `prisma/schema.prisma` | `npx prisma migrate dev --name <change>` then `npm run lint:migrations` |
| Regenerate API inventory + reference | `npm run inventory` (a test fails if routes change without it) |
| Create a user | `USER_PASSWORD='...' npm run user:create -- --email x@y.z --roles AUDITOR` |
| Load test | `npm run loadtest` (uses a separate `edtech_perf` database) |
| Reset the dev database | `npx prisma migrate reset --force` (drops everything, re-applies, re-seeds) |

---

## Path B: Docker Compose

```bash
cd platform
docker compose up -d --build            # first build takes a few minutes
docker compose ps                       # api (healthy), db (healthy), redis (healthy), worker (Up); migrate exits after seeding
curl -s localhost:3000/health/ready     # {"status":"ready"}
```

What starts: PostgreSQL 16, Redis 7, a one-shot `migrate` job (applies migrations and seeds the synthetic users), the API (`PROCESS_ROLE=api`) and the worker (`PROCESS_ROLE=worker`), with uploaded files on a shared volume. Run the walkthrough from your machine (it needs `curl`, `jq`, `uuidgen`, Node for `npm run user:create`, and the database URL):

```bash
cd api && npm ci && npx prisma generate
export DATABASE_URL=postgresql://edtech:edtech@localhost:5433/edtech
BASE=http://localhost:3000 npm run walkthrough
```

Port clashes (for example you already run PostgreSQL on 5433)? Remap with environment variables: `DB_PORT=5455 REDIS_PORT=6390 API_PORT=3400 docker compose up -d --build` (then use those ports above).

Mirror production components (S3-compatible storage with MinIO, ClamAV malware scanning):

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.full.yml ps     # wait for clamav to become (healthy): 1-3 minutes, longer on Apple Silicon
```

Until ClamAV is healthy the API/worker do not start (they wait for it) and, afterwards, uploads fail closed with 503 if it ever goes down. On Apple Silicon the ClamAV image runs under amd64 emulation. MinIO console is not exposed by default; the bucket `edtech` is created automatically.

Logs and cleanup:

```bash
docker compose logs -f api worker
docker compose down            # stop, keep data
docker compose down -v         # stop and delete the database and uploads
```

---

## 3. Optional capabilities

| Capability | What to do | Notes |
|---|---|---|
| **AI** (content generation, tutor, grading) | put `ANTHROPIC_API_KEY` and/or `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`) in `.env`, restart, then `npm run ai:smoke` | Without keys, AI features return "not configured"; everything else works. **Never validated against the live providers.** |
| **Hindi/English video** | follow [05-video-engine.md](05-video-engine.md) | separate Python tool |
| **Proctoring** | leave `PROCTOR_BASE_URL` unset: an in-process mock is used | real vendor: see `../proctor-provider-contract.md` |
| **Code sandbox** | `SANDBOX_MODE=docker` (+ a running Docker daemon) | untested against a real daemon |
| **Single sign-on** | `OIDC_*` variables ([reference](04-configuration-reference.md#single-sign-on)) | only tested against a local mock provider |
| **MFA rehearsal** | `MFA_ENFORCE=1`, sign in as `admin@synthetic.test`, follow the enrolment steps in the [user guide](03-user-guide.md#23-multi-factor-authentication-staff-tested) | needs an authenticator app |

## 4. Rehearse production mode locally

Catches configuration mistakes before you deploy. Production mode demands real-looking secrets and shared services, so this is also the best check of your secret generation.

```bash
cd platform/api && npm run build
export NODE_ENV=production PORT=3100 PROCESS_ROLE=api CORS_NONE=1
export DATABASE_URL=postgresql://edtech:edtech@localhost:5433/edtech
for v in JWT_SECRET ADMISSIONS_HMAC_SECRET MEDIA_TOKEN_SECRET EXAM_RECEIPT_SECRET LAB_QR_SECRET METRICS_TOKEN; do export $v=$(openssl rand -base64 36 | tr -d '=+/'); done
export DATA_ENC_KEY=$(openssl rand -hex 32) OFFLINE_MASTER_KEY=$(openssl rand -hex 32)
export REDIS_URL=redis://localhost:6379 STORAGE_DRIVER=s3 S3_BUCKET=local S3_KMS_KEY_ID=local SCANNER=clamav CLAMD_HOST=127.0.0.1
node dist/src/main.js                    # starts; the API does not touch S3/ClamAV until a file is uploaded
```

Remove `PROCESS_ROLE` (or set `all`) and it refuses to start and tells you why; that is the guard working.

## 5. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `initdb`/`postgres`: `invalid locale name` or server won't start | `export LC_ALL=en_US.UTF-8` before `initdb` and `pg_ctl` (on Linux: `sudo locale-gen en_US.UTF-8`). |
| `Can't reach database server at localhost:5433` | Cluster not running: repeat the `pg_ctl ... start` line (A1); check `tail .pgdata/server.log`. |
| `EADDRINUSE: address already in use :::3000` | Another process owns the port: `PORT=3010 npm run dev`, or `lsof -i :3000`. |
| `@prisma/client did not initialize yet` / `Cannot find module '.prisma/client'` | `npx prisma generate` (npm 11 blocks Prisma's install script). |
| `P3005 The database schema is not empty` | The database was created another way. Use a fresh database, or `npx prisma migrate reset --force` (**erases data**). |
| Login returns 401 for a seeded user | You skipped `npm run db:seed`, or the account is locked (5 failures = 15 min), or `MFA_ENFORCE=1` and the user must enrol first (look for `mfaEnrollmentRequired`). |
| Walkthrough: `missing prerequisite: uuidgen` | `sudo apt install uuid-runtime` (macOS has it). |
| Walkthrough: `learner could not sign in` | `DATABASE_URL` not exported in the shell running the walkthrough, or it points at a different database than the API uses. |
| Uploads fail with 503 `malware scanner unavailable` | `SCANNER=clamav` but clamd is not reachable. Locally use `SCANNER=noop`. |
| `Refusing to start: unsafe production configuration` | Working as intended in production mode; the lines below it list exactly what to fix. |
| Tests fail with Redis connection errors | Start Redis (A2) or set `TEST_REDIS_URL`. |
| Docker: `no matching manifest for linux/arm64` (ClamAV) | Use the provided `platform: linux/amd64` override (already in `docker-compose.full.yml`); needs Docker Desktop's emulation enabled. |
| Docker: Prisma warns about `libssl` | Rebuild the image (`--build`); the current Dockerfile installs OpenSSL. |

## 6. Cleaning up

```bash
pg_ctl -D "$PWD/.pgdata" stop           # stop the local cluster   (rm -rf .pgdata deletes all local data)
redis-cli shutdown nosave               # stop Redis
docker compose down -v                  # Path B
```
