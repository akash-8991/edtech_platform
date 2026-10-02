// Pure exam rules (EXM-001..004). Eligibility, paper construction, the clock, scoring, hold/release logic: none depend on a client.
import { createHash, createHmac } from 'crypto';
import { gradeQuestion } from './progression';

export interface EligibilityRules {
  minProgrammePercent: number;                   // % of mandatory topics complete
  requiredLabs: string[] | 'ALL_MANDATORY';      // lab activity codes
  minAssignmentAveragePercent?: number;
  requireAssignmentsReleased: boolean;           // no submission may still be under AI/human review
  blockOnConfirmedIntegrityConcern: boolean;
}
export interface EligibilityFacts {
  entitlementActive: boolean; programmePercent: number; labsCompleted: string[]; labsMandatory: string[]; assignmentAverage: number | null; assignmentsPending: number;
  integrityConcerns: number; attemptsUsed: number; maxAttempts: number; lastAttemptAt: Date | null; cooldownDays: number; now: Date;
}
export interface Check { key: string; ok: boolean; detail: string; waivable: boolean }

export const defaultRules = (): EligibilityRules => ({ minProgrammePercent: 100, requiredLabs: 'ALL_MANDATORY', requireAssignmentsReleased: true, blockOnConfirmedIntegrityConcern: true });

/** Every check is reported with a plain-language reason (learners are told exactly what is missing). An exception waives academic checks only. */
export function evaluateEligibility(r: EligibilityRules, f: EligibilityFacts, overridden = false) {
  const checks: Check[] = [];
  checks.push({ key: 'entitlement_active', ok: f.entitlementActive, detail: f.entitlementActive ? 'Active entitlement' : 'Your entitlement is not active (paused, expired or revoked)', waivable: false });
  checks.push({ key: 'programme_progress', ok: f.programmePercent >= r.minProgrammePercent, detail: `Programme completion ${f.programmePercent}% (need ${r.minProgrammePercent}%)`, waivable: true });
  const need = r.requiredLabs === 'ALL_MANDATORY' ? f.labsMandatory : r.requiredLabs; const missing = need.filter((c) => !f.labsCompleted.includes(c));
  checks.push({ key: 'labs', ok: !missing.length, detail: missing.length ? `Labs not completed: ${missing.join(', ')}` : 'Required labs completed', waivable: true });
  if (r.minAssignmentAveragePercent !== undefined) checks.push({ key: 'assignment_average', ok: f.assignmentAverage !== null && f.assignmentAverage >= r.minAssignmentAveragePercent, detail: `Assignment average ${f.assignmentAverage ?? 'n/a'}% (need ${r.minAssignmentAveragePercent}%)`, waivable: true });
  if (r.requireAssignmentsReleased) checks.push({ key: 'assignments_released', ok: f.assignmentsPending === 0, detail: f.assignmentsPending ? `${f.assignmentsPending} assignment(s) still being evaluated` : 'All assignments evaluated', waivable: true });
  if (r.blockOnConfirmedIntegrityConcern) checks.push({ key: 'integrity', ok: f.integrityConcerns === 0, detail: f.integrityConcerns ? 'An academic-integrity case on your record must be resolved first' : 'No open integrity case', waivable: false });
  const next = f.lastAttemptAt ? new Date(f.lastAttemptAt.getTime() + f.cooldownDays * 86_400_000) : null;
  checks.push({ key: 'attempts', ok: f.attemptsUsed < f.maxAttempts && (!next || f.now >= next), detail: f.attemptsUsed >= f.maxAttempts ? `All ${f.maxAttempts} attempt(s) used` : next && f.now < next ? `Next attempt allowed from ${next.toISOString().slice(0, 10)}` : `Attempt ${f.attemptsUsed + 1} of ${f.maxAttempts}`, waivable: true });
  const eligible = checks.every((c) => c.ok || (overridden && c.waivable));
  return { eligible, overridden: overridden && checks.some((c) => !c.ok && c.waivable) && eligible, checks };
}

