// Deterministic academic quality gates (BRD: 100% of AI assets pass faculty review; flag unsupported claims for humans).
// LLM-judge results are converted to findings by the same shape (see judgeFindings).

export type Severity = 'INFO' | 'WARN' | 'FAIL';
export interface Finding { gate: string; severity: Severity; message: string; sceneId?: string; evidence?: Record<string, unknown> }
export const blocking = (f: Finding) => f.severity === 'FAIL';
const F = (gate: string, severity: Severity, message: string, sceneId?: string, evidence?: Record<string, unknown>): Finding => ({ gate, severity, message, sceneId, evidence });

// ---- text helpers -------------------------------------------------------------------------------
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
export function shingles(text: string, n = 8): Set<string> {
  const w = words(text), out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}
/** Share of the candidate's 8-word shingles that appear verbatim in any reference: a copyright/originality signal. */
export function overlapRatio(candidate: string, references: string[]): number {
  const c = shingles(candidate); if (!c.size) return 0;
  const refs = new Set<string>(); for (const r of references) for (const s of shingles(r)) refs.add(s);
  let hit = 0; for (const s of c) if (refs.has(s)) hit++;
  return hit / c.size;
}
export const devanagariRatio = (s: string) => {
  const letters = [...s].filter((ch) => /\p{L}/u.test(ch));
  return letters.length ? letters.filter((ch) => /[ऀ-ॿ]/.test(ch)).length / letters.length : 0;
};

