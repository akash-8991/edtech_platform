/** Shapes returned by the platform API (see platform/docs/guides/03-user-guide.md). Only the fields the client uses. */
export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; roles: string[] }
export interface Me { id: string; email: string; name: string; language: string; roles: string[]; mfaEnabled: boolean }
export interface EntitlementSummary { id: string; versionId: string; status: string; effectiveStatus: string; learningAccess: boolean; startAt: string; endAt: string; cohort?: string }
export interface CatalogueItem { versionId: string; code: string; title: string; discipline?: string; hours?: number }
export interface TopicProgress {
  topicId: string; title: string; unlocked: boolean; videoDone: boolean; quizPassed: boolean; assignmentSubmitted: boolean;
  assignmentState: string | null; complete: boolean; resumeSec: number; quizAttemptsRemaining: number | null;
}
export interface Progress { entitlementId: string; percentComplete: number; topics: TopicProgress[] }
export interface Interaction { id: string; atSec: number; kind: string; prompt?: string; options?: string[]; required?: boolean }
export interface Stream { label: string; mime: string; url: string }
export interface Playback { assetId: string; language: string; durationSec: number; mode: 'low' | 'normal'; streams: Stream[]; interactions: Interaction[]; resume: { sec: number } }
export interface TopicDetail {
  id: string; title: string; outcomes?: string[]; assets: { id: string; kind: string; language: string; durationSec: number }[];
  quiz: { passPercent: number; maxAttempts: number; questions: number } | null;
  assignment: { instructions?: string; rubricDimensions?: { id: string; name?: string }[] } | null;
  progress: { videoDone?: boolean; quizPassed?: boolean; assignmentSubmitted?: boolean };
}
export interface QuizQuestion { id: string; type: 'MCQ_SINGLE' | 'MCQ_MULTI' | 'NUMERIC' | string; text: string; options?: string[] }
export interface QuizStart { attemptId: string; questions: QuizQuestion[] }
export interface QuizResult { passed: boolean; scorePercent?: number; attemptsRemaining?: number; rationale?: unknown; [k: string]: unknown }
export interface Notification { id: string; type: string; payload?: Record<string, unknown>; readAt?: string | null; createdAt: string }
export interface Doubt { id: string; subject: string; status: string; category?: string; createdAt: string }
export interface TutorAnswer { status?: string; answer?: string; citations?: { topicId?: string; title?: string; text?: string }[]; conversationId?: string; messageId?: string; [k: string]: unknown }
export interface LearningEvent { eventId: string; topicId: string; type: 'VIDEO_HEARTBEAT' | 'INTERACTION_RESPONSE'; occurredAt: string; payload: Record<string, unknown> }
export interface EventResult { eventId: string; status: 'accepted' | 'duplicate' | 'rejected'; reason?: string }

