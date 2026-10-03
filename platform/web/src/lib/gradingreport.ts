import type { GradingReportData } from '../api/types';
import { describeReason } from './moderation';
import { gradeState } from './gradechanges';

export const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
export const points = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${x} points`);
export function age(min: number): string { return min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`; }
export const money = (usd: number) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
/** Which way the humans lean compared with the AI, in words (positive means humans gave higher marks). */
export const biasText = (b: number | null): string => (b === null ? 'No pairs to compare yet.' : Math.abs(b) < 1 ? 'Humans and the AI score about the same on average.' : b > 0 ? `Humans score ${b} points higher than the AI on average: the AI may be marking too hard.` : `Humans score ${Math.abs(b)} points lower than the AI on average: the AI may be marking too leniently.`);
export const sampleNote = (pairs: number): string | null => (pairs === 0 ? null : pairs < 10 ? `Only ${pairs} graded both ways in this period: treat these figures as a hint, not a measure.` : null);
export const reasonLabel = (k: string) => describeReason(k);
export const stateRows = (r: Pick<GradingReportData, 'byState'>) => Object.entries(r.byState).map(([k, n]) => ({ label: gradeState(k), n }));
export const barHeights = (d: { count: number }[]) => { const m = Math.max(1, ...d.map((x) => x.count)); return d.map((x) => Math.round((x.count / m) * 100)); };
export const backlogWarn = (b: GradingReportData['backlog']) => b.pendingAi > 0 || b.openModeration > 0;
export const versionText = (k: string) => { const [m, p] = k.split('@prompt'); return `${m === 'null' || m === 'undefined' ? 'unknown model' : m}, prompt version ${p === 'null' || p === 'undefined' ? '?' : p}`; };