// ---- paper construction ----------------------------------------------------------------------------------------------
export interface BlueprintLine { tag: string; count: number; minDifficulty?: number; maxDifficulty?: number }
export interface BankItem { id: string; tag: string; difficulty: number; points: number; optionCount: number }
export interface PaperItem { questionId: string; tag: string; points: number; optionOrder: number[] }

export function rng(seed: string): () => number {
  let a = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffle<T>(xs: T[], r: () => number): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const candidates = (bank: BankItem[], l: BlueprintLine) => bank.filter((q) => q.tag === l.tag && q.difficulty >= (l.minDifficulty ?? 0) && q.difficulty <= (l.maxDifficulty ?? 99));

/** Same seed (attempt id) -> same paper, so reconnects and post-hoc review always see the identical exam. */
export function buildPaper(blueprint: BlueprintLine[], bank: BankItem[], seed: string, shuffleOptions: boolean) {
  const r = rng(seed); const items: PaperItem[] = []; const shortfalls: { tag: string; need: number; have: number }[] = []; const used = new Set<string>();
  for (const line of blueprint) {
    const pool = shuffle(candidates(bank, line).filter((q) => !used.has(q.id)), r);
    if (pool.length < line.count) shortfalls.push({ tag: line.tag, need: line.count, have: pool.length });
    for (const q of pool.slice(0, line.count)) { used.add(q.id); items.push({ questionId: q.id, tag: q.tag, points: q.points, optionOrder: shuffleOptions ? shuffle([...Array(q.optionCount).keys()], r) : [...Array(q.optionCount).keys()] }); }
  }
  return { items: shuffle(items, r), shortfalls };
}

export function validateBlueprint(blueprint: BlueprintLine[], bank: BankItem[]) {
  const errors: string[] = [], warnings: string[] = [];
  if (!Array.isArray(blueprint) || !blueprint.length) errors.push('blueprint needs at least one section');
  for (const l of blueprint ?? []) {
    if (!l.tag || !Number.isInteger(l.count) || l.count < 1) { errors.push(`section "${l.tag}" needs a tag and integer count >= 1`); continue; }
    const have = candidates(bank, l).length;
    if (have < l.count) errors.push(`section "${l.tag}": needs ${l.count} questions, bank has ${have}`);
    else if (have < l.count * 2) warnings.push(`section "${l.tag}": only ${have} questions for ${l.count} slots; papers will overlap heavily (exposure risk)`);
  }
  return { errors, warnings };
}

// ---- clock -----------------------------------------------------------------------------------------------------------
export const GRACE_MS = 10_000;
export function deadlineFor(startedAt: Date, durationMin: number, extraTimePercent: number, sessionEndsAt: Date, windowGraceMin = 0): Date {
  const full = startedAt.getTime() + durationMin * (1 + extraTimePercent / 100) * 60_000;
  return new Date(Math.min(full, sessionEndsAt.getTime() + windowGraceMin * 60_000));
}
export const accepting = (deadline: Date, now: Date) => now.getTime() <= deadline.getTime() + GRACE_MS;

// ---- scoring ---------------------------------------------------------------------------------------------------------------
export interface QKey { type: 'MCQ_SINGLE' | 'MCQ_MULTI' | 'NUMERIC'; answer: any; tolerance: number; points: number; tag: string }
/** Learner answers refer to DISPLAYED option positions; map back through the stored permutation before grading. */
export function scoreAttempt(items: PaperItem[], keys: Map<string, QKey>, answers: Record<string, unknown>) {
  let raw = 0, max = 0; const sections: Record<string, { points: number; max: number }> = {}; const perItem: { questionId: string; correct: boolean }[] = [];
  for (const it of items) {
    const k = keys.get(it.questionId); if (!k) continue;
    const given = answers[it.questionId]; let mapped: unknown = given;
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < it.optionOrder.length;
    if (k.type === 'MCQ_SINGLE') mapped = ok(given) ? it.optionOrder[given as number] : -1;
    else if (k.type === 'MCQ_MULTI') mapped = Array.isArray(given) && given.every(ok) ? given.map((g) => it.optionOrder[g]) : [-1];
    const correct = gradeQuestion({ id: it.questionId, type: k.type, answer: k.answer, tolerance: k.tolerance, points: k.points }, mapped);
    max += k.points; sections[k.tag] = sections[k.tag] ?? { points: 0, max: 0 }; sections[k.tag].max += k.points;
    if (correct) { raw += k.points; sections[k.tag].points += k.points; }
    perItem.push({ questionId: it.questionId, correct });
  }
  return { rawPoints: raw, maxPoints: max, percent: max ? Math.round((raw / max) * 10000) / 100 : 0, sections, perItem };
}

// ---- integrity signals & result hold ------------------------------------------------------------------------------------------
export interface SignalCounts { FOCUS_LOST?: number; FULLSCREEN_EXIT?: number; COPY?: number; PASTE?: number; sessionSwitches?: number }
export function signalIncidents(c: SignalCounts): { type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' }[] {
  const out: { type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' }[] = [];
  if ((c.FOCUS_LOST ?? 0) >= 15) out.push({ type: 'tab_switch', severity: 'HIGH' }); else if ((c.FOCUS_LOST ?? 0) >= 5) out.push({ type: 'tab_switch', severity: 'MEDIUM' });
  if ((c.FULLSCREEN_EXIT ?? 0) >= 3) out.push({ type: 'fullscreen_exit', severity: 'MEDIUM' });
  if ((c.COPY ?? 0) + (c.PASTE ?? 0) >= 1) out.push({ type: 'clipboard_use', severity: 'LOW' });
  if ((c.sessionSwitches ?? 0) >= 3) out.push({ type: 'session_takeover', severity: 'HIGH' });
  return out;
}

export type ResultState = 'NONE' | 'HELD' | 'READY' | 'INVALIDATED';
/** Results are withheld while anything is unresolved; indicators alone never invalidate. */
export function resultStateFor(a: { submitted: boolean; mode: 'REMOTE' | 'CENTRE'; proctorFinal: boolean; reportWaived: boolean; incidentStatuses: string[]; outcome: string | null }): ResultState {
  if (!a.submitted) return 'NONE';
  if (a.incidentStatuses.some((s) => s === 'OPEN' || s === 'NEEDS_INFO')) return 'HELD';
  if (a.outcome === 'INVALIDATED') return 'INVALIDATED';
  if (a.mode === 'REMOTE' && !a.proctorFinal && !a.reportWaived) return 'HELD';
  if (a.incidentStatuses.includes('CONFIRMED_MAJOR') && !a.outcome) return 'HELD'; // a human must rule on confirmed major incidents
  return 'READY';
}

export const receiptCode = (secret: string, attemptId: string, answersHash: string) => {
  const h = createHmac('sha256', secret).update(`${attemptId}.${answersHash}`).digest('hex').slice(0, 12).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
};
export const answersHash = (answers: unknown) => createHash('sha256').update(JSON.stringify(sortKeys(answers))).digest('hex');
const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export const watermarkFor = (attemptId: string) => createHash('sha256').update(`wm:${attemptId}`).digest('hex').slice(0, 8).toUpperCase();

/** Device/system pre-check against configured minimums. */
export interface DeviceReport { browserSupported?: boolean; camera?: boolean; microphone?: boolean; screens?: number; bandwidthKbps?: number }
export function evaluateDevice(d: DeviceReport, needs: { camera: boolean; microphone: boolean; minBandwidthKbps: number; singleScreen: boolean }) {
  const problems: string[] = [];
  if (!d.browserSupported) problems.push('unsupported browser');
  if (needs.camera && !d.camera) problems.push('camera not available'); if (needs.microphone && !d.microphone) problems.push('microphone not available');
  if (needs.singleScreen && (d.screens ?? 1) > 1) problems.push('more than one screen detected');
  if ((d.bandwidthKbps ?? 0) < needs.minBandwidthKbps) problems.push(`bandwidth below ${needs.minBandwidthKbps} kbps`);
  return { ok: problems.length === 0, problems };
}