// ---- exams ----
export interface EligibilityCheck { key: string; ok: boolean; detail?: string }
export interface ExamSessionInfo { id: string; startsAt: string; endsAt: string; mode: 'REMOTE' | 'CENTRE' | string; centre?: string | null; registered: boolean }
export interface ExamAttemptInfo { id: string; attemptNo: number; status: 'CHECKED_IN' | 'READY' | 'IN_PROGRESS' | 'SUBMITTED' | string; result: 'RELEASED' | 'PENDING' | null }
export interface ExamInfo {
  examId: string; code: string; title: string; durationMin: number; mode: string; passPercent: number;
  eligibility: { eligible: boolean; overridden: boolean; checks: EligibilityCheck[] };
  consent: { text: string; hash: string }; sessions: ExamSessionInfo[]; attempts: ExamAttemptInfo[];
}
export interface DeviceReport { browserSupported: boolean; camera: boolean; microphone: boolean; screens: number; bandwidthKbps: number }
export interface CheckInResult { attemptId: string; status: string; device: { ok: boolean; problems: string[] }; idCheck?: string; launchUrl: string | null; mode: string }
export interface ExamQuestion { id: string; tag?: string; type: 'MCQ_SINGLE' | 'MCQ_MULTI' | 'NUMERIC' | string; text: string; options: string[]; points: number }
export interface ExamStart { attemptId: string; sessionToken: string; serverTime: string; deadlineAt: string; watermark: string; questions: ExamQuestion[]; saveSeq?: number; answers?: Record<string, unknown>; remainingMs?: number }
export interface SaveResult { saved: boolean; saveSeq: number; remainingMs: number; serverTime: string }
export interface ExamReceipt { receiptCode: string; submittedAt: string; autoSubmitted: boolean; answered: number }
export interface ExamResult {
  attemptId: string; status: string; receiptCode: string | null; submittedAt: string | null;
  state?: 'RELEASED' | 'INVALIDATED' | 'AWAITING_RELEASE' | 'UNDER_REVIEW'; percent?: number; passed?: boolean; passMark?: number;
  sections?: Record<string, { percent: number }>; message?: string; reason?: string; appeal?: { eligible: boolean };
}
export interface Completion { topics: { complete: boolean; percent: number }; labs: { complete: boolean; outstanding: string[] }; exams: { code: string; passed: boolean }[]; programmeComplete: boolean }
export type SignalKind = 'FOCUS_LOST' | 'FULLSCREEN_EXIT' | 'COPY' | 'PASTE';

// ---- assignment grades ----
export type GradeState = 'PENDING_AI' | 'MODERATION_REQUIRED' | 'GRADED' | 'APPEALED' | 'FINAL' | string;
export interface SubmissionSummary { submissionId: string; topicId: string; attemptNo?: number; submittedAt?: string; state: GradeState; finalPercent?: number | null; passed?: boolean | null }
export interface GradeEvidence { quote: string; location?: string }
export interface GradeDimension { id: string; name?: string; score: number; max: number; rationale?: string; evidence: GradeEvidence[] }
export interface GradeView {
  submissionId: string; topicId: string; state: GradeState; message?: string;
  finalPercent?: number | null; rawPercent?: number | null; latePenaltyPercent?: number | null; passed?: boolean | null; passMark?: number;
  dimensions?: GradeDimension[]; feedback?: string | null; gradedBy?: string; appeal?: { eligible: boolean; deadline?: string | null; appealed: boolean };
}

// ---- privacy and account ----
export interface Consent { purpose: 'PLATFORM_PROCESSING' | 'AI_TUTOR' | 'ANALYTICS' | string; granted: boolean; version: string | null; at: string | null; currentNoticeVersion: string; upToDate: boolean }
export type RequestType = 'EXPORT' | 'CORRECTION' | 'ERASURE';
export interface PrivacyRequest { id: string; type: RequestType | string; status: string; requestedAt: string; completedAt?: string | null; exportExpiresAt?: string | null; decisionReason?: string | null }
export interface Prefs {
  captions?: boolean; transcriptByDefault?: boolean; audioDescription?: boolean; highContrast?: boolean; reducedMotion?: boolean; lowBandwidth?: boolean; largeTargets?: boolean;
  playbackSpeed?: number; fontScale?: number; language?: 'en' | 'hi'; captionLanguage?: 'en' | 'hi'; textSpacing?: 'normal' | 'wide' | 'wider';
}
export interface SessionInfo { id: string; current: boolean; method: string; mfa: boolean; device?: string; createdAt: string; lastSeenAt?: string; expiresAt: string }

// ---- labs ----
export interface LabBookingInfo { id: string; slotId: string; status: 'BOOKED' | 'ATTENDED' | 'NO_SHOW' | 'CANCELLED' | string; completed: boolean; evidenceSubmitted: boolean; slot?: { startsAt: string; endsAt: string; location?: string; batchCode?: string; cancelled: boolean } }
export interface LabActivity {
  activityId: string; code: string; title: string; mandatory: boolean; location?: string; manual?: string; safetyText: string; safetyHash: string; requireEvidence: boolean;
  eligibility: { eligible: boolean; missingPrerequisiteTopics: string[]; safetyAcknowledged: boolean }; bookings: LabBookingInfo[]; completed: boolean;
}
export interface LabSlot { id: string; batchCode: string; startsAt: string; endsAt: string; location?: string; capacity: number; seatsLeft: number }
export interface UploadedFile { key: string; name: string; size: number; checksum: string }

