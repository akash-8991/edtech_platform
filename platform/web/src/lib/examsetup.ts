import type { BankCoverage, BlueprintLine, ExamEligibility, ExamProctoring } from '../api/types';

// ---- the exam form ------------------------------------------------------------------------------------------------------------------------------
export interface ExamForm {
  versionId: string; code: string; title: string; durationMin: string; passPercent: string; maxAttempts: string; cooldownDays: string; shuffle: boolean;
  minProgrammePercent: string; labs: 'ALL_MANDATORY' | 'LIST'; labList: string; minAssignmentAverage: string; requireAssignmentsReleased: boolean; blockOnIntegrity: boolean;
  mode: 'REMOTE' | 'CENTRE'; requireId: boolean; camera: boolean; microphone: boolean; singleScreen: boolean;
  lines: { tag: string; count: string; minDifficulty: string; maxDifficulty: string }[];
}
export const blankExam = (): ExamForm => ({ versionId: '', code: '', title: '', durationMin: '90', passPercent: '50', maxAttempts: '2', cooldownDays: '7', shuffle: true, minProgrammePercent: '100', labs: 'ALL_MANDATORY', labList: '', minAssignmentAverage: '', requireAssignmentsReleased: true, blockOnIntegrity: true, mode: 'REMOTE', requireId: true, camera: true, microphone: true, singleScreen: true, lines: [{ tag: '', count: '10', minDifficulty: '', maxDifficulty: '' }] });
const int = (s: string) => (s.trim() !== '' && Number.isInteger(Number(s)) ? Number(s) : NaN);

/** The same limits the server applies, so the form can say what is wrong in one pass instead of one rejection at a time. */
export function validateExam(f: ExamForm, coverage: BankCoverage[] | null): string[] {
  const out: string[] = []; const inR = (n: number, a: number, b: number) => n >= a && n <= b;
  if (!f.versionId) out.push('Choose the course this exam is for.');
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(f.code.trim())) out.push('The exam code must be 2 to 30 letters, digits, dashes or underscores.');
  if (!inR(int(f.durationMin), 10, 300)) out.push('Duration must be a whole number of minutes from 10 to 300.');
  if (!inR(int(f.passPercent), 1, 100)) out.push('The pass mark must be a whole number from 1 to 100.');
  if (!inR(int(f.maxAttempts), 1, 5)) out.push('Attempts allowed must be from 1 to 5.');
  if (!(int(f.cooldownDays) >= 0)) out.push('Days between attempts must be 0 or more.');
  if (!inR(int(f.minProgrammePercent), 0, 100)) out.push('The course completion needed must be from 0 to 100.');
  if (f.labs === 'LIST' && !splitCodes(f.labList).length) out.push('List the lab codes that must be completed, or choose "all mandatory labs".');
  if (f.minAssignmentAverage.trim() !== '' && !inR(Number(f.minAssignmentAverage), 0, 100)) out.push('The assignment average needed must be from 0 to 100.');
  if (!f.lines.length) out.push('Add at least one section to the blueprint.');
  const seen = new Set<string>();
  f.lines.forEach((l, i) => {
    const at = `Section ${i + 1}`; if (!l.tag) { out.push(`${at}: choose a topic tag.`); return; }
    if (!(int(l.count) >= 1)) out.push(`${at}: the number of questions must be 1 or more.`);
    const lo = l.minDifficulty === '' ? undefined : int(l.minDifficulty), hi = l.maxDifficulty === '' ? undefined : int(l.maxDifficulty);
    if ((lo !== undefined && !inR(lo, 1, 5)) || (hi !== undefined && !inR(hi, 1, 5))) out.push(`${at}: difficulty is from 1 (easy) to 5 (hard).`); else if (lo !== undefined && hi !== undefined && lo > hi) out.push(`${at}: the easiest level cannot be above the hardest.`);
    const key = `${l.tag}|${l.minDifficulty}|${l.maxDifficulty}`; if (seen.has(key)) out.push(`${at}: the same tag and difficulty range appears twice.`); seen.add(key);
  });
  if (coverage) for (const s of blueprintStatus(toLines(f), coverage)) if (s.errors.length) out.push(...s.errors);
  return out;
}
export const splitCodes = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];
export const toLines = (f: ExamForm): BlueprintLine[] => f.lines.filter((l) => l.tag).map((l) => ({ tag: l.tag, count: int(l.count), ...(l.minDifficulty !== '' && { minDifficulty: int(l.minDifficulty) }), ...(l.maxDifficulty !== '' && { maxDifficulty: int(l.maxDifficulty) }) }));
export function toBody(f: ExamForm) {
  const eligibility: ExamEligibility = { minProgrammePercent: Number(f.minProgrammePercent), requiredLabs: f.labs === 'ALL_MANDATORY' ? 'ALL_MANDATORY' : splitCodes(f.labList), requireAssignmentsReleased: f.requireAssignmentsReleased, blockOnConfirmedIntegrityConcern: f.blockOnIntegrity, ...(f.minAssignmentAverage.trim() !== '' && { minAssignmentAveragePercent: Number(f.minAssignmentAverage) }) };
  const proctoring: ExamProctoring = { mode: f.mode, requireId: f.requireId, requireDevice: true, device: { camera: f.camera, microphone: f.microphone, singleScreen: f.singleScreen } };
  return { versionId: f.versionId, code: f.code.trim(), title: f.title.trim() || f.code.trim(), durationMin: Number(f.durationMin), passPercent: Number(f.passPercent), maxAttempts: Number(f.maxAttempts), cooldownDays: Number(f.cooldownDays), shuffle: f.shuffle, eligibility, proctoring, blueprint: toLines(f) };
}

