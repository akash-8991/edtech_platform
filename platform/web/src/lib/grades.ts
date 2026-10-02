import type { GradeState } from '../api/types';

export interface StateInfo { label: string; tone: 'ok' | 'warn' | 'muted'; pending: boolean; blurb: string }
/** What each grading state means to a learner, in plain language. `pending` states are refreshed automatically. */
export function describeState(state: GradeState): StateInfo {
  switch (state) {
    case 'PENDING_AI': return { label: 'Being evaluated', tone: 'warn', pending: true, blurb: 'Your submission is being evaluated. This usually takes a few minutes; this page updates by itself.' };
    case 'MODERATION_REQUIRED': return { label: 'With a teacher', tone: 'warn', pending: true, blurb: 'A teacher is reviewing your submission. You will be notified when feedback is ready.' };
    case 'APPEALED': return { label: 'Appeal under review', tone: 'warn', pending: true, blurb: 'Your appeal is being reviewed by a teacher who was not involved in the original grade.' };
    case 'GRADED': return { label: 'Graded', tone: 'ok', pending: false, blurb: '' };
    case 'FINAL': return { label: 'Final', tone: 'ok', pending: false, blurb: '' };
    default: return { label: state.toLowerCase().replace(/_/g, ' '), tone: 'muted', pending: false, blurb: '' };
  }
}
export const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${Math.round(n * 10) / 10}%` : '');
/** "2 days left" / "closes today" / "closed" for an appeal deadline. */
export function appealWindow(deadlineIso: string | null | undefined, now = Date.now()): string {
  if (!deadlineIso) return ''; const ms = Date.parse(deadlineIso) - now; if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'The appeal window has closed.'; const days = Math.floor(ms / 86_400_000);
  return days >= 1 ? `You can appeal for ${days} more day${days > 1 ? 's' : ''} (until ${new Date(deadlineIso).toLocaleDateString(undefined, { dateStyle: 'medium' })}).` : 'The appeal window closes today.';
}