// ---- staff console ----
export interface Application { id: string; externalRef: string; email: string; name: string; programmeCode: string; duration: 'M12' | 'M18' | string; cohort: string; status: 'RECEIVED' | 'APPROVED' | 'REJECTED' | 'RETURNED' | string; reason?: string | null; createdAt: string; decidedAt?: string | null }
export interface ImportResult { summary: { created: number; duplicate: number; invalid: number }; results: { externalRef?: string; result: 'created' | 'duplicate' | 'invalid'; errors?: string[]; id?: string }[] }
export interface RosterRow { bookingId: string; learnerId: string; name?: string; status: string; attendanceMethod?: string | null; evidenceFiles: number; completed: boolean }
export interface StaffSlot extends LabSlot { status?: 'OPEN' | 'CANCELLED' | string }
export interface LabActivityDef { id: string; code: string; title: string; location?: string; versionId: string; requireEvidence: boolean; mandatory: boolean }
export interface ConfigItem { key: string; doc: string; kind: 'boolean' | 'number' | 'string[]' | 'map' | 'numbermap' | string; value: unknown }
export interface IntegrityReport { ok: boolean; checkedAt: string; audit: { events: number; intact: boolean; firstBroken: number | null }; examLogs: { attempts: number; broken: string[] }; counts: Record<string, number>; orphans: Record<string, number> }
export interface ExamOpsStatus { inProgress: number; staleAutosave: number; expiringWithin5Min: number; highSessionSwitches: number; openIncidents: Record<string, number>; heldResults: number; awaitingRelease: number; remoteAwaitingProctorReport: number; openAppeals: number }

// ---- grading moderation ----
export interface ModerationRow { taskId: string; kind: 'BLOCKING' | 'SAMPLE' | 'APPEAL' | string; status: 'OPEN' | 'CLAIMED' | 'DONE' | string; reasons: string[]; ageMinutes: number; submissionId: string; learnerRef: string; aiPercent: number | null; claimedById: string | null }
export interface RubricLevel { score: number; descriptor: string }
export interface RubricDim { id: string; name: string; weight: number; min: number; max: number; levels?: RubricLevel[]; evidenceRequired?: boolean }
export interface GradeRecordView {
  seq: number; kind: 'AI' | 'MODERATED' | 'APPEAL' | 'OVERRIDE' | string; dimensions: { id: string; score: number; max: number; rationale?: string; evidence?: { quote: string; location?: string; verified?: boolean }[]; confidence?: number }[];
  rawPercent: number; latePenaltyPercent: number; finalPercent: number; passed: boolean; confidence?: number | null; flags?: string[]; feedback?: string; model?: string | null; promptVersion?: number | null; createdById?: string | null; reason?: string | null; at: string;
}
export interface CaseFile {
  task: { id: string; kind: string; status: string; reasons: string[]; claimedById: string | null };
  learnerRef: string; attemptNo: number; submittedAt: string; assignment: { instructions: string };
  policy: { dimensions: RubricDim[]; passPercent: number; appealWindowDays: number };
  submission: { text: string; files: { name?: string; key?: string; size?: number }[]; contentHash: string; testResults: unknown };
  state: string; reasons: string[]; records: GradeRecordView[]; similarity: { score: number; otherRef: string; excerpt: string }[];
}
export interface DecideResult { state: string; finalPercent: number; passed: boolean; seq: number }