/** What the question bank can supply for each blueprint section: errors when it cannot, a warning when papers would overlap heavily (the same as publishing checks). */
export function blueprintStatus(lines: BlueprintLine[], cov: BankCoverage[]): { line: BlueprintLine; have: number; errors: string[]; warnings: string[] }[] {
  return lines.map((l) => {
    const have = cov.filter((c) => c.tag === l.tag && (l.minDifficulty === undefined || c.difficulty >= l.minDifficulty) && (l.maxDifficulty === undefined || c.difficulty <= l.maxDifficulty)).reduce((n, c) => n + c.count, 0);
    const errors = have < l.count ? [`Section "${l.tag}": needs ${l.count} questions but the bank has ${have}.`] : []; const warnings = !errors.length && have < l.count * 2 ? [`Section "${l.tag}": only ${have} questions for ${l.count} places, so papers will overlap a lot.`] : [];
    return { line: l, have, errors, warnings };
  });
}
export const tagsOf = (cov: BankCoverage[]) => [...new Set(cov.map((c) => c.tag))].sort();
export const totalBank = (cov: BankCoverage[]) => cov.reduce((n, c) => n + c.count, 0);
export const lineText = (l: BlueprintLine) => `${l.count} × ${l.tag}${l.minDifficulty || l.maxDifficulty ? ` (difficulty ${l.minDifficulty ?? 1}–${l.maxDifficulty ?? 5})` : ''}`;
export const modeLabel = (m: string) => (m === 'CENTRE' ? 'At a centre' : 'Remote, online');
export const eligibilityLines = (e: ExamEligibility): string[] => [`Course completion of at least ${e.minProgrammePercent}%`, e.requiredLabs === 'ALL_MANDATORY' ? 'All mandatory labs completed' : `Labs completed: ${e.requiredLabs.join(', ') || 'none'}`, ...(e.minAssignmentAveragePercent !== undefined ? [`Assignment average of at least ${e.minAssignmentAveragePercent}%`] : []), ...(e.requireAssignmentsReleased ? ['No assignment still being marked'] : []), ...(e.blockOnConfirmedIntegrityConcern ? ['No open academic-integrity case'] : [])];
export const statusLabel = (s: string) => ({ DRAFT: 'Draft: not yet published', PUBLISHED: 'Published', RETIRED: 'Retired' } as Record<string, string>)[s] ?? s;

/** Why this person cannot publish the exam, if they cannot (the server checks too). */
export const publishBlock = (e: { status: string; createdById: string; createdByName: string | null; blueprintCheck: { errors: string[] }; changeFrozen: boolean }, meId: string): string | null =>
  e.status !== 'DRAFT' ? 'Only a draft can be published.' : e.changeFrozen ? 'Exam changes are frozen at the moment.' : e.createdById === meId ? 'You defined this exam, so a different administrator must publish it.' : e.blueprintCheck.errors.length ? 'The question bank cannot fill every section yet.' : null;

// ---- sessions -----------------------------------------------------------------------------------------------------------------------------------
export interface SessionForm { startsAt: string; endsAt: string; centre: string; capacity: string }
export const localToIso = (v: string) => (v ? new Date(v).toISOString() : null);
export function validateSession(f: SessionForm, durationMin: number, mode: string, now = Date.now()): string | null {
  const s = Date.parse(f.startsAt), e = Date.parse(f.endsAt);
  if (!f.startsAt || !f.endsAt || isNaN(s) || isNaN(e)) return 'Choose when the window opens and when it closes.'; if (s < now) return 'The window must open in the future.';
  if (e - s < durationMin * 60_000) return `The window must be at least as long as the exam (${durationMin} minutes), so everyone can finish.`;
  if (mode === 'CENTRE' && !f.centre.trim()) return 'Say which centre this sitting is at.';
  const c = int(f.capacity); return c >= 1 && c <= 25_000 ? null : 'Capacity must be a whole number from 1 to 25,000.';
}

// ---- accommodations ------------------------------------------------------------------------------------------------------------------------------
export const accommodationLabel = (t: string) => ({ EXTRA_TIME: 'Extra time', BREAKS: 'Breaks', ASSISTIVE: 'Assistive technology' } as Record<string, string>)[t] ?? t;
export function validateAccommodation(f: { learnerId: string; type: string; percent: string; reason: string }): string | null {
  if (!f.learnerId) return 'Choose the learner.'; if (!f.type) return 'Choose the kind of accommodation.';
  if (f.type === 'EXTRA_TIME' && !(int(f.percent) >= 1 && int(f.percent) <= 100)) return 'Extra time is a whole percentage from 1 to 100.';
  return f.reason.trim() ? null : 'Write the reason (for example the documented need). It is recorded in the audit trail.';
}
export const accommodationText = (a: { type: string; extraTimePercent: number }) => `${accommodationLabel(a.type)}${a.type === 'EXTRA_TIME' ? ` (+${a.extraTimePercent}%)` : ''}`;
export const reasonError = (r: string) => (r.trim() ? null : 'Write the reason: it is recorded in the audit trail.');
export const difficultyLabel = (d: number) => ['', 'Very easy', 'Easy', 'Medium', 'Hard', 'Very hard'][d] ?? String(d);