// Defaults; admins extend via PlatformConfig `ai.prohibited_terms` without a release.
export const DEFAULT_PROHIBITED = ['guaranteed placement', '100% pass', 'guaranteed job', 'get rich'];
const BIAS_PATTERNS: [RegExp, string][] = [
  [/\b(manpower|chairman|fireman)\b/i, 'gendered job term'],
  [/\b(girls|women) (can't|cannot|are not able to)\b/i, 'gender stereotype'],
  [/\b(illiterate|backward) (people|villagers|students)\b/i, 'demeaning descriptor'],
];
const INJECTION = /(ignore (all |any )?(previous|prior|above) (instructions|prompts)|disregard the system prompt|you are now |reveal (the )?(system )?prompt)/i;
export const hasInjection = (s: string) => INJECTION.test(s);

/** Data minimisation before text leaves for a model provider. */
export function redactPii(text: string): { text: string; count: number } {
  let count = 0;
  const sub = (re: RegExp, tag: string) => { text = text.replace(re, () => { count++; return tag; }); };
  sub(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]');
  sub(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[ID_NUMBER]');            // Aadhaar-shaped
  sub(/(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g, '[PHONE]');           // Indian mobile
  sub(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[ID_NUMBER]');               // PAN-shaped
  return { text, count };
}

// ---- curriculum ----------------------------------------------------------------------------------
export interface CurriculumOut { title: string; outcomes: string[]; modules: { title: string; topics: { title: string; hours: number; outcomes: string[]; prerequisites: string[]; mandatory: boolean }[] }[] }

export function checkCurriculum(c: CurriculumOut, brief: { hours: number }): Finding[] {
  const out: Finding[] = [];
  if (!c.modules?.length) return [F('structure', 'FAIL', 'curriculum has no modules')];
  const topics = c.modules.flatMap((m) => m.topics);
  const total = topics.reduce((s, t) => s + (Number.isInteger(t.hours) ? t.hours : 0), 0);
  if (topics.some((t) => !Number.isInteger(t.hours) || t.hours < 1)) out.push(F('structure', 'FAIL', 'every topic needs integer hours >= 1'));
  if (total !== brief.hours) out.push(F('structure', 'FAIL', `topic hours ${total} != requested ${brief.hours}`, undefined, { total, requested: brief.hours }));
  if (c.modules.some((m) => !m.topics.length)) out.push(F('structure', 'FAIL', 'module without topics'));
  const titles = topics.map((t) => t.title.trim().toLowerCase());
  titles.forEach((t, i) => { if (titles.indexOf(t) !== i) out.push(F('structure', 'WARN', `duplicate topic title "${topics[i].title}"`)); });
  // CUR-005: missing foundations = prerequisite not delivered earlier in the programme
  topics.forEach((t, i) => (t.prerequisites ?? []).forEach((p) => {
    const at = titles.indexOf(p.trim().toLowerCase());
    if (at < 0 || at >= i) out.push(F('structure', 'WARN', `topic "${t.title}": prerequisite "${p}" is not taught earlier`));
  }));
  c.modules.forEach((m) => { const h = m.topics.reduce((s, t) => s + t.hours, 0); if (total && h / total > 0.4) out.push(F('structure', 'WARN', `module "${m.title}" holds ${Math.round((h / total) * 100)}% of all hours (overloaded)`)); });
  topics.forEach((t) => { if (!t.outcomes?.length) out.push(F('assessment', 'FAIL', `topic "${t.title}" has no outcomes`)); });
  const oc = topics.flatMap((t) => t.outcomes ?? []).map((o) => o.trim().toLowerCase());
  oc.forEach((o, i) => { if (oc.indexOf(o) !== i) out.push(F('structure', 'INFO', `duplicate outcome "${o}"`)); });
  return out;
}

// ---- topic content (video script + quiz + assignment) ----------------------------------------------
export interface SceneOut {
  id: string; type: string; narration_en: string; narration_hi?: string; on_screen_text: string; audio_description: string; visual_prompt: string;
  duration_sec: number; sources: string[];
  interactions: { kind: string; at_sec: number; prompt: string; options: string[]; branch_targets: string[] }[];
}
export interface QuizOut { type: string; text: string; options: string[]; answer_indexes: number[]; answer_number: number; tolerance: number; points: number; rationale: string; outcome: string }
export interface ContentCtx { languages: string[]; refIds: string[]; refTexts: string[]; glossary: Record<string, string>; prohibited: string[]; outcomes: string[] }
export interface ContentOut { scenes: SceneOut[]; quiz: QuizOut[]; assignment: { instructions: string; rubric: { criterion: string; weight: number }[] } }

export function reachableScenes(scenes: SceneOut[]): Set<string> {
  const seen = new Set<string>(); const idx = new Map(scenes.map((s, i) => [s.id, i]));
  const stack = scenes.length ? [scenes[0].id] : [];
  while (stack.length) {
    const id = stack.pop()!; if (seen.has(id) || !idx.has(id)) continue; seen.add(id);
    const s = scenes[idx.get(id)!]; const next = scenes[idx.get(id)! + 1]; if (next) stack.push(next.id);
    s.interactions.forEach((i) => i.branch_targets.filter(Boolean).forEach((t) => stack.push(t)));
  }
  return seen;
}

export function checkContent(c: ContentOut, ctx: ContentCtx): Finding[] {
  const out: Finding[] = [];
  if (!c.scenes?.length) return [F('structure', 'FAIL', 'no scenes generated')];
  const ids = new Set(c.scenes.map((s) => s.id));
  if (ids.size !== c.scenes.length) out.push(F('structure', 'FAIL', 'duplicate scene ids'));
  const reach = reachableScenes(c.scenes);
  const prohibited = [...DEFAULT_PROHIBITED, ...ctx.prohibited].map((p) => p.toLowerCase());
  const lockedPairs = Object.entries(ctx.glossary);

  for (const s of c.scenes) {
    if (!reach.has(s.id)) out.push(F('structure', 'FAIL', 'scene unreachable by any path', s.id));
    if (!(s.duration_sec > 0 && s.duration_sec <= 15)) out.push(F('structure', 'FAIL', `duration ${s.duration_sec}s outside 1..15`, s.id));
    if (!s.narration_en?.trim()) out.push(F('structure', 'FAIL', 'missing English narration', s.id));
    else if (s.narration_en.split(/\s+/).length / 2.5 > s.duration_sec * 1.3) out.push(F('structure', 'WARN', 'narration too long for scene duration', s.id));
    for (const i of s.interactions) {
      if (i.at_sec < 0 || i.at_sec > s.duration_sec) out.push(F('structure', 'FAIL', `interaction at ${i.at_sec}s outside scene`, s.id));
      if (i.branch_targets.length && i.branch_targets.length !== i.options.length) out.push(F('structure', 'FAIL', 'branch_targets must parallel options', s.id));
      i.branch_targets.filter(Boolean).forEach((t) => { if (!ids.has(t)) out.push(F('structure', 'FAIL', `branch to unknown scene ${t}`, s.id)); });
      if (!i.prompt?.trim()) out.push(F('accessibility', 'FAIL', 'interaction without text alternative/prompt', s.id));
    }
    // citations: only provided reference ids are valid sources; model-invented ids are unsupported
    const bad = s.sources.filter((x) => !ctx.refIds.includes(x));
    if (bad.length) out.push(F('citations', 'FAIL', `cites unknown sources: ${bad.join(', ')}`, s.id));
    else if (ctx.refIds.length && !s.sources.length) out.push(F('citations', 'WARN', 'scene cites no source', s.id));
    // accessibility: visual-only scenes need an audio description
    if (['animation', 'screen_demo', 'mixed'].includes(s.type) && !s.audio_description?.trim() && !s.on_screen_text?.trim()) out.push(F('accessibility', 'WARN', 'visual scene lacks audio description', s.id));
    // originality / copyright against supplied references
    const text = [s.narration_en, s.on_screen_text].join(' ');
    const ov = overlapRatio(text, ctx.refTexts);
    if (ov >= 0.25) out.push(F('copyright', 'FAIL', `${Math.round(ov * 100)}% of text copied verbatim from references`, s.id, { overlap: ov }));
    else if (ov >= 0.1) out.push(F('originality', 'WARN', `${Math.round(ov * 100)}% verbatim overlap with references`, s.id, { overlap: ov }));
    // safety / bias / injection leakage, over every language present
    const all = [s.narration_en, s.narration_hi ?? '', s.on_screen_text, s.audio_description, ...s.interactions.map((i) => i.prompt)].join(' \n ');
    prohibited.forEach((p) => { if (all.toLowerCase().includes(p)) out.push(F('safety', 'FAIL', `prohibited claim "${p}"`, s.id)); });
    BIAS_PATTERNS.forEach(([re, why]) => { if (re.test(all)) out.push(F('bias', 'WARN', why, s.id)); });
    if (hasInjection(all)) out.push(F('safety', 'FAIL', 'output contains instruction-like text (possible prompt injection)', s.id));
    // language gate
    if (ctx.languages.includes('hi')) {
      if (!s.narration_hi?.trim()) out.push(F('language', 'FAIL', 'missing Hindi narration', s.id));
      else {
        if (devanagariRatio(s.narration_hi) < 0.6) out.push(F('language', 'FAIL', 'Hindi narration is not predominantly Devanagari', s.id));
        for (const [term, locked] of lockedPairs) if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s.narration_en) && !s.narration_hi.includes(locked))
          out.push(F('language', 'WARN', `glossary term "${term}" not rendered as "${locked}" in Hindi`, s.id));
      }
    }
  }
  out.push(...checkQuiz(c.quiz, ctx.outcomes));
  if (!c.assignment?.instructions?.trim()) out.push(F('assessment', 'FAIL', 'assignment instructions missing'));
  else if (c.assignment.rubric?.length && c.assignment.rubric.reduce((s, r) => s + r.weight, 0) !== 100) out.push(F('assessment', 'WARN', 'rubric weights do not sum to 100'));
  return out;
}

export function checkQuiz(q: QuizOut[], outcomes: string[]): Finding[] {
  const out: Finding[] = [];
  if (!q?.length) return [F('assessment', 'FAIL', 'no quiz questions')];
  q.forEach((x, i) => {
    const at = `question ${i + 1}`;
    if (x.type === 'NUMERIC') { if (!Number.isFinite(x.answer_number)) out.push(F('assessment', 'FAIL', `${at}: numeric answer missing`)); return; }
    if (x.options.length < 2) out.push(F('assessment', 'FAIL', `${at}: needs >= 2 options`));
    if (!x.answer_indexes.length || x.answer_indexes.some((a) => a < 0 || a >= x.options.length)) out.push(F('assessment', 'FAIL', `${at}: answer index out of range`));
    if (x.type === 'MCQ_SINGLE' && x.answer_indexes.length !== 1) out.push(F('assessment', 'FAIL', `${at}: single-choice must have exactly one answer`));
    if (new Set(x.options.map((o) => o.trim().toLowerCase())).size !== x.options.length) out.push(F('assessment', 'WARN', `${at}: duplicate options`));
    if (!x.rationale?.trim()) out.push(F('assessment', 'WARN', `${at}: no rationale`));
  });
  if (outcomes.length && q.length < outcomes.length) out.push(F('assessment', 'WARN', `only ${q.length} questions for ${outcomes.length} outcomes (assessment gap)`));
  const covered = new Set(q.map((x) => x.outcome?.trim().toLowerCase()).filter(Boolean));
  outcomes.forEach((o) => { if (!covered.has(o.trim().toLowerCase())) out.push(F('assessment', 'INFO', `outcome not assessed by any question: ${o}`)); });
  return out;
}

// ---- LLM-judge results -> findings (unsupported claims block until a human resolves them) -------------
export function judgeFindings(j: { unsupported_claims: { scene_id: string; claim: string; reason: string }[]; factual_inconsistencies: { scene_id: string; issue: string }[]; safety_findings: { scene_id: string; issue: string }[]; bias_findings: { scene_id: string; issue: string }[] }): Finding[] {
  return [
    ...j.unsupported_claims.map((x) => F('factual_consistency', 'FAIL', `unsupported claim: ${x.claim} (${x.reason})`, x.scene_id)),
    ...j.factual_inconsistencies.map((x) => F('factual_consistency', 'FAIL', x.issue, x.scene_id)),
    ...j.safety_findings.map((x) => F('safety', 'FAIL', x.issue, x.scene_id)),
    ...j.bias_findings.map((x) => F('bias', 'WARN', x.issue, x.scene_id)),
  ];
}
export function translationFindings(j: { scores: { scene_id: string; score: number; issue: string }[] }): Finding[] {
  return j.scores.filter((s) => s.score <= 3).map((s) => F('language', s.score <= 2 ? 'FAIL' : 'WARN', `Hindi fidelity score ${s.score}/5: ${s.issue}`, s.scene_id));
}
