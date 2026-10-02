# SLOs and alerts (proposed; TRD §10-11 targets)

| SLI | SLO | Source | Alert |
|---|---|---|---|
| API availability (non-exam) | 99.9 % monthly | `http_requests_total{status=~"5.."}` / total | burn rate 14x over 5 min and 6x over 1 h |
| Exam-window availability | 99.95 % | same, windowed on declared sessions | any 5xx burst > 0.1 % for 2 min |
| API latency | p95 < 2 s, p99 < 5 s (excl. long AI jobs) | `http_request_duration_seconds` | p95 > 2 s for 10 min |
| Playback start | < 4 s | client RUM (not built) | - |
| Autosave freshness | 99 % of in-progress attempts saved < 90 s ago | `/exam-ops/status` stale count | stale > 1 % for 3 min |
| Grading backlog | oldest pending < 30 min | `grading_pending_submissions`, queue age | > 30 min |
| Doubt first response | per priority SLA, >= 90 % | `/reports/doubts` | breaches rising |
| Event-loop health | p99 lag < 100 ms | `nodejs_eventloop_lag_p99_seconds` | > 250 ms 5 min |
| Auth failures | baseline | `auth_failures_total` | 5x baseline |
| AI spend | daily budget | `ai_cost_usd_today` | > 80 % of cap |
| Integrity | always intact | `/v1/ops/integrity` (hourly job) | `ok:false` page immediately |

Scrape `/metrics` with `METRICS_TOKEN`. Dashboards: golden signals per route, queue depth by kind, exam operations, AI cost, privacy queue.
