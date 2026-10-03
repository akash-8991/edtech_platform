# Gate evidence matrix (build prompt gates 1-7)

Legend: **MET** = evidenced in this repository and re-runnable; **PARTIAL** = built but not independently verified or missing parts;
**NOT MET** = not started or impossible without inputs/infrastructure that do not exist yet. Approvals are human decisions and are never
marked met by engineering.

| Gate | Criterion | Status | Evidence / gap |
|---|---|---|---|
| 1 Requirements baseline | Traceability, assumptions, MVP and exclusions approved | PARTIAL | `docs/traceability.md`, `docs/decision-log.md` (66+ decisions, ~25 OPEN). **Approval pending**; open inputs: IdP, policies, enrolment API, retention schedule, SLO/budget, pilot cohort, support model |
| 2 Architecture and UX | C4, data, threat model, contracts, prototypes approved | PARTIAL | `docs/architecture.md`, Prisma schema, `docs/security/threat-model.md`, `docs/api-inventory.json` (routes + access rules) and **`docs/openapi.json` (OpenAPI 3.1: every route's parameters, request body and response bodies, enforced against live responses in CI; see guides/08)**. **No event catalogue. No UX prototypes or design system** |
| 3 Foundation | Identity, RBAC, entitlements, authoring, audit, pipelines accepted | PARTIAL | 299 passing tests; MFA/SSO/sessions; audit chain. CI/CD and Dockerfile authored but **never executed**; no IaC (cloud provider undecided) |
| 4 Learning MVP | Video, quiz, assignment, gating, **web/mobile pilot** accepted | PARTIAL | Server side complete and tested. **No web, Android or iOS client exists** |
| 5 AI capabilities | Content factory, bilingual media, tutor, grading **academically validated** | NOT MET | Everything tested with scripted fakes. **No live provider run, no golden datasets, no academic council benchmark** (tutor/grader benchmark runners exist) |
| 6 Exams and scale | Privacy, accessibility, penetration, DR, concurrency tests passed | PARTIAL | Privacy controls implemented and tested. DR: local logical drill passed. Concurrency: single-machine measurements only. **Accessibility audit: not possible (no UI). Penetration test: not done. Proctoring vendor: not selected/tested** |
| 7 Launch | Operations, ownership handover, training, go-live acceptance signed | NOT MET | Runbooks/SLOs drafted, not rehearsed; no on-call, no training delivered, no acceptance |

## "No launch with..." conditions
| Condition | Status |
|---|---|
| Unresolved critical security findings | No critical found internally; S-10 (malware scan) now has a ClamAV adapter and production refuses the no-op scanner, but it is untested against a real clamd; staff videos above 25 MB are not scanned inline (D-078); independent pen test not done |
| Missing academic auditability | Satisfied in code: append-only grade/exam/audit records, hash chains, maker-checker, appeals |
| Untested restore | Local restore tested and repeatable; **cloud restore/PITR untested** |
| Unapproved AI-generated learner content | Satisfied in code: AI output only enters DRAFT versions, blocked by quality findings and the faculty/admin workflow; tutor answers only from published content |

## Blocking list to reach a pilot
1. Choose cloud/region, IdP, proctoring vendor, retention schedule, support model; sign DPA/subprocessor terms (incl. AI providers).
2. Build the clients (learner web/PWA first, then admin/faculty/teacher/exam consoles) against the inventory.
3. Run live provider smoke tests, SME benchmarks for tutor (>=85 % grounded, <2 % unsupported) and grader agreement, **native-speaker review of the Hindi UI strings (`web/src/i18n/hi.json`)**, one real ffmpeg transcode, and the service worker in desktop Chrome and mobile Safari.
4. Real malware scanner; sandbox review before enabling code execution.
5. Staging stack with IaC, k6 load tests incl. exam burst, cloud DR drill, independent penetration test, accessibility audit with real users.


## Test coverage (2026-10-02)
Measured and gated in CI: see [quality/coverage.md](../quality/coverage.md). Statements ~92%, branches ~80%, functions ~92% (lines read higher because of dense code). Coverage shows code that ran, not that assertions are strong; mutation testing and tests against real external services are not done.
