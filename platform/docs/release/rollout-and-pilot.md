# Release plan, pilot and phased production rollout

`[PILOT_COHORT]`, `[BUDGET_AND_TIMELINE]` and `[SUPPORT_MODEL]` are not defined; the plan below is a recommendation to be confirmed.

## Waves
| Wave | Audience | Preconditions | Exit criteria |
|---|---|---|---|
| 0 Internal | Staff, synthetic learners (clearly labelled), one programme | Staging stack, secrets in KMS, MFA enforced, backups running | All critical journeys green; no S1/S2 defects for 5 days |
| 1 Pilot | 200-500 learners, **one programme, English**, one cohort, centre-proctored exam only | Learner web client accepted incl. accessibility audit; consent/notice approved; support rota; live AI smoke + benchmarks passed; pen test criticals fixed | Completion and engagement within target; tutor grounded >= 85 %, unsupported < 2 %; doubt SLA >= 90 %; AI grade agreement within tolerance; zero integrity-chain failures; learner satisfaction survey |
| 2 Expansion | Hindi + second programme; up to ~5,000; remote proctored exam for a small group | Wave 1 exit; vendor selected and contract-tested; load test at 10k | Same metrics at scale; exam window ran with zero lost autosaves; appeals handled within policy |
| 3 Production | Full cohorts up to 50,000 | Staging test at 50k mix + 25k exam burst; cloud DR drill signed; on-call and runbooks rehearsed; cost within budget | Gate 7 acceptance |

## Controls during rollout
- Kill switches: `ai.kill_switch`, `exam.change_freeze`, per-feature config; MFA/rate limits cannot be disabled in production.
- Change freeze 48 h before each exam window; migrations expand/contract only; roll back by image.
- Monitoring per `docs/ops/slo-and-alerts.md`; daily integrity verification; weekly cost and quality review (grading variance, tutor refusals).
- Moderation capacity: staff the faculty queue for the expected moderation rate (default routing ~20-40 % early; tune with data).
- Communications: privacy notice + consent, accessibility statement, support channels, exam rules, appeal process.

## Training and handover (knowledge transfer)
Sessions: architecture and data model; authoring/approval workflow; assessment ops (moderation, appeals, overrides); exam operations and
proctoring; doubt-centre operations; privacy operations (DSR, retention, legal hold); security operations (sessions, MFA reset, incident
runbook); DR and integrity verification; AI operations (prompts, benchmarks, kill switch, costs). Deliver: repository + docs, runbooks,
recorded sessions, admin/learner guides, access matrix (`docs/api-inventory.json`), on-call handbook. The institute owns all code, data,
prompts, configurations and keys.
