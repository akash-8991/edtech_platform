# Scaling configuration: pooling, replica, shared state

## Connection pooling (PgBouncer, transaction mode)
- App settings: `DB_CONNECTION_LIMIT` (per-process pool), `DB_POOL_TIMEOUT` (seconds), `DB_PGBOUNCER=1` (adds `pgbouncer=true`: no prepared statements).
- The code is transaction-pooling safe by construction: only transaction-scoped features (`pg_advisory_xact_lock`, `set_config(..., true)`, `FOR UPDATE SKIP LOCKED`, interactive transactions); no session state, `LISTEN/NOTIFY` or session advisory locks (cross-instance fan-out uses Redis).
- **Verified:** the entire 330+ test suite passes through a real PgBouncer 1.x in transaction mode with `default_pool_size=5` (see `docs/ops/evidence/`). Not yet verified under production load or with the managed pooler of the chosen cloud.
- Sizing: `instances x DB_CONNECTION_LIMIT` should be well above the PgBouncer `default_pool_size` x databases only if PgBouncer multiplexes; keep PgBouncer `default_pool_size` + workers + admin below Postgres `max_connections` with headroom. Migrations bypass the pooler.

## Read replica
- `DATABASE_REPLICA_URL` routes the heavy read-only reports (cohort progress, exam results/item analysis, grading, tutor and doubt analytics) to a streaming replica; if the replica fails the query retries once on the primary (`read_replica_fallback_total`).
- Replica lag is visible to those reports only. Never route read-your-write or exam/learning paths to the replica.
- **Verified** against a real local PostgreSQL 16 streaming replica (`test/scale.spec.ts` with `TEST_REPLICA_URL`): replica is in recovery, writes are rejected, primary writes arrive, report endpoints demonstrably read from it. Not verified with a managed cloud replica or at production lag.

## Shared state (Redis)
`REDIS_URL` is required in production: rate limits (atomic fixed window) and session-revocation fan-out. See `capacity-model.md` for fallback behaviour.

## Processes
`PROCESS_ROLE=api` (HTTP) and `node dist/src/worker.js` (queue, sweeps, retention, integrity check every `INTEGRITY_CHECK_HOURS`, default 6) scale independently; the queue is safe with N workers.
