# Personal-data map, retention schedule, DPIA summary and breach runbook

Aligned to the intent of India's Digital Personal Data Protection Act, 2023 and institute policy. **Legal review is required**; retention
periods below are engineering defaults, not legal advice. `[DATA_RETENTION_SCHEDULE]` from the build prompt is still to be supplied.

## Data map
| Data | Where | Purpose | Visible to | Retention default | On erasure |
|---|---|---|---|---|---|
| Identity (name, email, language) | User, LearnerApplication | Account, service | Learner, support/admin (need-to-know); teachers see name only | Account life | Pseudonymised |
| Credentials (scrypt hash), MFA seed (encrypted), backup-code hashes | User | Authentication | Nobody (not exportable) | Account life | Deleted |
| Sessions/devices | UserSession, RefreshToken, Device | Security | Learner (own), support | 90 days after expiry | Deleted |
| Consent history | ConsentRecord | Lawful basis proof | Learner, auditor | Kept | **Retained** |
| Learning progress/events | TopicProgress, LearningEvent, QuizAttempt | Delivery, gating, analytics | Learner, staff (cohort reports) | Programme + retention | Retained, pseudonymised |
| Assignments, grades, feedback, integrity flags | Submission, GradeRecord, SubmissionGrade, SimilarityMatch | Assessment, appeals | Learner (grade/feedback only), moderators (pseudonymous) | Academic retention (assumed 7 years) | Retained, pseudonymised |
| Exam attempts, receipts, incident decisions | ExamAttempt, ExamSubmission, Incident | Examination integrity | Learner (released result), adjudicators (blind) | Academic retention | Retained, pseudonymised |
| Proctoring video/audio/screen | **Vendor** (not stored here) | Integrity | Vendor, adjudicators via expiring links | Vendor contract (undefined) | Vendor erasure API called |
| Tutor conversations | TutorConversation/Message | Learning support, quality | Learner; analytics (aggregate) | 365 days after message | Redacted |
| Doubt tickets + attachments | DoubtTicket, TicketMessage, files | Support | Learner, assigned teacher, support | 7 days after resolve/close + sweep; text redacted on erasure | Redacted, files deleted |
| Lab bookings/evidence | LabBooking | Practical completion | Learner, coordinator | Academic retention | Retained |
| Notifications | Notification | Service messages | Learner | 180 days | Deleted |
| Preferences (accessibility) | UserPreference | Personalisation | Learner | Account life | Deleted |
| Audit trail | AuditEvent | Accountability | Auditor/admin | Not purged | Retained (ids only, no content) |

Data sent to model providers (Anthropic, OpenRouter): course material and learner questions/submissions after PII redaction; providers must
not train on it (contractual, `data_collection: deny` requested). **Residency is not guaranteed to be India (open, D-025).**

## Rights supported (self-service where safe)
Consent (versioned, withdrawable; tutor requires it when enforced), access/portability (`EXPORT`: encrypted at rest, 7-day expiry, step-up
auth, audited), correction (name/language; approved by a second person), erasure (approved by a second person; blocked by live entitlement
or legal hold; academic record retained pseudonymised; vendor notified), grievance route = support ticket + DSR queue.

## DPIA summary (high-risk processing)
1. Proctoring (biometric/behavioural monitoring): necessity - integrity of high-stakes exams; mitigations - consent per exam, alternatives
   (centre mode), human adjudication, no automatic penalties, blind review, appeals, minimal data to vendor. **Residual: vendor retention/biometrics.**
2. AI grading/tutoring (automated decisions): mitigations - human review thresholds, appeals, evidence, transparency ("graded by AI"), consent for tutor.
3. Integrity analytics (similarity/timing): flags never convict; learners cannot see signals (to avoid gaming) but can appeal outcomes.

## Breach response runbook (summary)
1. Detect (alerts: auth anomalies, refresh-token reuse, evidence-access audit, integrity verification failure). 2. Contain: revoke sessions
(`/admin/users/:id/revoke-sessions`), rotate secrets, switch AI/exports off (kill switch). 3. Assess scope using the audit trail and
`GET /v1/ops/integrity`. 4. Notify the Data Protection Board and affected learners as required by law and contract (provider SLAs: see TRD).
5. Preserve evidence (backup, legal hold via `PUT /privacy/users/:id/legal-hold`). 6. Post-incident review. **Notification timelines and the
named Data Protection Officer are institute decisions (open).**
