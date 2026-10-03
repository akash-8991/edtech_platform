import type { DoubtContext, DoubtRow, TeacherWindow } from '../api/types';

export const statusLabel = (s: string) => ({ NEW: 'New', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', WAITING_LEARNER: 'Waiting for the learner', RESOLVED: 'Resolved', CLOSED: 'Closed' } as Record<string, string>)[s] ?? s.toLowerCase().replace(/_/g, ' ');
export const categoryLabel = (c: string) => ({ CONTENT: 'Course content', ASSIGNMENT: 'Assignment', QUIZ: 'Quiz', TECHNICAL: 'Technical', OTHER: 'Other' } as Record<string, string>)[c] ?? c;
export const isOpen = (s: string) => s !== 'RESOLVED' && s !== 'CLOSED';
export const priorityTone = (p: string): 'warn' | 'muted' => (p === 'P1' ? 'warn' : 'muted');
export const dayName = (d: number) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d] ?? String(d);
export const langName = (l: string) => (l === 'hi' ? 'Hindi' : l === 'en' ? 'English' : l);

export function span(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}
/** Where a ticket stands against its first-response promise, in words. */
export function slaInfo(t: Pick<DoubtRow, 'firstResponseDueAt' | 'firstResponseAt' | 'status' | 'slaBreachedAt'>, now = Date.now()): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  const due = Date.parse(t.firstResponseDueAt);
  if (t.firstResponseAt) return Date.parse(t.firstResponseAt) <= due ? { text: 'First reply was on time', tone: 'ok' } : { text: 'First reply was late', tone: 'warn' };
  if (!isOpen(t.status)) return { text: 'Closed without a reply', tone: 'muted' };
  return now > due ? { text: `Overdue by ${span(now - due)}`, tone: 'warn' } : { text: `Reply due in ${span(due - now)}`, tone: due - now < 30 * 60_000 ? 'warn' : 'muted' };
}

/** The ticket's context bundle in a form that can be read at a glance. Unknown shapes are tolerated. */
export function describeContext(c: DoubtContext | null | undefined) {
  const x = c ?? {};
  return { course: x.course ? `${x.course.programme} (${x.course.code})` : null, topic: x.topic?.title ?? null,
    progress: x.learnerProgress ? `${x.learnerProgress.percentComplete}% complete (${x.learnerProgress.topicsDone} of ${x.learnerProgress.topicsTotal} required topics), ${x.learnerProgress.quizAttempts} quiz attempt${x.learnerProgress.quizAttempts === 1 ? '' : 's'}` : null,
    conversation: (x.conversation ?? []).map((m) => ({ who: m.role === 'TUTOR' ? 'AI tutor' : 'Learner', text: m.content })), sources: Array.isArray(x.sourcesSearched) ? x.sourcesSearched.length : 0 };
}

export const canReply = (t: Pick<DoubtRow, 'status' | 'assignedTeacherId'>) => isOpen(t.status) && !!t.assignedTeacherId;
export const resolveBlock = (t: Pick<DoubtRow, 'status' | 'firstResponseAt'>) => (!isOpen(t.status) ? 'This ticket is already resolved.' : !t.firstResponseAt ? 'Send the learner a reply before resolving.' : null);
export const reasonError = (r: string) => (r.trim() ? null : 'Write the reason: it is recorded in the audit trail.');

// ---- teacher directory ----------------------------------------------------------------------------------------------------------------------------
export const splitList = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];
const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validateWindows(ws: TeacherWindow[]): string | null {
  for (const w of ws) {
    if (!hhmm.test(w.start) || !hhmm.test(w.end)) return 'Every working period needs a start and an end time.';
    if (w.end <= w.start) return `${dayName(w.day)}: the end must be after the start.`;
  }
  return null;
}
export function validateTeacher(f: { capacity: string; languages: string[]; windows: TeacherWindow[] }): string | null {
  const n = Number(f.capacity); if (!Number.isInteger(n) || n < 1 || n > 100) return 'Capacity (open tickets at once) must be a whole number from 1 to 100.';
  if (!f.languages.length) return 'Choose at least one language.';
  return validateWindows(f.windows);
}
export const windowsText = (ws: TeacherWindow[]) => (ws.length ? ws.map((w) => `${dayName(w.day).slice(0, 3)} ${w.start}-${w.end}`).join(', ') : 'any time');

export function validateFaq(f: { question: string; answer: string }): string | null { return !f.question.trim() ? 'Write the question as a learner would ask it.' : !f.answer.trim() ? 'Write the answer.' : null; }
export const faqStatusLabel = (s: string) => ({ DRAFT: 'Waiting for review', APPROVED: 'Approved', REJECTED: 'Rejected', RETIRED: 'Retired' } as Record<string, string>)[s] ?? s;
export const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
