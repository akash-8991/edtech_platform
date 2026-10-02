# Traceability matrix: Phase 1 (FRD requirement -> implementation -> test)

Test refs: `U` = api/src/domain/domain.spec.ts, `E` = api/test/e2e.spec.ts.

| Req | Status | Implementation | Test |
|-----|--------|----------------|------|
| IAM-001 intake by API/import | Done | applications.ts `intake`, HMAC endpoint, CSV/JSON import | E admissions |
| IAM-002 approve/reject/return w/ reason | Done (no notification, D-011) | applications.ts `decide` | E approval |
| IAM-003 12/18-month entitlement | Done | domain/entitlement.ts `computeEnd`; applications.ts | U, E |
| IAM-004 self pause/resume with limits | Done (notice/excluded windows not yet) | entitlements.ts, domain/entitlement.ts | U, E |
| IAM-005 suspend during pause, expiry policy | Done | `effectiveStatus`, `/access` | U, E |
| IAM-006 SSO/OTP/MFA/device sessions | **Not done** (D-004) | JWT guard is IdP-agnostic | - |
| IAM-007 role/object access + audit | Partial (D-012) | common/auth.ts, owner checks | E |
| CUR-001 curriculum capture | Partial: structure + hours + outcomes only | authoring.ts | E |
| CUR-003 hours validation | Minimal (D-009) | `validateForReview` | E |
| CUR-006 edit/compare/version/clone/archive | Partial: edit, version, clone, retire; no diff/export | authoring.ts | E |
| REV-001 state machine | Done | domain/workflow.ts | U, E |
| REV-002 segregation of duties | Done | `authorize` | U, E |
| REV-003 comments/history | Partial: comments + immutable history; no assignments/due dates/e-signoff | ApprovalRecord, ReviewComment | E |
| AUD-001 audit of privileged actions | Done | audit.ts + DB triggers | U, E |
| TRD §7 provenance | Stored on version (`provenance`) | schema | E |

## Phase 2 (test refs: `L` = api/test/learning.spec.ts, `U2` = api/src/domain/learning.spec.ts)

| Req | Status | Implementation | Test |
|-----|--------|----------------|------|
| VID-002/003 interactive video nodes | Server side: interactions stored, stripped of keys, required ones gate completion; branching evaluated by the client player (not built) | content.ts, media.ts, domain/progression.ts | L, U2 |
| VID-006 provenance/rights | Done | ContentAsset.provenance/rights, audit; video_engine/publish.py | L |
| VID-007 renditions + audio-only + transcript + offline package | Partial: serves uploaded renditions, low-bandwidth mode, encrypted offline package; no auto-transcoding/ABR manifests (D-018) | media.ts | L |
| VID-001/004/005 generation, captions, scene regeneration | Prototype only in video_engine/; not integrated as a service | video_engine | its own tests |
| QIZ-001/002 quiz | Done for MCQ single/multi/numeric; no pools/timers/other types | learning.ts | L, U2 |
| ASN-* assignment | Partial: text + file submit, limits, owner-scoped uploads; no rubric grading/AI/plagiarism (Phase 5), scan is a stub | learning.ts | L |
| LXP-* progression gating | Done server-side (D-014) | domain/progression.ts, learning.ts | L, U2 |
| LXP resume/cross-device | Done: resume position + progress by entitlement | VIDEO_POSITION events | L |
| OFF-001/002 offline | Server side done (D-019); client apps not built | media.ts | L, U2 |
| Notifications | In-app only (D-021) | notifications.ts | L |
| ANL/reporting | Cohort progress + at-risk + audited CSV | reports.ts | L |

## Phase 3 (test refs: `A` = api/test/ai.spec.ts, `Q` = api/src/ai/quality.spec.ts, `P` = api/src/ai/providers.spec.ts)

