import type { GradeState } from '../api/types';
import { fmtDate, tr } from './i18n';

export interface StateInfo { label: string; tone: 'ok' | 'warn' | 'muted'; pending: boolean; blurb: string }
/** What each grading state means to a learner, in plain language. `pending` states are refreshed automatically. */
export function describeState(state: GradeState): StateInfo {
  switch (state) {
    case 'PENDING_AI': return { label: tr('Being evaluated'), tone: 'warn', pending: true, blurb: tr('Your submission is being evaluated. This usually takes a few minutes; this page updates by itself.') };
    case 'MODERATION_REQUIRED': return { label: tr('With a teacher'), tone: 'warn', pending: true, blurb: tr('A teacher is reviewing your submission. You will be notified when feedback is ready.') };
    case 'APPEALED': return { label: tr('Appeal under review'), tone: 'warn', pending: true, blurb: tr('Your appeal is being reviewed by a teacher who was not involved in the original grade.') };
    case 'GRADED': return { label: tr('Graded'), tone: 'ok', pending: false, blurb: '' };
    case 'FINAL': return { label: tr('Final'), tone: 'ok', pending: false, blurb: '' };
    default: return { label: state.toLowerCase().replace(/_/g, ' '), tone: 'muted', pending: false, blurb: '' };
  }
}
export const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${Math.round(n * 10) / 10}%` : '');
/** "2 days left" / "closes today" / "closed" for an appeal deadline. */
export function appealWindow(deadlineIso: string | null | undefined, now = Date.now()): string {
  if (!deadlineIso) return ''; const ms = Date.parse(deadlineIso) - now; if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return tr('The appeal window has closed.'); const days = Math.floor(ms / 86_400_000); const date = fmtDate(deadlineIso, { dateStyle: 'medium' });
  return days >= 1 ? (days > 1 ? tr('You can appeal for {n} more days (until {date}).', { n: days, date }) : tr('You can appeal for 1 more day (until {date}).', { date })) : tr('The appeal window closes today.');
}
