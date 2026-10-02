import type { AuthoredQuestion, AuthoredTopic, DiffChange, VersionState, VersionTree } from '../api/types';

/** Mirror of the server's review state machine (domain/workflow.ts). The SERVER decides; this only chooses what to offer and explains why a move is blocked. */
interface Rule { from: VersionState; to: VersionState; roles: string[]; reasonRequired?: boolean; sod?: ('author' | 'facultyReviewer')[]; label: string }
export const RULES: Rule[] = [
  { from: 'DRAFT', to: 'FACULTY_REVIEW', roles: ['CONTENT_AUTHOR', 'ACADEMIC_ADMIN'], label: 'Send for faculty review' },
  { from: 'FACULTY_REVIEW', to: 'FACULTY_APPROVED', roles: ['FACULTY_REVIEWER'], sod: ['author'], label: 'Approve as faculty' },
  { from: 'FACULTY_REVIEW', to: 'DRAFT', roles: ['FACULTY_REVIEWER'], reasonRequired: true, label: 'Send back to the author' },
  { from: 'FACULTY_APPROVED', to: 'ADMIN_APPROVAL', roles: ['FACULTY_REVIEWER', 'ACADEMIC_ADMIN'], label: 'Pass to final approval' },
  { from: 'ADMIN_APPROVAL', to: 'PUBLISHED', roles: ['APPROVER_PUBLISHER'], sod: ['author', 'facultyReviewer'], label: 'Publish' },
  { from: 'ADMIN_APPROVAL', to: 'DRAFT', roles: ['APPROVER_PUBLISHER'], reasonRequired: true, label: 'Reject back to draft' },
  { from: 'PUBLISHED', to: 'RETIRED', roles: ['APPROVER_PUBLISHER', 'ACADEMIC_ADMIN'], reasonRequired: true, label: 'Retire' },
];
export const stateLabel = (s: string) => ({ DRAFT: 'Draft', FACULTY_REVIEW: 'In faculty review', FACULTY_APPROVED: 'Faculty approved', ADMIN_APPROVAL: 'Awaiting final approval', PUBLISHED: 'Published', RETIRED: 'Retired' } as Record<string, string>)[s] ?? s;
export const stateTone = (s: string): 'ok' | 'warn' | 'muted' => (s === 'PUBLISHED' ? 'ok' : s === 'DRAFT' || s === 'RETIRED' ? 'muted' : 'warn');
export const isDraft = (s: string) => s === 'DRAFT';

export interface Move { to: VersionState; label: string; reasonRequired: boolean; blocked: string | null }
/** The moves this person may make on a version in its current state, with a plain reason when separation of duties will stop them. */
export function movesFor(state: VersionState, roles: readonly string[], actorId: string, tree: Pick<VersionTree, 'authorId' | 'approvals'>): Move[] {
  const reviewers = tree.approvals.filter((a) => a.toState === 'FACULTY_APPROVED').map((a) => a.actorId);
  return RULES.filter((r) => r.from === state && r.roles.some((x) => roles.includes(x))).map((r) => ({
    to: r.to, label: r.label, reasonRequired: !!r.reasonRequired,
    blocked: r.sod?.includes('author') && actorId === tree.authorId ? 'You wrote this version, so you cannot approve it.' : r.sod?.includes('facultyReviewer') && reviewers.includes(actorId) ? 'You gave the faculty approval, so someone else must give the final approval.' : null,
  }));
}
export const waitingOn = (state: VersionState): string | null => ({ DRAFT: 'author', FACULTY_REVIEW: 'faculty reviewer', FACULTY_APPROVED: 'faculty reviewer or academic admin', ADMIN_APPROVAL: 'approver and publisher' } as Record<string, string>)[state] ?? null;
/** Which versions need this person's action, to put them first in the list. */
export function needsMe(state: VersionState, roles: readonly string[]): boolean { return RULES.some((r) => r.from === state && r.to !== 'DRAFT' && r.roles.some((x) => roles.includes(x)) && state !== 'PUBLISHED') || (state === 'DRAFT' && roles.includes('CONTENT_AUTHOR')); }