| Req | Status | Implementation | Test |
|-----|--------|----------------|------|
| CUR-001 capture brief | Done (title, audience, duration, hours, outcomes, prerequisites, languages, assessment policy, references) | ai.controller.ts | A |
| CUR-002 generate structured curriculum | Done: modules -> topics with hours/outcomes/prerequisites/lesson plan; bridge/core/pathway/capstone is prompt guidance, not enforced | generation.ts, prompts.ts | A |
| CUR-003 hours validation | Done: exact reconciliation + one repair pass; 12/18-month templates still absent (D-009) | quality.ts | Q, A |
| CUR-004 topic -> outcomes/prereq/quiz/assignment | Done per topic | generation.ts | A |
| CUR-005 flags (foundations, overload, duplicates, assessment gaps) | Done (unsafe lab prerequisites N/A until labs) | quality.ts | Q |
| CUR-006 partial regeneration, compare, version, clone | Topic regeneration, version diff, clone, manifest revisions done; no export/rollback | authoring.ts, diff.ts | A |
| VID-001 plan/script/storyboard/scenes | Done as video_engine manifest | generation.ts | A (incl. Python validation) |
| VID-003 interactions/branches + reachability | Generated and validated | quality.ts | Q, A |
| VID-004 EN/HI captions/transcript/audio | Hindi script + fidelity judge + glossary lock; audio/caption rendering is video_engine, transcripts derive from narration | generation.ts | A |
| VID-005 scene-level edit/regenerate | Topic-level only | - | A |
| VID-006 provenance | Done: provider/model/prompt version+hash/job/references hash on every artefact | generation.ts | A |
| REV-001/002 + AI gate | Done: unresolved blocking findings block approval; waiver rules | authoring.ts, ai.controller.ts | A |
| TRD §7 gateway (allow-list, routing, retry, fallback, limits, kill switch) | Done | gateway.ts, providers.ts | A, P |
| TRD §7 prompt registry + evaluation | Done (small golden sets, D-029) | prompts.ts | A |
| TRD §7 safety (PII, injection, moderation) | PII redaction, untrusted-data fencing, output checks; no separate moderation model | quality.ts, prompts.ts | Q, A |
| TRD §7 cost telemetry | Done | AiCall, /v1/ai/usage | A |
| ADM-001 configurable lists | Partial: productivity tools, glossary, prohibited terms, AI limits (no UI) | config.ts | A |

## Phase 4 (test refs: `T` = api/test/tutor.spec.ts, `R` = api/src/ai/retrieval.spec.ts)

| Req | Status | Implementation | Test |
|-----|--------|----------------|------|
| TUT-001 answer only from approved assets + approved FAQs | Done: version/programme-filtered, unlocked-topics-only retrieval; quiz never indexed | tutor-index.ts, tutor.ts | T, R |
| TUT-002 citations + uncertainty/boundary message | Done: validated citations, decline messages EN/HI | tutor.ts, retrieval.ts | T |
| TUT-003 limited learner context | Done: course, current topic, own history (last 6 turns), unlocked topics only | tutor.ts | T |
| TUT-004 escalate manually/automatically with context | Done | tutor.ts, doubts.ts | T |
| DCC-001 route to up to 50 teachers by discipline/skill/language/availability/workload/SLA | Done (D-037/D-038) | domain/routing.ts, doubts.ts | R, T |
| DCC-002 async response, internal note, attachment, resolution, rating, appointment | Done; live chat and group clinics not built | doubts.ts | T |
| DCC-003 teacher answers -> reviewed FAQ/remediation | Done | doubts.ts | T |
| TRD §7 RAG: versioned chunks, hybrid retrieval, min relevance, citation validation, no-answer path | Done at pilot scale (D-034) | tutor-index.ts, retrieval.ts | T, R |
| TRD tutor data model (TutorConversation/Evidence, DoubtTicket) | Done | schema | T |
| TRD §233 AI-down behaviour | Done | tutor.ts | T |
| PRD tutor KPIs (grounded >=85%, unsupported <2%, SLA >=90%) | Measured by benchmark + reports; thresholds unproven without golden data | tutor.ts (AnalyticsController) | T |
| BRD tutor analytics (questions, grounded rate, refusal/escalation, unresolved concepts, SLA, satisfaction) | Done | AnalyticsController | T |
| LXP-002 tutor in player | API only; UI not built | - | - |

## Phase 5 (test refs: `G` = api/test/grading.spec.ts, `D` = api/src/grading/grading.spec.ts)

| Req | Status | Implementation | Test |
|-----|--------|----------------|------|
| ASN-001 submission types | Text, file upload, code archive (zip), notebook (.ipynb) parsed; PDF/Word/media accepted but unparsed -> human review (D-050) | extract.ts | D, G |
| ASN-002 rubric dimensions, weight, scale, pass, evidence, prohibited patterns, late rules, unlock rule | Done (policy authoring + validation; version-pinned) | domain/grading.ts, grading.controller.ts | D, G |
| ASN-003 AI evaluation against exact rubric with cited evidence, dimension scores, rationale, feedback, confidence | Done; quotes verified in code; self-consistency | grading.ts | D, G |
| ASN-004 route low-confidence, anomalous, high-stakes, appealed, sampled to moderation | Done (D-045) | routeModeration, moderation endpoints | D, G |
| ASN-005 original, versions, timestamps, checksums, grader model/version, all grade changes | Done: immutable submission + content hash, append-only GradeRecord, audit | schema, grading.ts | G |
| TRD §7 grading: deterministic schema, constrained output, evidence refs, calibration, threshold, human agreement study | Done at pilot scale; golden data absent (D-051) | grading.ts, benchmark | D, G |
| FRD lifecycle Submitted -> AI Evaluated -> Moderation Required/Graded -> Appealed -> Final | Done | SubmissionGrade states | G |
| FRD academic integrity (similarity, provenance, impossible timing, suspicious patterns; no auto-conviction) | Similarity, timing, patterns, hash mismatch, injection; no citation/provenance check | grading.ts | D, G |
| BRD assessment analytics (score distribution, rubric reliability, AI-human variance, similarity, appeals) | Done | GET /v1/reports/grading | G |
| Maker-checker grading overrides + immutable trail (build prompt) | Done | grading.ts | G |
| Coding sandbox adapter (Phase 5 scope) | Adapter + Docker implementation, default disabled, not run live (D-049) | sandbox.ts | D |

