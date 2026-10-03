/** Entitlement actions in plain words. The server decides what is allowed; this only decides what to offer and checks the form. */
export const statusLabel = (s: string) => ({ ACTIVE: 'Active', PAUSED: 'Paused', EXPIRED: 'Expired', REVOKED: 'Revoked' } as Record<string, string>)[s] ?? s;
export const STATUS_TONE = (s: string): 'ok' | 'warn' | 'muted' => (s === 'ACTIVE' ? 'ok' : s === 'PAUSED' ? 'warn' : 'muted');
export const OVERRIDE_TYPES: [string, string, string][] = [
  ['UNLOCK_TOPIC', 'Unlock a topic', 'Lets them open a topic before its prerequisites are complete.'],
  ['EXTRA_QUIZ_ATTEMPTS', 'Extra quiz attempts', 'Adds 1 to 5 more attempts on one topic quiz.'],
  ['DEADLINE_EXTENSION', 'Extend a topic deadline', 'Adds 1 to 720 hours to one topic deadline.'],
];
export const overrideLabel = (t: string) => OVERRIDE_TYPES.find(([k]) => k === t)?.[1] ?? t.toLowerCase().replace(/_/g, ' ');
export const historyLabel = (a: string) => ({ 'entitlement.paused': 'Paused', 'entitlement.resumed': 'Resumed', 'entitlement.extended': 'Extended', 'entitlement.revoked': 'Revoked', 'entitlement.created': 'Created' } as Record<string, string>)[a]
  ?? (a.startsWith('progression.override.') ? `Progression: ${overrideLabel(a.slice('progression.override.'.length).toUpperCase())}` : a.replace(/[._]/g, ' '));

export const extendProblem = (days: string, reason: string): string | null => {
  const n = Number(days); if (!Number.isInteger(n) || n < 1 || n > 365) return 'Enter a whole number of days from 1 to 365.';
  return reason.trim() ? null : 'Write the reason: it is recorded in the audit trail.';
};
export const overrideProblem = (type: string, topicId: string, value: string, reason: string): string | null => {
  if (!topicId) return 'Choose the topic.';
  if (type === 'EXTRA_QUIZ_ATTEMPTS') { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 5) return 'Enter 1 to 5 extra attempts.'; }
  if (type === 'DEADLINE_EXTENSION') { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 720) return 'Enter 1 to 720 hours.'; }
  return reason.trim() ? null : 'Write the reason: it is recorded in the audit trail.';
};
export const daysLeft = (endAt: string, now = Date.now()) => Math.ceil((new Date(endAt).getTime() - now) / 86_400_000);
