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
