/** Plain-language labels and the checks the server makes, so an adjudicator gets one clear message before a request is sent. */
export const INCIDENT_DECISIONS: [string, string][] = [['DISMISSED', 'Dismiss: no breach'], ['CONFIRMED_MINOR', 'Confirm: minor breach'], ['CONFIRMED_MAJOR', 'Confirm: major breach'], ['NEEDS_INFO', 'Need more information']];
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const isOpenIncident = (status: string) => status === 'OPEN' || status === 'NEEDS_INFO';
export const severityTone = (s: string): 'ok' | 'warn' | 'muted' => (s === 'CRITICAL' || s === 'HIGH' ? 'warn' : 'muted');
export const statusLabel = (s: string) => ({ OPEN: 'Open', NEEDS_INFO: 'Needs information', DISMISSED: 'Dismissed', CONFIRMED_MINOR: 'Confirmed (minor)', CONFIRMED_MAJOR: 'Confirmed (major)' } as Record<string, string>)[s] ?? s.toLowerCase().replace(/_/g, ' ');
export const resultStateLabel = (s: string) => ({ HELD: 'Held for review', READY: 'Ready to release', RELEASED: 'Released to the learner', INVALIDATED: 'Invalidated', PENDING: 'Pending' } as Record<string, string>)[s] ?? s.toLowerCase();
export const typeLabel = (t: string) => t.replace(/_/g, ' ');
export const reasonError = (r: string) => (r.trim() ? null : 'Write the reason: it is recorded in the audit trail.');

/** What the attempt still needs, in order, derived from the case file the way the server's rules run. */
export function nextStep(c: { status: string; resultState: string; outcome: string | null; proctorReportFinal: boolean; mode: string; incidents: { status: string }[] }): string {
  if (c.status !== 'SUBMITTED') return 'The attempt has not been submitted yet. Nothing can be decided until it is.';
  const open = c.incidents.filter((i) => isOpenIncident(i.status)).length;
  if (open) return `Decide ${open === 1 ? 'the open incident' : `all ${open} open incidents`} first.`;
  if (c.resultState === 'RELEASED') return 'The result has been released. A serious incident arriving later would pull it back for review.';
  if (c.resultState === 'INVALIDATED') return 'The attempt is invalidated. The learner may appeal within the appeal window.';
  if (c.resultState === 'READY') return 'Ready to release. It must be released by someone who did not decide any incident on this attempt.';
  if (c.incidents.some((i) => i.status === 'CONFIRMED_MAJOR') && !c.outcome) return 'A major breach was confirmed: set the outcome (valid or invalidated).';
  if (c.mode === 'REMOTE' && !c.proctorReportFinal) return 'Waiting for the proctoring provider\'s final report. If it will never arrive, waive it with a reason.';
  return 'Set the outcome to move this result on.';
}
export const evidenceMessage = (e: unknown): string | null => { const m = (e as { status?: number })?.status; return m === 410 ? 'That evidence link has expired. The access was logged. Ask the proctoring provider for a fresh link.' : null; };

// ---- exams and results ---------------------------------------------------------------------------------------------------------------------------
export const modeLabel = (m: string) => (m === 'REMOTE' ? 'Remote' : m === 'CENTRE' ? 'At a centre' : m);
export const percent = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
/** Why a result was skipped in a bulk release, in words (the server sends a code or its own message). */
export const skipReason = (r: string) => (r === 'not_ready_for_release' ? 'It is no longer ready (an incident came in, or the state changed).' : /segregation of duties/i.test(r) ? 'You decided something on this attempt, so someone else must release it.' : r === 'already released' ? 'Already released.' : r);
export const releaseMessage = (o: { released: number; skipped: unknown[] }) => (o.released === 0 && !o.skipped.length ? 'Nothing was ready to release.' : `Released ${o.released} result${o.released === 1 ? '' : 's'}${o.skipped.length ? `; ${o.skipped.length} could not be released.` : '.'}`);
/** Bar heights (0-100) for the score distribution; the tallest bar is full height. */
export const barHeights = (d: number[]) => { const max = Math.max(1, ...d); return d.map((n) => Math.round((n / max) * 100)); };
export const bandLabel = (i: number) => (i === 9 ? '90-100' : `${i * 10}-${i * 10 + 9}`);
