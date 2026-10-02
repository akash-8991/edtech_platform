export const fmtTime = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const notificationText = (type: string): string => ({
  'topic.completed': 'You completed a topic.', 'exam.registered': 'You are registered for an exam session.', 'exam.submitted': 'Your exam was submitted.', 'exam.result_released': 'Your exam result has been released.', 'assignment.graded': 'Your assignment has been graded.', 'assignment.under_review': 'A teacher is reviewing your assignment.', 'assignment.appeal_decided': 'Your grade appeal has been decided.', 'programme.completed': 'Congratulations, you completed the programme.', 'topic.unlocked': 'A new topic is unlocked.', 'entitlement.expiring': 'Your access ends soon.',
  'doubt.reply': 'A teacher replied to your doubt.',
} as Record<string, string>)[type] ?? type.replace(/[._]/g, ' ');
/** Where a notification should take the learner, if anywhere. */
export const notificationLink = (type: string, payload?: Record<string, unknown>): string | null =>
  type.startsWith('assignment.') && typeof payload?.submissionId === 'string' ? `/grades/${payload.submissionId}` : type.startsWith('exam.') && typeof payload?.attemptId === 'string' && type !== 'exam.registered' ? `/exam-results/${payload.attemptId}` : null;
export const idempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9_\-:.]/g, '');
