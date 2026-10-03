/**
 * Hand-written facts the traffic cannot show: what each route is for, which routes move bytes instead of JSON, which headers a
 * signed webhook needs. Everything else (shapes, required fields) is inferred from tests by scripts/infer-contracts.ts and then
 * enforced against live responses by the contract interceptor.
 */
export const TAGS: Record<string, string> = {
  admin: 'Platform administration: people, roles, settings.', admissions: 'Signed intake from the admissions system.', ai: 'AI generation jobs, prompts, quality findings and cost.',
  applications: 'Learner applications and admission decisions.', appointments: 'Doubt-centre appointments.', audit: 'Tamper-evident audit trail.', auth: 'Sign-in, multi-factor, sessions and SSO.',
  authoring: 'Programme authoring, review workflow and media assets.', catalogue: 'Published programme catalogue.', 'doubt-centre': 'Doubt-centre staffing and routing.', doubts: 'Learner doubts and attachments.',
  entitlements: 'Learning entitlements: pause, resume, extend, revoke.', 'exam-attempts': 'Sitting an exam.', 'exam-ops': 'Exam integrity operations, results and appeals.', 'exam-sessions': 'Exam session check-in.',
  exams: 'Exam definitions, sittings, question bank, accommodations and eligibility.', faq: 'Reusable doubt answers.', grading: 'Assignment grading, overrides and benchmarks.', health: 'Liveness and readiness.',
  incidents: 'Proctoring incident evidence.', labs: 'Lab sessions, attendance and evidence.', 'learning-events': 'Learning telemetry (heartbeats, interaction answers).', me: 'The signed-in learner.',
  media: 'Signed media delivery (single files and adaptive HLS).', moderation: 'Human review of AI-graded work.', offline: 'Offline devices and licences.', ops: 'Operational integrity checks.',
  privacy: 'Privacy requests, retention and legal hold.', proctor: 'Proctor actions on an attempt.', proctoring: 'Proctoring provider webhook.', 'quiz-attempts': 'Quiz submission.', reports: 'Operational reports.',
  openapi: 'This document.', push: 'Push notification configuration.', teacher: 'Doubt teacher workspace.', topics: 'Topic delivery for learners.', tutor: 'Grounded AI tutor.', metrics: 'Prometheus metrics.',
};