/** What the server checks before review (domain: validateForReview) for the parts that can be judged here; the server's full list (including assignment policy and accessibility) is shown when it refuses. */
export function readinessIssues(t: Pick<VersionTree, 'hours' | 'languages' | 'modules'>): string[] {
  const out: string[] = [];
  for (const m of t.modules) for (const tp of m.topics) {
    if (!tp.mandatory) continue;
    for (const l of t.languages) if (!tp.assets.some((a) => a.kind === 'VIDEO' && a.language === l && a.files?.master)) out.push(`Topic "${tp.title}": no ${l === 'hi' ? 'Hindi' : 'English'} video with its master file`);
    if (!tp.quiz?.questions.length) out.push(`Topic "${tp.title}": quiz missing`);
    if (!tp.assignment) out.push(`Topic "${tp.title}": assignment missing`);
  }
  const total = t.modules.reduce((s, m) => s + m.topics.reduce((a, x) => a + x.hours, 0), 0);
  if (!t.modules.length) out.push('No modules yet');
  if (total !== t.hours) out.push(`Topic hours add up to ${total} but the programme says ${t.hours}`);
  if (t.modules.some((m) => !m.topics.length)) out.push('A module has no topics');
  return out;
}
export const topicStatus = (t: AuthoredTopic, languages: string[]) => ({
  videos: languages.map((l) => ({ language: l, ok: t.assets.some((a) => a.kind === 'VIDEO' && a.language === l && !!a.files?.master) })), quiz: t.quiz?.questions.length ?? 0, assignment: !!t.assignment,
});

/** A draft is replaced as a whole by the API, so an edit sends back the complete tree it read. Anything missing here would be deleted, so every component is carried across. */
export function toEditBody(t: VersionTree, modules = t.modules) {
  return { hours: t.hours, outcomes: t.outcomes, languages: t.languages, modules: modules.map((m) => ({ title: m.title, topics: m.topics.map((x) => ({
    title: x.title, hours: x.hours, outcomes: x.outcomes, prerequisites: x.prerequisites, mandatory: x.mandatory,
    ...(x.quiz && { quiz: { passPercent: x.quiz.passPercent, maxAttempts: x.quiz.maxAttempts, questions: x.quiz.questions.map((q, i) => ({ position: i + 1, type: q.type, text: q.text, options: q.options, answer: q.answer, tolerance: q.tolerance, points: q.points, rationale: q.rationale ?? undefined, i18n: q.i18n })) } }),
    ...(x.assignment && { assignment: { instructions: x.assignment.instructions, rubric: x.assignment.rubric, maxSubmissions: x.assignment.maxSubmissions, policy: x.assignment.policy, i18n: x.assignment.i18n } }),
    ...(x.assets.length && { assets: x.assets.map((a) => ({ kind: a.kind, language: a.language, durationSec: a.durationSec, files: a.files, interactions: a.interactions, provenance: a.provenance, rights: a.rights, createdById: a.createdById })) }),
  })) })) };
}
export const move = <T,>(xs: T[], i: number, d: -1 | 1): T[] => { const j = i + d; if (j < 0 || j >= xs.length) return xs; const c = xs.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; };

export const describeChange = (c: DiffChange): string => {
  const val = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const [m, t, f] = c.path.split('/'); const mod = m?.startsWith('module:') ? m.slice(7) : null; const top = t?.startsWith('topic:') ? t.slice(6) : null;
  const what = top ? `topic "${top}" in module "${mod}"` : mod ? `module "${mod}"` : c.path === 'hours' ? 'programme hours' : c.path;
  if (c.change === 'added') return `Added ${what}`;
  if (c.change === 'removed') return `Removed ${what}`;
  return `${f ? `Topic "${top}" in module "${mod}", ${f}` : what[0].toUpperCase() + what.slice(1)}: ${val(c.from)} → ${val(c.to)}`;
};

