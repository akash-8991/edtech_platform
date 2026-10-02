# Operational runbooks (summary)

| Situation | Detect | Act |
|---|---|---|
| **AI provider down / degraded** | `jobs_queue_depth`, `grading_pending_submissions`, tutor `UNAVAILABLE` rate, `ai_cost_usd_today` | Learning continues by design. Tutor falls back to search + escalation; grading jobs requeue with backoff and fall to teachers after 5 attempts; generation pauses. If cost runaway or abuse: `PUT /v1/admin/config/ai.kill_switch` (platform admin). |
| **Proctoring provider outage** | check-in returns 503 `proctor_unavailable`; `remoteAwaitingProctorReport` grows | Switch the session to CENTRE mode if possible; otherwise postpone. Missing reports: `POST /exam-ops/sweep` polls; exam admin may waive per attempt with a reason (audited). |
| **Exam window (T-24h to T+close)** | `/exam-ops/status`, `exam_attempts_in_progress`, stale autosave, `http_request_duration_seconds` p95 | Enable `exam.change_freeze`; pre-scale API/DB; verify `/health/ready`; watch incident queue; keep paper/alternate contingency per policy; do not deploy. |
| **Mass autosave failures** | stale autosave count rising, 5xx on `PUT /exam-attempts/:id/answers` | Check DB saturation/pool; learners keep working client-side and resync (saves are idempotent by `seq`); extend deadlines individually via accommodation only after review. |
| **Suspected account compromise** | refresh-token-reuse audit, lockouts, unusual sessions | Revoke sessions, reset MFA (platform admin, audited), review audit trail for the actor. |
| **Data-subject request SLA** | `GET /v1/privacy/requests?status=REQUESTED` | Decide within the institute SLA; processing runs automatically (worker) or `POST /privacy/process`. |
| **Database failure / restore** | `/health/ready` 503 | Fail over (managed HA) or restore from backup per `dr-plan.md`; run `GET /v1/ops/integrity` afterwards; reconcile any gap since RPO. |
| **Integrity verification fails** | `GET /v1/ops/integrity` `ok:false` | Treat as a security incident: freeze changes, snapshot, identify first broken index, compare with latest verified backup. |
| **Bad release** | error budget burn | Roll back image; migrations are forward-only, so ship expand/contract migrations. |


## Alert runbooks (anchors referenced by `ops/prometheus/alerts.yml`)

### api-errors
`ApiErrorBudgetBurn*`. 1) Check `X-Trace-Id` of a failing request in the logs, then the `ctx:"span"` lines with the same `traceId` to see which dependency (service/op/outcome) failed. 2) `ExternalDependencyFailing` firing too: the cause is the vendor, see the AI/proctoring rows above. 3) Database: `/health/ready`, connection-pool timeouts (`pool_timeout` errors), PgBouncer `SHOW POOLS`. 4) Recent deploy: roll back the image (migrations are expand/contract, so the previous release keeps working; see `migrations.md`).

### latency
`ApiLatencyP95High`. Split by route (`http_request_duration_seconds` has a `route` label). Event-loop lag high = CPU-bound (password hashing, report building): scale API instances or lower `HASH_CONCURRENCY`. Slow only on report routes: confirm they are reading the replica (`DATABASE_REPLICA_URL`; `read_replica_fallback_total` rising means they fell back to the primary).

### worker
`WorkerDown`. Queues, exam sweeps, privacy processing, retention and the integrity check are stopped. Learning and exams themselves are unaffected, but submitted exams will not auto-close and grading will not progress. Restart the worker deployment; the queue is crash-safe (stale RUNNING jobs are re-queued after 15 min, max 3 attempts). Check the worker liveness port `/health`.

### redis
`RedisFallbackActive`. API stays up but rate limits and login throttles are per-instance (weaker) and a revoked session can take up to `SESSION_CACHE_MS` to stop working on other instances. Restore Redis; no data migration is needed. If prolonged during an incident involving account compromise, shorten `SESSION_CACHE_MS` to 0 on all instances.

### key rotation
Routine or after suspected exposure. See `security/key-rotation.md`.