export const SUMMARIES: Record<string, string> = {
  'GET /v1/push/config': 'What push notifications this server can send (web, native) and the web public key', 'POST /v1/me/push/devices': 'Register this browser or phone for push notifications', 'GET /v1/me/push/devices': 'My devices that receive push notifications', 'DELETE /v1/me/push/devices/:id': 'Stop push notifications to one device', 'POST /v1/me/push/test': 'Send a test notification to my devices',
  'GET /v1/openapi.json': 'This API description (OpenAPI 3.1)', 'GET /health': 'Liveness probe', 'GET /health/ready': 'Readiness probe (database, cache, storage)', 'GET /metrics': 'Prometheus metrics (bearer METRICS_TOKEN)',
  'GET /v1/admin/config': 'List platform settings', 'PUT /v1/admin/config/:key': 'Change one platform setting',
  'GET /v1/admin/users': 'Search people', 'POST /v1/admin/users': 'Create an account', 'GET /v1/admin/users/:id': 'One person with roles and history',
  'POST /v1/admin/users/:id/roles': 'Replace a person\'s roles (two-person rules apply)', 'POST /v1/admin/users/:id/status': 'Suspend or reactivate an account',
  'POST /v1/admin/users/:id/unlock': 'Clear a sign-in lockout', 'POST /v1/admin/users/:id/reset-password': 'Issue a one-time password',
  'POST /v1/admin/users/:id/mfa-reset': 'Remove a person\'s authenticator so they can re-enrol', 'POST /v1/admin/users/:id/revoke-sessions': 'Sign a person out everywhere',
  'POST /v1/admissions/applications': 'Receive admitted applications (HMAC-signed webhook)',
  'POST /v1/ai/curriculum-jobs': 'Queue a curriculum draft', 'POST /v1/ai/topic-jobs': 'Queue topic content generation', 'GET /v1/ai/jobs': 'List AI jobs', 'GET /v1/ai/jobs/:id': 'One AI job',
  'POST /v1/ai/jobs/:id/cancel': 'Cancel a queued AI job', 'GET /v1/ai/prompts': 'List prompt templates', 'POST /v1/ai/prompts/:key': 'Propose a new prompt version',
  'POST /v1/ai/prompts/:id/evaluate': 'Run a prompt version against its golden set', 'POST /v1/ai/prompts/:id/approve': 'Approve a prompt version (second person)',
  'GET /v1/ai/quality': 'List AI quality findings', 'POST /v1/ai/quality/:id/resolve': 'Resolve a quality finding', 'GET /v1/ai/usage': 'AI cost and call volume',
  'GET /v1/applications': 'List applications (cursor-paged)', 'POST /v1/applications/import': 'Import applications from CSV or JSON', 'POST /v1/applications/:id/decision': 'Approve, reject or return an application',
  'POST /v1/appointments/:id/cancel': 'Cancel a doubt appointment',
  'GET /v1/audit': 'Read the audit trail', 'GET /v1/audit/verify': 'Verify the audit hash chain',
  'POST /v1/auth/login': 'Sign in with email and password', 'POST /v1/auth/mfa/verify': 'Finish sign-in with an authenticator or backup code', 'POST /v1/auth/mfa/enroll/start': 'Begin authenticator enrolment',
  'POST /v1/auth/mfa/enroll/confirm': 'Confirm enrolment and receive backup codes', 'POST /v1/auth/refresh': 'Exchange a refresh token (single use, rotating)', 'POST /v1/auth/logout': 'End this session',
  'POST /v1/auth/password': 'Change your password', 'GET /v1/auth/me': 'Who am I', 'GET /v1/auth/sso/config': 'Is single sign-on available', 'GET /v1/auth/sso/start': 'Begin OIDC sign-in (returns the provider URL)', 'GET /v1/auth/sso/callback': 'Finish OIDC sign-in',
  'GET /v1/authoring/programmes': 'List programmes with versions', 'POST /v1/authoring/programmes': 'Create a programme', 'POST /v1/authoring/programmes/:code/versions': 'Create a draft version',
  'GET /v1/authoring/versions/:id': 'One version summary', 'PUT /v1/authoring/versions/:id': 'Replace a draft version\'s whole tree', 'GET /v1/authoring/versions/:id/tree': 'Full version tree for editing',
  'POST /v1/authoring/versions/:id/transition': 'Move a version through review to publication', 'POST /v1/authoring/versions/:id/clone': 'Clone a version into a new draft', 'GET /v1/authoring/versions/:id/diff': 'Compare with the previous version',
  'POST /v1/authoring/versions/:id/comments': 'Add a review comment', 'GET /v1/authoring/versions/:id/accessibility': 'Accessibility readiness findings', 'GET /v1/authoring/versions/:id/labs': 'Lab activities of a version', 'PUT /v1/authoring/versions/:id/labs/:code': 'Create or change a lab activity',
  'POST /v1/authoring/topics/:id/assets': 'Register a media asset on a topic', 'GET /v1/authoring/topics/:id/manifest': 'Video-engine manifest for a topic', 'PUT /v1/authoring/topics/:id/quiz': 'Replace a topic quiz',
  'PUT /v1/authoring/topics/:id/assignment': 'Replace a topic assignment', 'GET /v1/authoring/topics/:id/assignment-policy': 'Read the grading policy', 'PUT /v1/authoring/topics/:id/assignment-policy': 'Set the grading policy',
  'PUT /v1/authoring/assets/:id/files/:label': 'Upload a rendition (raw bytes; checksum verified, malware scanned)', 'POST /v1/authoring/assets/:id/transcode': 'Queue an adaptive-bitrate (HLS) build', 'GET /v1/authoring/assets/:id/renditions': 'Adaptive build status',
  'GET /v1/catalogue': 'Published programmes', 'GET /v1/catalogue/versions/:id': 'One published version outline',
  'POST /v1/doubt-centre/sweep': 'Run the SLA sweep now', 'GET /v1/doubt-centre/teachers': 'List doubt teachers', 'PUT /v1/doubt-centre/teachers/:userId': 'Register or change a doubt teacher', 'POST /v1/doubt-centre/tickets/:id/reassign': 'Reassign a ticket',
  'POST /v1/doubts': 'Raise a doubt', 'PUT /v1/doubts/upload': 'Upload a doubt attachment (raw bytes)',
  'GET /v1/entitlements/:id/access': 'Server-side access decision', 'POST /v1/entitlements/:id/pause': 'Pause an entitlement', 'POST /v1/entitlements/:id/resume': 'Resume an entitlement', 'POST /v1/entitlements/:id/exceptions': 'Extend an entitlement', 'POST /v1/entitlements/:id/revoke': 'Revoke an entitlement',
  'POST /v1/entitlements/:id/progression-overrides': 'Unlock a topic or grant extra quiz attempts', 'GET /v1/admin/entitlements': 'Search entitlements', 'GET /v1/admin/entitlements/:id': 'One entitlement with its history',
  'POST /v1/exam-attempts/:id/start': 'Start an exam attempt', 'POST /v1/exam-attempts/:id/resume': 'Resume an attempt after a break', 'PUT /v1/exam-attempts/:id/answers': 'Autosave answers', 'POST /v1/exam-attempts/:id/signals': 'Report integrity signals',
  'POST /v1/exam-attempts/:id/device-check': 'Record the pre-exam device check', 'POST /v1/exam-attempts/:id/submit': 'Submit the attempt',
  'GET /v1/exam-ops/exams': 'Exam index with result counts', 'GET /v1/exam-ops/exams/:id': 'One exam with sessions', 'GET /v1/exam-ops/setup': 'Reference data for exam set-up', 'GET /v1/exam-ops/status': 'Live exam status',
  'GET /v1/exam-ops/incidents': 'Incident queue', 'POST /v1/exam-ops/incidents/:id/decide': 'Decide an incident', 'GET /v1/exam-ops/appeals': 'Appeal queue', 'POST /v1/exam-ops/appeals/:id/decide': 'Decide an appeal',
  'GET /v1/exam-ops/attempts/:id/case': 'Blind case file for adjudication', 'GET /v1/exam-ops/attempts/:id/result': 'Result and release state', 'GET /v1/exam-ops/attempts/:id/verify-log': 'Verify the attempt\'s hash-chained log',
  'POST /v1/exam-ops/attempts/:id/outcome': 'Set the integrity outcome', 'POST /v1/exam-ops/attempts/:id/waive-report': 'Waive a missing proctor report', 'POST /v1/exam-ops/attempts/:id/release': 'Release one result',
  'POST /v1/exam-ops/sessions/:id/release-ready': 'Release every ready result in a session', 'POST /v1/exam-ops/sweep': 'Run the exam sweep now',
  'POST /v1/exam-sessions/:id/check-in': 'Centre check-in', 'POST /v1/exam-sessions/:id/unregister': 'Withdraw from a session',
  'POST /v1/exams': 'Define an exam', 'POST /v1/exams/:id/publish': 'Publish an exam', 'POST /v1/exams/:id/register': 'Register for a session', 'GET /v1/exams/:id/sessions': 'Sessions of an exam', 'POST /v1/exams/:id/sessions': 'Schedule a session',
  'GET /v1/exams/:id/eligibility-overrides': 'Eligibility exceptions for an exam', 'POST /v1/exams/:id/eligibility-overrides': 'Grant an eligibility exception',
  'GET /v1/exams/accommodations': 'List accommodations', 'POST /v1/exams/accommodations': 'Grant an accommodation', 'POST /v1/exams/accommodations/:id/deactivate': 'Withdraw an accommodation',
  'GET /v1/exams/bank/:programmeId/coverage': 'Question-bank coverage by topic', 'GET /v1/exams/bank/:programmeId/questions': 'List bank questions', 'POST /v1/exams/bank/:programmeId/questions': 'Add a bank question', 'POST /v1/exams/bank/questions/:id/retire': 'Retire a bank question',
  'POST /v1/exams/integrity-cases/:submissionId/resolve': 'Resolve an integrity case',
  'GET /v1/faq': 'Reusable answers', 'POST /v1/faq/:id/review': 'Approve or reject a reusable answer', 'POST /v1/faq/:id/retire': 'Retire a reusable answer',
  'POST /v1/grading/benchmark': 'Run the grader benchmark', 'GET /v1/grading/submissions': 'Find submissions', 'GET /v1/grading/submissions/:id/history': 'Grade history of a submission', 'POST /v1/grading/submissions/:id/complete': 'Complete a manual grade',
  'POST /v1/grading/submissions/:id/overrides': 'Propose a grade change', 'GET /v1/grading/overrides': 'List grade changes', 'GET /v1/grading/overrides/:id': 'One grade change with preview', 'POST /v1/grading/overrides/:id/decide': 'Approve or reject a grade change', 'POST /v1/grading/sweep': 'Run the grading sweep now',
  'GET /v1/incidents/:id/evidence': 'Time-limited link to incident evidence', 'POST /v1/proctor/attempts/:id/incidents': 'Record a manual incident', 'POST /v1/proctor/attempts/:id/verify-id': 'Record a centre ID check', 'POST /v1/proctoring/webhook': 'Proctoring provider webhook (signed)',
  'GET /v1/labs/slots': 'List lab slots', 'POST /v1/labs/slots': 'Create a lab slot', 'POST /v1/labs/slots/:id/book': 'Book a slot', 'POST /v1/labs/slots/:id/cancel': 'Cancel a slot', 'GET /v1/labs/slots/:id/roster': 'Slot roster', 'GET /v1/labs/slots/:id/qr': 'Check-in code for a slot',
  'POST /v1/labs/slots/:id/attendance': 'Teacher-marked attendance', 'POST /v1/labs/attendance': 'Check in with a slot code', 'POST /v1/labs/activities/:id/ack': 'Acknowledge the safety notice', 'POST /v1/labs/bookings/:id/cancel': 'Cancel a booking',
  'POST /v1/labs/bookings/:id/complete': 'Force-complete a booking', 'POST /v1/labs/bookings/:id/evidence': 'Attach lab evidence', 'PUT /v1/labs/evidence/upload': 'Upload lab evidence (raw bytes)',
  'POST /v1/learning-events': 'Send learning events (idempotent by eventId)',
  'GET /v1/me/completion': 'Programme completion status', 'GET /v1/me/consents': 'My consents', 'PUT /v1/me/consents': 'Record a consent decision', 'GET /v1/me/preferences': 'My preferences', 'PUT /v1/me/preferences': 'Save my preferences',
  'GET /v1/me/entitlements': 'My entitlements', 'GET /v1/me/entitlements/:id/progress': 'Progress through an entitlement', 'GET /v1/me/exams': 'My exams and sessions', 'GET /v1/me/exam-attempts/:id': 'My attempt result', 'POST /v1/me/exam-attempts/:id/appeal': 'Appeal an exam result',
  'GET /v1/me/labs': 'My lab activities and bookings', 'GET /v1/me/notifications': 'My notifications', 'POST /v1/me/notifications/:id/read': 'Mark a notification read',
  'GET /v1/me/doubts': 'My doubts', 'GET /v1/me/doubts/:id': 'One of my doubts', 'POST /v1/me/doubts/:id/messages': 'Add a message', 'POST /v1/me/doubts/:id/appointments': 'Request an appointment', 'POST /v1/me/doubts/:id/rating': 'Rate the answer', 'POST /v1/me/doubts/:id/reopen': 'Reopen a doubt',
  'GET /v1/me/privacy/requests': 'My privacy requests', 'POST /v1/me/privacy/requests': 'File a privacy request', 'GET /v1/me/privacy/requests/:id/download': 'Download my data export',
  'GET /v1/me/sessions': 'My signed-in devices', 'DELETE /v1/me/sessions/:id': 'Sign out one device', 'GET /v1/me/submissions': 'My submissions', 'GET /v1/me/submissions/:id': 'One submission with feedback', 'POST /v1/me/submissions/:id/appeal': 'Appeal a grade',
  'GET /v1/media/stream/:token': 'Stream a signed file (HTTP Range supported)', 'GET /v1/media/hls/:token': 'Adaptive playlist with re-signed references',
  'GET /v1/moderation/queue': 'Grading moderation queue', 'GET /v1/moderation/tasks/:id': 'One moderation task', 'POST /v1/moderation/tasks/:id/claim': 'Claim a task', 'POST /v1/moderation/tasks/:id/release': 'Release a claimed task', 'POST /v1/moderation/tasks/:id/decide': 'Decide a task',
  'POST /v1/offline/devices': 'Register a device public key', 'POST /v1/offline/devices/:deviceId/revoke': 'Revoke a device', 'POST /v1/offline/licenses': 'Issue an offline licence and download link', 'GET /v1/offline/licenses': 'Check licence validity',
  'GET /v1/ops/integrity': 'Run platform integrity checks',
  'POST /v1/privacy/process': 'Process due privacy requests now', 'GET /v1/privacy/requests': 'Privacy request queue', 'GET /v1/privacy/requests/:id': 'One request with erasure pre-check', 'POST /v1/privacy/requests/:id/decide': 'Decide a request', 'POST /v1/privacy/requests/on-behalf': 'File a request for a person', 'POST /v1/privacy/retention/run': 'Run retention', 'PUT /v1/privacy/users/:id/legal-hold': 'Set or clear a legal hold',
  'POST /v1/quiz-attempts/:id/submit': 'Submit a quiz attempt',
  'GET /v1/reports/progress': 'Learner progress report', 'GET /v1/reports/exams': 'Exam results report', 'GET /v1/reports/grading': 'Grading report', 'GET /v1/reports/doubts': 'Doubt-centre report', 'GET /v1/reports/tutor': 'Tutor usage report',
  'GET /v1/teacher/tickets': 'Teacher queue', 'GET /v1/teacher/tickets/:id': 'One ticket', 'POST /v1/teacher/tickets/:id/claim': 'Claim a ticket', 'POST /v1/teacher/tickets/:id/reply': 'Reply to a learner', 'POST /v1/teacher/tickets/:id/resolve': 'Resolve a ticket',
  'POST /v1/teacher/tickets/:id/propose-faq': 'Propose a reusable answer', 'GET /v1/teacher/tickets/:id/attachment': 'Download a ticket attachment', 'GET /v1/teacher/appointments': 'My appointments', 'POST /v1/teacher/appointments/:id/confirm': 'Confirm an appointment', 'GET /v1/teacher/profile': 'My teacher profile', 'PUT /v1/teacher/profile': 'Update my teacher profile',
  'GET /v1/topics/:id': 'Topic content for a learner', 'GET /v1/topics/:id/playback': 'Signed playback manifest (adaptive, single-file, or low-bandwidth)', 'GET /v1/topics/:id/remediation': 'Remediation for a failed quiz', 'POST /v1/topics/:id/quiz/start': 'Start a quiz attempt',
  'POST /v1/topics/:id/assignment/submit': 'Submit an assignment', 'PUT /v1/topics/:id/assignment/upload': 'Upload an assignment file (raw bytes)',
  'POST /v1/tutor/ask': 'Ask the grounded tutor', 'GET /v1/tutor/conversations': 'My tutor conversations', 'GET /v1/tutor/conversations/:id': 'One conversation', 'POST /v1/tutor/conversations/:id/escalate': 'Escalate to a teacher', 'POST /v1/tutor/messages/:id/feedback': 'Rate an answer',
  'POST /v1/tutor/benchmark': 'Run the tutor benchmark', 'GET /v1/tutor/index/:versionId': 'Tutor index status', 'POST /v1/tutor/index/:versionId': 'Rebuild the tutor index',
};