## Phase 6 (test refs: `X` = api/test/exams.spec.ts, `E` = api/src/exams/exam.spec.ts)

| Req | Status | Implementation | Test |
|-----|--------|----------------|------|
| LAB-001 lab model: topic/outcome link, safety prerequisite, capacity, batch/slot, location, manual, evidence, completion rule | Done | labs.ts | X |
| LAB-002 no lab eligibility until prerequisites + safety acknowledgement | Done (hash-bound safety text) | labs.ts | X |
| LAB-003 attendance by teacher or signed QR; post-lab evidence | Done; "post-lab assignment" is evidence upload only | labs.ts | X |
| EXM-001 eligibility from academic, lab and assessment conditions | Done | domain/exam.ts, exams.ts | E, X |
| EXM-002 sessions, secure delivery, randomisation, timer, autosave, reconnect, receipt | Done (D-059); constructed-response items and load testing outstanding | exams.ts | E, X |
| EXM-003 remote/centre proctoring with identity, device checks, incident events | Adapter + webhook + contract + centre flow done; no real vendor (D-061) | proctoring/provider.ts, ops.ts | E, X |
| EXM-004 hold results with unresolved incidents; adjudication, appeal, authorised release | Done (D-062/D-063) | ops.ts | X |
| TRD §6 proctoring (tokenised mapping, consent flag, incident webhook, expiring evidence, report status) | Done | provider.ts, ops.ts | E, X |
| TRD §211 question-bank segregation, watermarking, autosave, tamper-evident logs, evidence restrictions | Done (watermark is display-only) | schema, exams.ts | X |
| TRD §234 exam mode: change freeze, autosave health, incident queue, proctor callback metrics | Done: freeze, ops status; pre-scale/DR drills not applicable yet | exam-ops/status | X |
| PRD EP-09/EP-10, programme completion dashboard | API done: /me/labs, /me/exams, /me/completion; no UI | exams.ts | X |
| BRD exam integrity dashboard | Done: funnel, item analysis, incidents, appeals | /reports/exams | X |
| Phase-2 lab/equipment connectors (OT, simulators) | Not started; excluded from MVP | - | - |

## Phase 7 (hardening and readiness; test refs: `S` = test/security.spec.ts, `P` = test/privacy.spec.ts, `T` = src/domain/totp.spec.ts)

| Req | Status | Implementation | Test / evidence |
|---|---|---|---|
| IAM-006 SSO-ready OIDC/SAML, OTP/MFA, device/session management | OIDC + TOTP MFA + sessions/devices done; SAML via broker; no passwordless/OTP-by-SMS | security/* | S, T |
| IAM-007 role/object access with complete audit | Done + mechanically verified (202 routes) | common/auth.ts, platform/inventory.ts | S |
| TRD §9 security: MFA privileged, encryption, secrets, rate/WAF controls, signed artefacts | App-level done; WAF/DDoS/KMS/signed artefacts/SIEM are infrastructure (not built) | platform/*, security/* | S |
| TRD privacy: consent, purpose limitation, minimisation, retention, correction, export, deletion | Done at API level (D-071) | privacy/privacy.ts | P |
| TRD §6 exports (permissioned, async, encrypted, expiry, audit, deletion after retention) | Done for data-subject exports; analytics exports unchanged | privacy.ts | P |
| TRD observability (golden signals, queue, cost, incident queue) | Metrics + health + logs done; dashboards/alerts defined, not deployed | platform/health.ts, docs/ops | S |
| TRD performance targets (p95 < 2 s, p99 < 5 s) | Met on measured paths at 64 concurrency on one machine; **not validated at scale** | scripts/loadtest.ts, docs/perf | docs/capacity-model.md |
| TRD DR (RPO 15 min / RTO 2 h) | Local drill passed; cloud DR not done | scripts/dr, ops/integrity.ts | docs/dr, P |
| PRD/FRD accessibility | Content gates + preferences + accommodations; client WCAG unverified | accessibility.ts, privacy.ts | P, docs/accessibility.md |
| Build prompt: OpenAPI specs, event catalogue, C4, ADRs, threat model, privacy assessment, test strategy, runbooks, DR plan, guides, KT plan | Route inventory (not full OpenAPI), architecture overview, decision log (as ADRs), threat model, privacy docs, runbooks, DR plan, rollout/KT plan done; **no OpenAPI schemas, no event catalogue, no C4 diagrams beyond text/mermaid, no user guides** | docs/* | - |
