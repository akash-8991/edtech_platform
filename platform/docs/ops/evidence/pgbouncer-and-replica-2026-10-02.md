# Evidence: PgBouncer and streaming replica (local, 2026-10-02)

**PgBouncer** (Homebrew, transaction pool mode, `default_pool_size=5`, `max_client_conn=200`, plain auth) in front of `edtech_test`:
`TEST_DATABASE_URL='postgresql://edtech:edtech@127.0.0.1:6433/edtech_test?pgbouncer=true&connection_limit=5' npx jest` -> **20 suites, 337 tests passed**. The pooler log shows the client logins; the suite includes concurrent advisory-lock audit appends, `FOR UPDATE SKIP LOCKED` job claiming, interactive transactions and `set_config(..., true)`.

**Streaming replica** (PostgreSQL 16, `pg_basebackup -R -X stream`, port 5434): `TEST_REPLICA_URL=postgresql://edtech:edtech@127.0.0.1:5434/edtech_test npx jest test/scale` -> 6 passed (replica in recovery, writes rejected, primary writes arrive, report endpoints read the replica, fallback to primary on replica failure).

Limits: one machine, small data, no network latency or lag, not a managed cloud pooler/replica.