/** Routes whose request body is a raw byte stream, not JSON. `query` names the file-name parameter. */
export const RAW_UPLOADS = new Set(['PUT /v1/authoring/assets/:id/files/:label', 'PUT /v1/doubts/upload', 'PUT /v1/labs/evidence/upload', 'PUT /v1/topics/:id/assignment/upload']);
/** Routes whose success response is bytes or text rather than JSON. */
export const BINARY_RESPONSES: Record<string, { mime: string; description: string; statuses: number[] }> = {
  'GET /v1/media/stream/:token': { mime: 'application/octet-stream', description: 'File bytes. Honours the Range header (206 with Content-Range, 416 when unsatisfiable).', statuses: [200, 206] },
  'GET /v1/media/hls/:token': { mime: 'application/vnd.apple.mpegurl', description: 'HLS playlist whose references are signed, expiring URLs.', statuses: [200] },
  'GET /v1/teacher/tickets/:id/attachment': { mime: 'application/octet-stream', description: 'Attachment bytes with a Content-Disposition filename.', statuses: [200] },
  'GET /v1/me/privacy/requests/:id/download': { mime: 'application/json', description: 'The data export as a JSON file.', statuses: [200] },
  'GET /metrics': { mime: 'text/plain', description: 'Prometheus exposition format.', statuses: [200] },
};
/** Extra request headers (signed webhooks). */
export const HEADERS: Record<string, { name: string; description: string; required: boolean }[]> = {
  'POST /v1/admissions/applications': [{ name: 'X-Timestamp', description: 'Unix milliseconds; rejected if more than 5 minutes from server time.', required: true }, { name: 'X-Signature', description: 'HMAC-SHA256 of "<timestamp>.<raw body>" with the shared secret, hex.', required: true }],
  'POST /v1/proctoring/webhook': [{ name: 'X-Timestamp', description: 'Unix milliseconds.', required: true }, { name: 'X-Signature', description: 'HMAC-SHA256 of the raw body per docs/proctor-provider-contract.md.', required: true }],
};
/** Query parameters that are not strings. */
export const QUERY_TYPES: Record<string, { type: string; description?: string }> = {
  limit: { type: 'integer', description: 'Page size.' }, cursor: { type: 'string', description: 'Opaque cursor from the previous page\'s X-Next-Cursor header.' },
  name: { type: 'string', description: 'File name with an allowed extension.' }, mode: { type: 'string', description: '"low" for audio + transcript first.' }, language: { type: 'string', description: 'Content language: en or hi.' },
};

/** Contracts that cannot be inferred from traffic (self-describing or schema-of-schemas routes). They override the inferred file. */
export const MANUAL_CONTRACTS: Record<string, { responses: Record<string, Record<string, any>> }> = {
  'GET /v1/openapi.json': { responses: { '200': { type: 'object', required: ['openapi', 'info', 'paths', 'components'], properties: { openapi: { type: 'string', const: '3.1.0' }, info: { type: 'object' }, paths: { type: 'object' }, components: { type: 'object' }, tags: { type: 'array' }, servers: { type: 'array' } } } } },
};
