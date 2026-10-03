import type { PrivacyCase, PrivacyCaseDetail } from '../api/types';
import { typeLabel } from './privacy';

export { typeLabel };
export const caseStatus = (s: string): { label: string; tone: 'ok' | 'warn' | 'muted' } => ({ REQUESTED: { label: 'Needs a decision', tone: 'warn' }, APPROVED: { label: 'Approved: waiting to be carried out', tone: 'warn' }, PROCESSING: { label: 'Being carried out', tone: 'warn' }, COMPLETED: { label: 'Done', tone: 'ok' }, REJECTED: { label: 'Declined', tone: 'muted' }, BLOCKED: { label: 'Could not be completed', tone: 'warn' } } as Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }>)[s] ?? { label: s.toLowerCase(), tone: 'muted' };
/** How long a request has been open, in words. Oldest first is the order to work in; no legal deadline is configured, so none is claimed. */
export function waiting(iso: string, now = Date.now()): string { const d = Math.floor((now - Date.parse(iso)) / 86_400_000); return d < 1 ? 'today' : d === 1 ? '1 day' : `${d} days`; }
export function describeDetails(r: Pick<PrivacyCase, 'type' | 'details'>): string {
  const d = r.details ?? {};
  if (r.type === 'CORRECTION') return [d.name && `Change the name to “${d.name}”`, d.language && `change the language to ${d.language === 'hi' ? 'Hindi' : 'English'}`].filter(Boolean).join(', ') || 'No change was described.';
  if (r.type === 'ERASURE') return d.reason ? `Reason given: ${d.reason}` : 'No reason was given.';
  return 'A copy of everything the platform holds about them, for them to download.';
}
export const ERASURE_KEPT = 'Their grades, submissions, exam results, lab attendance, learning events, consent history and the audit trail are kept (pseudonymised) for the retention period. Their name, email, password, tutor chats, ticket text, attachments, notifications, devices and sign-ins are removed, and the proctoring vendor is asked to erase their data.';
export function erasureBlockers(s: PrivacyCaseDetail['subject']): string[] {
  const out: string[] = []; if (s.erased) out.push('This account has already been erased.'); if (s.legalHold) out.push('A legal hold applies: erasure will not run until it is lifted.'); if (s.activeEntitlements) out.push(`They still have ${s.activeEntitlements} active course${s.activeEntitlements === 1 ? '' : 's'}: erasure will not run until those end or are revoked.`);
  return out;
}
/** Why this person cannot decide the request, if they cannot (the server checks it too). */
export function decideBlock(r: Pick<PrivacyCase, 'status' | 'requestedById' | 'userId'>, meId: string): string | null {
  if (r.status !== 'REQUESTED') return 'This request has already been decided.';
  return r.requestedById === meId || r.userId === meId ? 'You filed this request or it is about you, so someone else must decide it.' : null;
}
export function describeResult(r: Pick<PrivacyCase, 'type' | 'result'>): string[] {
  const x = r.result ?? {}; const out: string[] = [];
  if (x.reason) out.push(`Stopped: ${x.reason}.`);
  if (x.lastError) out.push(`The last attempt failed: ${x.lastError}. It will be tried again.`);
  if (typeof x.bytes === 'number') out.push(`The export is ${Math.max(1, Math.round(x.bytes / 1024))} KB.`);
  if (Array.isArray(x.applied)) out.push(`Changed: ${x.applied.join(', ')}.`);
  if (x.redacted) out.push(`Removed or redacted: ${Object.entries(x.redacted as Record<string, number>).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(', ') || 'nothing to remove'}.`);
  for (const [k, v] of Object.entries((x.external ?? {}) as Record<string, string>)) out.push(`${k === 'proctoringProvider' ? 'Proctoring vendor' : k}: ${v}${/FAILED|no erasure API/.test(v) ? ' (follow up by hand)' : ''}.`);
  if (Array.isArray(x.retained)) out.push(`Kept: ${x.retained.join('; ')}.`);
  return out;
}
export const actionLabel = (a: string) => ({ 'privacy.request_filed': 'Filed', 'privacy.request_approved': 'Approved', 'privacy.request_rejected': 'Declined', 'privacy.export_generated': 'Export prepared', 'privacy.export_downloaded': 'Downloaded by the person', 'privacy.correction_applied': 'Correction applied', 'privacy.erasure_completed': 'Erasure carried out' } as Record<string, string>)[a] ?? a.replace(/[._]/g, ' ');

export function validateOnBehalf(f: { userId: string; type: string; name: string; language: string; reason: string }): string | null {
  if (!f.userId) return 'Choose the person this is for.'; if (!['EXPORT', 'CORRECTION', 'ERASURE'].includes(f.type)) return 'Choose what they asked for.';
  if (f.type === 'CORRECTION' && !f.name.trim() && !f.language) return 'Say what to correct: the name, the language, or both.';
  return null;
}
export const retentionLabel = (k: string) => ({ notifications: 'old notifications', tutorMessages: 'old tutor messages (text is blanked)', webhookEvents: 'old proctoring callbacks', sessions: 'expired sign-ins', oidcLogins: 'expired single-sign-on handshakes', exports: 'expired data downloads' } as Record<string, string>)[k] ?? k;
/** Who a request is about. After an erasure the name is gone, so the account's short ID is shown to tell requests apart. */
export const who = (r: Pick<PrivacyCase, 'userName' | 'userId'>) => (r.userName && r.userName !== 'Erased learner' ? r.userName : `Erased account ${r.userId.slice(0, 8)}`);
