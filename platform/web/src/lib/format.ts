import { mark, tr } from './i18n';
export const fmtTime = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const NOTES: Record<string, string> = {
  'topic.completed': mark('You completed a topic.'), 'exam.registered': mark('You are registered for an exam session.'), 'exam.submitted': mark('Your exam was submitted.'), 'exam.result_released': mark('Your exam result has been released.'), 'privacy.export_ready': mark('Your data download is ready.'), 'privacy.request_decided': mark('A decision was made on your privacy request.'), 'lab.booked': mark('Your lab session is booked.'), 'lab.completed': mark('You completed a lab.'), 'lab.slot_cancelled': mark('A lab session you booked was cancelled. Please book another.'), 'assignment.graded': mark('Your assignment has been graded.'), 'assignment.under_review': mark('A teacher is reviewing your assignment.'), 'assignment.appeal_decided': mark('Your grade appeal has been decided.'), 'programme.completed': mark('Congratulations, you completed the programme.'), 'topic.unlocked': mark('A new topic is unlocked.'), 'entitlement.expiring': mark('Your access ends soon.'),
  'doubt.reply': mark('A teacher replied to your doubt.'),
};
export const notificationText = (type: string): string => { const m = NOTES[type]; return m ? tr(m) : type.replace(/[._]/g, ' '); };
/** Where a notification should take the learner, if anywhere. */
export const notificationLink = (type: string, payload?: Record<string, unknown>): string | null =>
  type.startsWith('lab.') ? '/labs' : type.startsWith('privacy.') ? '/privacy' : type.startsWith('assignment.') && typeof payload?.submissionId === 'string' ? `/grades/${payload.submissionId}` : type.startsWith('exam.') && typeof payload?.attemptId === 'string' && type !== 'exam.registered' ? `/exam-results/${payload.attemptId}` : null;
export const idempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9_\-:.]/g, '');