// ---- quiz editing --------------------------------------------------------------------------------------------------------------------------------
export interface QuestionDraft { type: 'MCQ_SINGLE' | 'MCQ_MULTI' | 'NUMERIC'; text: string; options: string[]; single: number; multi: number[]; numeric: string; tolerance: string; points: string; rationale: string; i18n?: unknown }
export const blankQuestion = (): QuestionDraft => ({ type: 'MCQ_SINGLE', text: '', options: ['', ''], single: 0, multi: [], numeric: '', tolerance: '0', points: '1', rationale: '' });
export const draftFromQuestion = (q: AuthoredQuestion): QuestionDraft => ({ type: q.type as QuestionDraft['type'], text: q.text, options: q.options.length ? q.options : ['', ''], single: typeof q.answer === 'number' && q.type === 'MCQ_SINGLE' ? q.answer : 0, multi: Array.isArray(q.answer) ? q.answer : [], numeric: q.type === 'NUMERIC' ? String(q.answer) : '', tolerance: String(q.tolerance ?? 0), points: String(q.points), rationale: q.rationale ?? '', i18n: q.i18n });
export function validateQuestion(q: QuestionDraft): string | null {
  if (!q.text.trim()) return 'Write the question.';
  if (!(Number(q.points) >= 1) || !Number.isInteger(Number(q.points))) return 'Points must be a whole number, 1 or more.';
  if (q.type === 'NUMERIC') { if (q.numeric.trim() === '' || !Number.isFinite(Number(q.numeric))) return 'Enter the correct number.'; if (!(Number(q.tolerance) >= 0)) return 'Tolerance must be 0 or more.'; return null; }
  const opts = q.options.map((o) => o.trim()); if (opts.length < 2 || opts.some((o) => !o)) return 'Every option needs text, and there must be at least two.';
  if (new Set(opts).size !== opts.length) return 'Two options are identical.';
  if (q.type === 'MCQ_SINGLE' && !(q.single >= 0 && q.single < opts.length)) return 'Choose the correct option.';
  if (q.type === 'MCQ_MULTI' && !q.multi.length) return 'Tick at least one correct option.';
  return null;
}
export const questionFromDraft = (q: QuestionDraft, position: number): AuthoredQuestion => q.type === 'NUMERIC'
  ? { position, type: 'NUMERIC', text: q.text.trim(), options: [], answer: Number(q.numeric), tolerance: Number(q.tolerance), points: Number(q.points), rationale: q.rationale.trim() || null, i18n: q.i18n }
  : { position, type: q.type, text: q.text.trim(), options: q.options.map((o) => o.trim()), answer: q.type === 'MCQ_SINGLE' ? q.single : [...q.multi].sort((a, b) => a - b), tolerance: 0, points: Number(q.points), rationale: q.rationale.trim() || null, i18n: q.i18n };
/** Removing option `i` shifts the indices after it, so the stored answer must follow. */
export function removeOption(q: QuestionDraft, i: number): QuestionDraft {
  const options = q.options.filter((_, k) => k !== i); const shift = (n: number) => (n > i ? n - 1 : n);
  return { ...q, options, single: q.single === i ? 0 : shift(q.single), multi: q.multi.filter((n) => n !== i).map(shift) };
}

// ---- rubric ---------------------------------------------------------------------------------------------------------------------------------------
export interface CriterionDraft { criterion: string; weight: string; description: string }
export const blankCriteria = (): CriterionDraft[] => [{ criterion: '', weight: '100', description: '' }];
export function validateRubric(cs: CriterionDraft[]): string | null {
  if (!cs.length) return 'Add at least one criterion.';
  if (cs.some((c) => !c.criterion.trim())) return 'Every criterion needs a name.';
  if (new Set(cs.map((c) => c.criterion.trim().toLowerCase())).size !== cs.length) return 'Two criteria have the same name.';
  if (cs.some((c) => !(Number(c.weight) > 0))) return 'Every weight must be above 0.';
  const sum = cs.reduce((s, c) => s + Number(c.weight), 0); if (Math.abs(sum - 100) > 0.01) return `Weights add up to ${Math.round(sum * 100) / 100}; they must add up to 100.`;
  return null;
}
