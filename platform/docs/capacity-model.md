# Capacity model and measured performance (Phase 7)

**Read this first.** All numbers below were measured on one developer machine running the client, the API (a single Node process),
and PostgreSQL together (`npm run loadtest`; raw output in `docs/perf/`). They are indicative per-instance throughputs, **not a
validation of 50,000 concurrent users**. No multi-instance, network, managed-database or CDN testing has been done.

## Demand model (TRD §4 baseline, with stated assumptions)
| Workload | Population | Assumed request pattern | Peak rate |
|---|---|---|---|
| Video/reading | 35,000 | one heartbeat event / 15 s each | 2,333 events/s |
| Same, with client batching (recommended) | 35,000 | 4 heartbeats per request, one request / 60 s | 583 req/s |
| Quiz/assignment/tutor | 10,000 | ~1 request / 20 s | 500 req/s |
| Other API | 5,000 | ~1 request / 30 s | 167 req/s |
| Exam burst | 10,000 -> 25,000 | autosave / 20 s | 500 -> 1,250 req/s |
| Morning sign-in burst | 50,000 in 15 min | login (refresh tokens avoid repeat logins) | 55 logins/s |

## Measured per instance (64 concurrent clients, 8 s per scenario)
| Scenario | Before | After optimisation | p95 after |
|---|---:|---:|---:|
| Framework floor (`/health`) | 13,674 rps | 13,729 | 8 ms |
| `GET /auth/me` (guard + session + 1 query) | 3,763 | 4,266 | 22 ms |
| `GET progress` (unlock computation) | 861 | 1,240 | 79 ms |
| `GET playback manifest` | 757 | 1,088 | 82 ms |
| `POST learning-events` (4 heartbeats) | 96 req/s (384 ev/s) | 388 req/s (**1,552 ev/s**) | 217 ms |
| `PUT exam autosave` (hash-chained log) | 754 | 812 | 121 ms |
| `POST login` (scrypt) | 20 | 61 | 616 ms |
| Audit append (global hash chain, serial) | - | 1,375 / s | 13 ms |

### What was changed because of the measurements
1. **Heartbeat ingestion**: one transaction per *topic* per batch instead of per event; unlock check skipped for topics that already have a
   progress row (unlocking is monotonic); one completion recompute per batch. 4x throughput, p50 688 ms -> 161 ms.
2. **Course structure cache**: published versions are immutable, so the topic/asset structure is cached per version (10 min). Quiz questions
   (with answer keys) are no longer loaded by endpoints that do not need them. +44% on progress and playback.
3. **Password hashing**: `scryptSync` blocked the event loop (every request on the instance stalled ~50 ms per login). Now async on the
   libuv threadpool with a concurrency cap (`HASH_CONCURRENCY`, `UV_THREADPOOL_SIZE=8`). 3x login throughput and no cross-request stalls.

## Sizing from the measurements (before headroom, N+1 and AZ loss)
| Workload | Need | Per-instance | Instances (+50% headroom, min 2 for HA) |
|---|---:|---:|---:|
| Heartbeats (unbatched) | 2,333 ev/s | 1,552 ev/s | 3 |
| Heartbeats (batched 4 / 60 s) | 583 req/s | 388 req/s | 3 (do batch: it also cuts DB write volume ~4x) |
| Exam autosave 10k / 25k | 500 / 1,250 | 812 | 2 / 3 |
| Progress/playback/API | ~700 | ~1,100 | 2 |
| Login burst | 55/s | 61/s | 2 + rely on refresh tokens |
| **Whole API tier (shared)** | | | **~6-8 instances of 1 vCPU-class** plus workers |

The database is the real constraint: peak ~2,300 event writes/s + ~1,250 autosaves/s at 8-15 statements each. Plan a large primary with
PgBouncer (transaction pooling is compatible: all request-path transactions are interactive and short), read replicas for reports/
progress reads, and partitioning of `LearningEvent` by month. None of this has been tested.

## Known hot spots and limits
- **Per-attempt serialisation** (row lock + advisory lock for the hash chain on every autosave): fine across attempts, serial within one.
- **Global audit lock**: ~1,375 appends/s. Not on the learner path, but a bulk release of 25,000 exam results is ~18 s of audit time.
- **Rate limiter and session cache**: with `REDIS_URL` (required in production) limits are one shared counter and revocation is pushed to every instance over pub/sub (D-077); if Redis is unreachable they fall back to per-instance state and `redis_fallback_total` counts it. Audit chain appends measured at ~1,400/s on one machine (single advisory lock, p95 13 ms at 16 concurrent); audited writes are low-frequency (approvals, submissions, decisions), so ~83/s for a 50,000-learner exam-submission burst is well inside it, but never put an audit write on a per-heartbeat path. Previously: revocation
  reaches every instance within `SESSION_CACHE_MS` (5 s default).
- **Tutor retrieval** is in-process (see D-034) and will not scale to the full corpus without OpenSearch/pgvector.
- **Media** must be served by a CDN; the API's byte-range streaming is a stand-in.
- **AI**: concurrency is bounded by provider quotas/budgets, not by this API (queue, backoff, fallback and kill switch exist).

## Staging load-test plan (required before Gate 6)
Reproduce the scenarios above with a distributed generator (k6/Locust) against a staging stack of the intended topology; add: exam
window with 10,000 then 25,000 attempts, offline-resync storm (events with old timestamps), tutor degradation, AZ failure, PgBouncer
failover. Pass criteria: API p95 < 2 s and p99 < 5 s (TRD), zero lost autosaves, no growth in queue depth, error rate < 0.1%.
Retain results as acceptance evidence.
