import type { CaseFile, GradeRecordView, RubricDim } from '../api/types';

/** Plain-language names for the reasons the grading engine routes work to a person. Unknown reasons are shown as written. */
export function describeReason(r: string): string {
  if (r.startsWith('integrity:')) return `Integrity flag: ${r.slice(10).replace(/_/g, ' ')}`;
  if (r.startsWith('appeal:')) return `Learner's appeal: ${r.slice(7).trim()}`;
  return ({ ai_unavailable: 'The AI could not grade this (unavailable)', low_confidence: 'The AI was not confident enough to decide alone', borderline: 'The score is close to the pass mark', random_quality_sample: 'Random quality check of an automatic grade', mandatory_moderation: 'This rubric dimension always needs a person' } as Record<string, string>)[r] ?? r.replace(/_/g, ' ');
}
export const kindLabel = (k: string) => ({ BLOCKING: 'Needs a grade', SAMPLE: 'Quality check', APPEAL: 'Appeal' } as Record<string, string>)[k] ?? k.toLowerCase();
export const ageText = (min: number) => (min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`);
export const hasIntegrityFlag = (reasons: string[]) => reasons.some((r) => r.startsWith('integrity:'));

/** The same weighted formula the server uses (see domain/grading.ts computeScore), for a live preview only: the server computes the real grade, including any late penalty. */
export function estimatePercent(dims: RubricDim[], scores: Record<string, number | undefined>): number {
  const total = dims.reduce((s, d) => s + d.weight, 0) || 1;
  const sum = dims.reduce((s, d) => { const raw = scores[d.id] ?? d.min; const sc = Math.min(d.max, Math.max(d.min, raw)); return s + (((sc - d.min) / (d.max - d.min)) * 100 * d.weight) / total; }, 0);
  return Math.round(sum * 100) / 100;
}
/** Whether a typed score is acceptable to the server: within the dimension's range, in half-point steps. */
export const scoreError = (d: RubricDim, v: string): string | null => {
  if (v.trim() === '') return 'Enter a score.'; const n = Number(v); if (!Number.isFinite(n)) return 'Enter a number.';
  if (n < d.min || n > d.max) return `Between ${d.min} and ${d.max}.`; if ((n * 2) % 1 !== 0) return 'Use half-point steps (for example 2 or 2.5).'; return null;
};
export const lastRecord = (c: Pick<CaseFile, 'records'>): GradeRecordView | undefined => c.records[c.records.length - 1];
/** "Confirm the AI's grade" is only offered when the latest grade really is the AI's. */
export const canConfirmAi = (c: Pick<CaseFile, 'records'>) => lastRecord(c)?.kind === 'AI';

export interface DecisionInput { scores: Record<string, string>; feedback: string; reason: string; integrity: '' | 'CLEARED' | 'CONFIRMED_CONCERN'; outcome: '' | 'UPHELD' | 'ADJUSTED'; confirmAi: boolean }
/** Everything the server will check, checked here first so the moderator gets one clear message instead of a rejected request. */
export function validateDecision(c: CaseFile, d: DecisionInput): string[] {
  const out: string[] = [];
  if (!d.reason.trim()) out.push('Write the reason for your decision (it is recorded in the audit trail).');
  if (!d.confirmAi) for (const dim of c.policy.dimensions) { const e = scoreError(dim, d.scores[dim.id] ?? ''); if (e) out.push(`${dim.name}: ${e}`); }
  if (c.task.kind === 'BLOCKING' && hasIntegrityFlag(c.reasons) && !d.integrity) out.push('Decide on the integrity flag: cleared, or concern confirmed.');
  if (c.task.kind === 'APPEAL' && !d.outcome) out.push('Say whether the original grade is upheld or adjusted.');
  if (c.task.kind === 'APPEAL' && d.outcome === 'UPHELD' && !d.confirmAi) {
    const prev = lastRecord(c); if (prev) { const est = estimatePercent(c.policy.dimensions, Object.fromEntries(Object.entries(d.scores).map(([k, v]) => [k, Number(v)]))); if (Math.abs(est - prev.rawPercent) > 0.01) out.push('"Upheld" means the grade is unchanged. Your scores differ from the original: choose "Adjusted", or restore the original scores.'); }
  }
  return out;
}
