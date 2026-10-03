import type { OverrideCase, PolicyDims } from '../api/types';
import { estimatePercent, scoreError } from './moderation';

export const overrideStatus = (s: string): { label: string; tone: 'ok' | 'warn' | 'muted' } => ({ PENDING: { label: 'Waiting for a second person', tone: 'warn' }, APPROVED: { label: 'Approved and applied', tone: 'ok' }, REJECTED: { label: 'Declined', tone: 'muted' } } as Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }>)[s] ?? { label: s.toLowerCase(), tone: 'muted' };
export const gradeState = (s: string) => ({ PENDING_AI: 'Waiting for the AI', MODERATION_REQUIRED: 'Waiting for a human grader', GRADED: 'Graded (learner can appeal)', APPEALED: 'Under appeal', FINAL: 'Final' } as Record<string, string>)[s] ?? s.toLowerCase().replace(/_/g, ' ');
export const recordKind = (k: string) => ({ AI: 'AI grade', MODERATED: 'Human grade', APPEAL: 'Appeal decision', OVERRIDE: 'Override' } as Record<string, string>)[k] ?? k.toLowerCase();
export const pctText = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100) / 100}%`);

/** Whether this person may approve or decline an override, and why not (the server checks too). */
export const decideBlock = (o: Pick<OverrideCase, 'status' | 'proposedById'>, meId: string): string | null =>
  o.status !== 'PENDING' ? 'This override has already been decided.' : o.proposedById === meId ? 'You proposed this override, so a different administrator must decide it.' : null;

export interface ProposalForm { scores: Record<string, string>; feedback: string; reason: string }
export const startingScores = (p: PolicyDims, current: { id: string; score: number }[] | null | undefined): Record<string, string> => Object.fromEntries(p.dimensions.map((d) => [d.id, String(current?.find((c) => c.id === d.id)?.score ?? d.min)]));
export function validateProposal(p: PolicyDims, f: ProposalForm, current: { id: string; score: number }[] | null | undefined): string[] {
  const out: string[] = [];
  for (const d of p.dimensions) { const e = scoreError({ id: d.id, name: d.name, weight: d.weight, min: d.min, max: d.max }, f.scores[d.id] ?? ''); if (e) out.push(`${d.name}: ${e}`); }
  if (!out.length && current && p.dimensions.every((d) => Number(f.scores[d.id]) === current.find((c) => c.id === d.id)?.score)) out.push('These scores are the same as the current grade. Change at least one score.');
  if (!f.reason.trim()) out.push('Write the reason for the override (it is recorded in the audit trail and shown to the person who approves it).');
  return out;
}
/** A preview of the percentage before any late penalty (the server works out the real grade, including a penalty that still applies). */
export const previewPercent = (p: PolicyDims, scores: Record<string, string>) => estimatePercent(p.dimensions.map((d) => ({ id: d.id, name: d.name, weight: d.weight, min: d.min, max: d.max })), Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.trim() === '' ? undefined : Number(v)])));
export const changeText = (from: number | null | undefined, to: number) => (from === null || from === undefined ? `to ${pctText(to)}` : `${pctText(from)} → ${pctText(to)} (${to - from >= 0 ? '+' : ''}${Math.round((to - from) * 100) / 100} points)`);
export const passText = (before: boolean | null | undefined, after: boolean) => (before === null || before === undefined || before === after ? (after ? 'Passes' : 'Does not pass') : after ? 'Changes from fail to pass' : 'Changes from pass to fail');
/** What approving does to open work on the same submission, in words. */
export const sideEffects = (state: string): string | null => (state === 'MODERATION_REQUIRED' || state === 'APPEALED' ? 'The submission is waiting for a human grader or an appeal. Approving this override settles it: the grade becomes final and the open task is closed.' : null);
export const proposeBlock = (state: string): string | null => (state === 'PENDING_AI' ? 'It has not been graded yet, so there is nothing to override.' : null);