export interface IncidentRow { id: string; attemptId: string; source: string; type: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | string; status: string; occurredAt: string; hasEvidence: boolean; ageMinutes: number }
export interface AppealRow { id: string; attemptId: string; reason: string; status: string; filedAt: string }
export interface ExamCaseFile {
  attemptId: string; learnerRef: string; attemptNo: number; mode: string; status: string; resultState: string; outcome: string | null; deviceCheck: unknown; idCheck: unknown; sessionSwitches: number; autoSubmitted: boolean;
  accommodations: { type: string; extraTimePercent: number | null }[]; startedAt: string | null; submittedAt: string | null; proctorReportFinal: boolean;
  incidents: { id: string; source: string; type: string; severity: string; status: string; occurredAt: string; hasEvidence: boolean; decisionReason: string | null }[];
  timeline: { seq: number; type: string; at: string; payload: Record<string, unknown> }[];
}
export interface LogCheck { events: number; intact: boolean; firstBrokenIndex: number | null }

export type VersionState = 'DRAFT' | 'FACULTY_REVIEW' | 'FACULTY_APPROVED' | 'ADMIN_APPROVAL' | 'PUBLISHED' | 'RETIRED';
export interface VersionSummary { id: string; version: number; state: VersionState; hours: number; authorId: string; authorName: string | null; languages: string[]; provenance: Record<string, unknown>; createdAt: string; publishedAt: string | null }
export interface ProgrammeRow { id: string; code: string; title: string; discipline: string; versions: VersionSummary[] }
export interface AuthoredQuestion { id?: string; position: number; type: 'MCQ_SINGLE' | 'MCQ_MULTI' | 'NUMERIC' | string; text: string; options: string[]; answer: number | number[]; tolerance?: number; points: number; rationale?: string | null; i18n?: unknown }
export interface AuthoredAsset { id: string; kind: string; language: string; durationSec: number | null; files: Record<string, { checksum: string; size: number }>; interactions: { id: string; atSec: number; prompt?: string }[]; provenance: Record<string, unknown>; rights: Record<string, unknown>; createdById: string }
export interface AuthoredAssignment { instructions: string; rubric: { criteria?: { criterion: string; weight: number; description?: string }[] }; maxSubmissions: number; policy: Record<string, unknown>; i18n?: unknown }
export interface AuthoredTopic { id: string; position: number; title: string; hours: number; outcomes: string[]; prerequisites: string[]; mandatory: boolean; quiz: { passPercent: number; maxAttempts: number; questions: AuthoredQuestion[] } | null; assignment: AuthoredAssignment | null; assets: AuthoredAsset[] }
export interface AuthoredModule { id: string; position: number; title: string; topics: AuthoredTopic[] }
export interface VersionTree {
  id: string; version: number; state: VersionState; hours: number; outcomes: string[]; languages: string[]; provenance: Record<string, unknown>; authorId: string; createdAt: string; publishedAt: string | null;
  programme: { id: string; code: string; title: string; discipline: string }; modules: AuthoredModule[];
  approvals: { id: string; fromState: VersionState; toState: VersionState; actorId: string; reason: string | null; createdAt: string }[];
  comments: { id: string; authorId: string; target: string | null; body: string; createdAt: string }[]; people: Record<string, string>;
}
export interface QualityFinding { id: string; topicId: string | null; gate: string; severity: string; blocking: boolean; message: string; resolvedAt: string | null; resolution: string | null }
export interface A11yReport { blocking: number; advisory: number; enforced: boolean; issues: { topic: string; language?: string; severity: 'BLOCKING' | 'ADVISORY'; rule: string; message: string }[] }
export interface DiffChange { path: string; change: 'added' | 'removed' | 'changed'; from?: unknown; to?: unknown }

export interface ExamSessionCounts { total: number; inProgress: number; submitted: number; held: number; ready: number; released: number; invalidated: number }
export interface ExamIndexRow { id: string; code: string; title: string; status: string; durationMin: number; passPercent: number; publishedAt: string | null; sessions: { id: string; startsAt: string; endsAt: string; mode: string; centre: string | null; capacity: number; status: string; attempts: ExamSessionCounts }[] }
export interface ReleaseOutcome { released: number; skipped: { attemptId: string; reason: string }[] }
export interface ExamReportData {
  exam: { code: string; passPercent: number };
  funnel: { registered: number; checkedIn: number; started: number; submitted: number; released: number; held: number; invalidated: number; autoSubmitted: number };
  results: { n: number; mean: number | null; passRate: number | null; distribution: number[] };
  sections: Record<string, number>; itemAnalysis: { questionId: string; attempts: number; pValue: number }[];
  integrity: { incidents: number; byType: Record<string, number>; bySeverity: Record<string, number>; byStatus: Record<string, number>; confirmedRate: number | null; sessionTakeovers: number };
  appeals: { filed: number; overturned: number; open: number };
}

export interface DoubtRow { id: string; number: number; subject: string; category: string; priority: 'P1' | 'P2' | 'P3' | string; status: string; topicId: string | null; language: string; assignedTeacherId: string | null; assignedTeacherName: string | null; routingNote: string | null; firstResponseDueAt: string; firstResponseAt: string | null; resolvedAt: string | null; slaBreachedAt: string | null; rerouteCount: number; rating: number | null; reopenCount: number; createdAt: string; resolutionSummary: string | null }
export interface DoubtMessage { id: string; authorRole: 'LEARNER' | 'TEACHER' | 'SYSTEM' | string; internal: boolean; body: string; attachments: { key: string; name?: string; size?: number }[]; at: string }
export interface DoubtContext { course?: { programme: string; code: string; discipline: string }; topic?: { id: string; title: string } | null; conversation?: { role: string; content: string; at?: string }[]; sourcesSearched?: unknown[]; tutorStatus?: string | null; learnerProgress?: { percentComplete: number; topicsDone: number; topicsTotal: number; quizAttempts: number } }
export interface DoubtAppointment { id: string; startsAt: string; endsAt: string; status: string; meetingRef: string | null; ticketId?: string }
export interface DoubtDetail extends DoubtRow { context: DoubtContext; learner: { name: string; language: string } | null; messages: DoubtMessage[]; appointments: DoubtAppointment[] }
export interface FaqRow { id: string; programmeId: string; topicId: string | null; kind: 'FAQ' | 'REMEDIATION' | string; language: string; question: string; answer: string; status: 'DRAFT' | 'APPROVED' | 'REJECTED' | 'RETIRED' | string; sourceTicketId: string | null; proposedById: string; reviewReason: string | null; createdAt: string }
export interface TeacherWindow { day: number; start: string; end: string }
export interface TeacherRow { userId: string; name?: string; active: boolean; available: boolean; disciplines: string[]; skills: string[]; languages: string[]; capacity: number; open: number; lastAssignedAt: string | null; windows: TeacherWindow[] }
export interface DoubtReportData { since: string; tickets: number; open: number; unassigned: number; slaCompliance: number | null; avgFirstResponseMinutes: number | null; avgResolutionHours: number | null; avgRating: number | null; reopenRate: number | null; bySource: Record<string, number>; byCategory: Record<string, number>; teachers: { teacherId: string; name?: string; assigned: number; resolved: number; breaches: number; avgRating: number | null }[] }

export interface UserRow { id: string; name: string; email?: string; language: string; status: 'ACTIVE' | 'SUSPENDED' | 'ERASED' | string; createdAt: string; lastLoginAt: string | null; locked: boolean; mfaEnabled: boolean; legalHold: boolean; roles: string[]; scopedRoles: { role: string; programmeId: string | null; cohort: string | null }[] }
export interface UserDetailData extends UserRow { activeSessions: number; teacherProfile: boolean; history: { seq: number; at: string; by: string; action: string; reason: string | null; detail: unknown }[] }
export interface CreatedUser { id: string; email: string; roles: string[]; temporaryPassword?: string }
