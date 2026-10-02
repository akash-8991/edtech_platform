import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AuthoredAsset, AuthoredModule, AuthoredTopic, VersionTree } from '../api/types';
import { Badge, Card, ErrorNote } from '../components/ui';
import { blankCriteria, blankQuestion, draftFromQuestion, move, questionFromDraft, removeOption, topicStatus, toEditBody, validateQuestion, validateRubric, type CriterionDraft, type QuestionDraft } from '../lib/content';

const LABELS: [string, string, boolean][] = [['master', 'Master video (required)', true], ['transcript', 'Transcript (required for accessibility)', true], ['720p', '720p video', false], ['360p', '360p low-bandwidth video', false], ['audio', 'Audio only', false], ['slides', 'Slides', false]];
const langName = (l: string) => (l === 'hi' ? 'Hindi' : 'English');
let seq = 0; const tmp = () => `new-${++seq}`;
const sizeText = (b: number) => (b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const isNew = (id: string) => id.startsWith('new-');

/** Editing a DRAFT. Structure (titles, order, hours) is saved as a whole; each topic's quiz, assignment and video are saved on their own. */
export function Editor({ t, reload, setDone }: { t: VersionTree; reload: () => Promise<void>; setDone: (m: string | null) => void }) {
  const [modules, setModules] = useState<AuthoredModule[]>(t.modules); const [hours, setHours] = useState(String(t.hours)); const [langs, setLangs] = useState<string[]>(t.languages); const [outcomes, setOutcomes] = useState(t.outcomes.join('\n'));
  const [error, setError] = useState<unknown>(null); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const sig = (ms: AuthoredModule[]) => JSON.stringify(ms.map((m) => [m.id, m.title, m.topics.map((x) => [x.id, x.title, x.hours, x.mandatory])]));
  const key = sig(t.modules) + JSON.stringify([t.hours, t.languages, t.outcomes]);
  // Reset the working copy only when the saved structure really changed (a new comment or a quiz save must not wipe unsaved typing).
  useEffect(() => { setModules(t.modules); setHours(String(t.hours)); setLangs(t.languages); setOutcomes(t.outcomes.join('\n')); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = useMemo(() => new Map(t.modules.flatMap((m) => m.topics.map((x) => [x.id, x] as const))), [t]);
  /** Components (quiz, assignment, videos) always come from the latest saved copy: they are edited and saved separately, so the working copy's can be stale. */
  const latest = (x: AuthoredTopic): AuthoredTopic => ({ ...(saved.get(x.id) ?? x), title: x.title, hours: x.hours, mandatory: x.mandatory });
  const dirty = sig(modules) !== sig(t.modules) || hours !== String(t.hours) || langs.join() !== t.languages.join() || outcomes !== t.outcomes.join('\n');
  const patchTopic = (mi: number, ti: number, f: Partial<AuthoredTopic>) => setModules(modules.map((m, i) => (i !== mi ? m : { ...m, topics: m.topics.map((x, j) => (j === ti ? { ...x, ...f } : x)) })));
  const total = modules.reduce((s, m) => s + m.topics.reduce((a, x) => a + (Number.isFinite(x.hours) ? x.hours : 0), 0), 0);
  const save = async () => {
    const h = Number(hours);
    const p = !Number.isInteger(h) || h < 1 ? 'Programme hours must be a whole number, 1 or more.' : !langs.length ? 'Choose at least one language.' : modules.some((m) => !m.title.trim()) ? 'Every module needs a title.' : modules.some((m) => m.topics.some((x) => !x.title.trim())) ? 'Every topic needs a title.' : modules.some((m) => m.topics.some((x) => !Number.isInteger(x.hours) || x.hours < 1)) ? 'Topic hours must be whole numbers, 1 or more.' : null;
    setProblem(p); if (p) return; setBusy(true); setError(null); setDone(null);
    try { await api.put(`/v1/authoring/versions/${t.id}`, { ...toEditBody(t, modules.map((m) => ({ ...m, topics: m.topics.map(latest) }))), hours: h, languages: langs, outcomes: outcomes.split('\n').map((x) => x.trim()).filter(Boolean) }); setOpen(null); setDone('Changes saved.'); await reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const removeTopic = (mi: number, ti: number) => { const x = modules[mi].topics[ti]; if ((x.quiz || x.assignment || x.assets.length) && !window.confirm(`Delete “${x.title}”? Its quiz, assignment and videos are deleted with it.`)) return; setModules(modules.map((m, i) => (i === mi ? { ...m, topics: m.topics.filter((_, j) => j !== ti) } : m))); };
  const removeModule = (mi: number) => { const m = modules[mi]; if (m.topics.length && !window.confirm(`Delete module “${m.title}” and its ${m.topics.length} topic${m.topics.length === 1 ? '' : 's'}, with all their quizzes, assignments and videos?`)) return; setModules(modules.filter((_, i) => i !== mi)); };
  return (
    <>
      <Card title="Programme details" actions={dirty && <Badge tone="warn">Unsaved changes</Badge>}>
        <label htmlFor="pd-h">Total hours</label><input id="pd-h" inputMode="numeric" value={hours} onChange={(e) => { setHours(e.target.value); setProblem(null); }} style={{ width: '6rem' }} /> <span className="muted">Topic hours add up to {total}.</span>
        <fieldset><legend>Languages</legend>{[['en', 'English'], ['hi', 'Hindi']].map(([k, l]) => <label key={k} className="inline"><input type="checkbox" checked={langs.includes(k)} onChange={(e) => { setLangs(e.target.checked ? [...langs, k] : langs.filter((x) => x !== k)); setProblem(null); }} /> {l}</label>)}</fieldset>
        <label htmlFor="pd-o">Learning outcomes (one per line)</label><textarea id="pd-o" value={outcomes} onChange={(e) => setOutcomes(e.target.value)} />
      </Card>
      <Card title="Structure">
        {modules.map((m, mi) => (
          <div key={m.id} className="subcard">
            <div className="choices"><label htmlFor={`mt-${m.id}`}>Module {mi + 1}</label><input id={`mt-${m.id}`} value={m.title} onChange={(e) => { setModules(modules.map((x, i) => (i === mi ? { ...x, title: e.target.value } : x))); setProblem(null); }} style={{ flex: 1 }} />
              <button type="button" aria-label={`Move module ${mi + 1} up`} disabled={mi === 0} onClick={() => setModules(move(modules, mi, -1))}>↑</button><button type="button" aria-label={`Move module ${mi + 1} down`} disabled={mi === modules.length - 1} onClick={() => setModules(move(modules, mi, 1))}>↓</button><button type="button" className="link" onClick={() => removeModule(mi)}>Delete module</button></div>
            {m.topics.map((x, ti) => { const s = topicStatus(latest(x), langs); return (
              <div key={x.id} className="subcard">
                <div className="choices"><label htmlFor={`tt-${x.id}`}>Topic {ti + 1}</label><input id={`tt-${x.id}`} value={x.title} onChange={(e) => { patchTopic(mi, ti, { title: e.target.value }); setProblem(null); }} style={{ flex: 1 }} />
                  <label htmlFor={`th-${x.id}`}>Hours</label><input id={`th-${x.id}`} inputMode="numeric" value={Number.isFinite(x.hours) ? x.hours : ''} onChange={(e) => { patchTopic(mi, ti, { hours: e.target.value === '' ? NaN : Number(e.target.value) }); setProblem(null); }} style={{ width: '4rem' }} />
                  <label className="inline"><input type="checkbox" checked={x.mandatory} onChange={(e) => patchTopic(mi, ti, { mandatory: e.target.checked })} /> Required</label>
                  <button type="button" aria-label={`Move topic ${x.title || ti + 1} up`} disabled={ti === 0} onClick={() => setModules(modules.map((q, i) => (i === mi ? { ...q, topics: move(q.topics, ti, -1) } : q)))}>↑</button><button type="button" aria-label={`Move topic ${x.title || ti + 1} down`} disabled={ti === m.topics.length - 1} onClick={() => setModules(modules.map((q, i) => (i === mi ? { ...q, topics: move(q.topics, ti, 1) } : q)))}>↓</button><button type="button" className="link" onClick={() => removeTopic(mi, ti)}>Delete topic</button></div>
                <p className="muted">{s.videos.map((v) => `${langName(v.language)} video ${v.ok ? '✓' : '✗'}`).join(' · ')} · quiz {s.quiz} question{s.quiz === 1 ? '' : 's'} · {s.assignment ? 'assignment ✓' : 'no assignment'}</p>
                {isNew(x.id) ? <p className="muted">Save the structure to add a quiz, assignment or video to this topic.</p> : dirty ? <p className="muted">Save your structure changes first, then edit this topic's quiz, assignment and video.</p> : <button type="button" aria-expanded={open === x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Close the topic editor' : 'Edit quiz, assignment and video'}</button>}
                {open === x.id && !dirty && <TopicEditor topic={latest(x)} languages={langs} reload={reload} setDone={setDone} />}
              </div>); })}
            <button type="button" onClick={() => setModules(modules.map((q, i) => (i === mi ? { ...q, topics: [...q.topics, { id: tmp(), position: q.topics.length + 1, title: '', hours: 1, outcomes: [], prerequisites: [], mandatory: true, quiz: null, assignment: null, assets: [] }] } : q)))}>Add a topic</button>
          </div>))}
        <button type="button" onClick={() => setModules([...modules, { id: tmp(), position: modules.length + 1, title: '', topics: [] }])}>Add a module</button>
        {problem && <p role="alert" className="note error">{problem}</p>}<ErrorNote error={error} />
        <div className="choices"><button onClick={() => void save()} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save changes'}</button>{dirty && <button className="link" onClick={() => { setModules(t.modules); setHours(String(t.hours)); setLangs(t.languages); setOutcomes(t.outcomes.join('\n')); setProblem(null); }}>Discard changes</button>}</div>
      </Card>
    </>
  );
}

function TopicEditor({ topic, languages, reload, setDone }: { topic: AuthoredTopic; languages: string[]; reload: () => Promise<void>; setDone: (m: string | null) => void }) {
  const [tab, setTab] = useState<'quiz' | 'assignment' | 'video'>('quiz'); const [msg, setMsg] = useState<string | null>(null);
  const say = (m: string | null) => { setMsg(m); setDone(m); }; // the note at the top of the page may be out of sight, so show it here too
  return (
    <div className="subcard">
      <div className="tabs" role="group" aria-label="Component">{([['quiz', 'Quiz'], ['assignment', 'Assignment'], ['video', 'Video']] as const).map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {msg && <p role="status" className="note">{msg}</p>}
      {tab === 'quiz' && <QuizEditor topic={topic} reload={reload} setDone={say} />}
      {tab === 'assignment' && <AssignmentEditor topic={topic} reload={reload} setDone={say} />}
      {tab === 'video' && <VideoEditor topic={topic} languages={languages} reload={reload} setDone={say} />}
    </div>
  );
}

function QuizEditor({ topic, reload, setDone }: { topic: AuthoredTopic; reload: () => Promise<void>; setDone: (m: string | null) => void }) {
  const [qs, setQs] = useState<QuestionDraft[]>(() => (topic.quiz?.questions.map(draftFromQuestion) ?? [blankQuestion()])); const [pass, setPass] = useState(String(topic.quiz?.passPercent ?? 70)); const [att, setAtt] = useState(String(topic.quiz?.maxAttempts ?? 3));
  const [problems, setProblems] = useState<string[]>([]); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const set = (i: number, f: Partial<QuestionDraft>) => { setQs(qs.map((q, k) => (k === i ? { ...q, ...f } : q))); setProblems([]); };
  const save = async () => {
    const out: string[] = []; const p = Number(pass), a = Number(att);
    if (!(Number.isInteger(p) && p >= 1 && p <= 100)) out.push('The pass mark must be a whole number from 1 to 100.'); if (!(Number.isInteger(a) && a >= 1)) out.push('Attempts must be a whole number, 1 or more.'); if (!qs.length) out.push('Add at least one question.');
    qs.forEach((q, i) => { const e = validateQuestion(q); if (e) out.push(`Question ${i + 1}: ${e}`); }); setProblems(out); if (out.length) return;
    setBusy(true); setError(null); setDone(null);
    try { await api.put(`/v1/authoring/topics/${topic.id}/quiz`, { passPercent: p, maxAttempts: a, questions: qs.map((q, i) => questionFromDraft(q, i + 1)) }); setDone('Quiz saved.'); await reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
      <div className="choices"><label htmlFor={`qp-${topic.id}`}>Pass mark (%)</label><input id={`qp-${topic.id}`} inputMode="numeric" value={pass} onChange={(e) => setPass(e.target.value)} style={{ width: '5rem' }} /><label htmlFor={`qa-${topic.id}`}>Attempts allowed</label><input id={`qa-${topic.id}`} inputMode="numeric" value={att} onChange={(e) => setAtt(e.target.value)} style={{ width: '5rem' }} /></div>
      {qs.map((q, i) => (
        <fieldset key={i} className="subcard"><legend>Question {i + 1}</legend>
          <label htmlFor={`qt-${topic.id}-${i}`}>Type</label><select id={`qt-${topic.id}-${i}`} value={q.type} onChange={(e) => set(i, { type: e.target.value as QuestionDraft['type'] })}><option value="MCQ_SINGLE">One correct answer</option><option value="MCQ_MULTI">Several correct answers</option><option value="NUMERIC">A number</option></select>
          <label htmlFor={`qx-${topic.id}-${i}`}>Question</label><textarea id={`qx-${topic.id}-${i}`} value={q.text} onChange={(e) => set(i, { text: e.target.value })} />
          {q.type !== 'NUMERIC' ? <>
            {q.options.map((o, k) => (
              <div key={k} className="choices">
                {q.type === 'MCQ_SINGLE' ? <input type="radio" name={`ans-${topic.id}-${i}`} checked={q.single === k} onChange={() => set(i, { single: k })} aria-label={`Option ${k + 1} is correct`} /> : <input type="checkbox" checked={q.multi.includes(k)} onChange={(e) => set(i, { multi: e.target.checked ? [...q.multi, k] : q.multi.filter((n) => n !== k) })} aria-label={`Option ${k + 1} is correct`} />}
                <input value={o} aria-label={`Option ${k + 1} text`} onChange={(e) => set(i, { options: q.options.map((x, n) => (n === k ? e.target.value : x)) })} style={{ flex: 1 }} />
                {q.options.length > 2 && <button type="button" className="link" onClick={() => { setQs(qs.map((x, n) => (n === i ? removeOption(x, k) : x))); setProblems([]); }}>Remove option {k + 1}</button>}
              </div>))}
            {q.options.length < 8 && <button type="button" onClick={() => set(i, { options: [...q.options, ''] })}>Add an option</button>}
          </> : <div className="choices"><label htmlFor={`qn-${topic.id}-${i}`}>Correct number</label><input id={`qn-${topic.id}-${i}`} value={q.numeric} onChange={(e) => set(i, { numeric: e.target.value })} style={{ width: '8rem' }} /><label htmlFor={`qo-${topic.id}-${i}`}>Allowed difference (±)</label><input id={`qo-${topic.id}-${i}`} value={q.tolerance} onChange={(e) => set(i, { tolerance: e.target.value })} style={{ width: '6rem' }} /></div>}
          <div className="choices"><label htmlFor={`qs-${topic.id}-${i}`}>Points</label><input id={`qs-${topic.id}-${i}`} inputMode="numeric" value={q.points} onChange={(e) => set(i, { points: e.target.value })} style={{ width: '4rem' }} /></div>
          <label htmlFor={`qr-${topic.id}-${i}`}>Why it is correct (shown to the learner after the quiz)</label><textarea id={`qr-${topic.id}-${i}`} value={q.rationale} onChange={(e) => set(i, { rationale: e.target.value })} />
          <div className="choices"><button type="button" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => setQs(move(qs, i, -1))}>↑</button><button type="button" aria-label={`Move question ${i + 1} down`} disabled={i === qs.length - 1} onClick={() => setQs(move(qs, i, 1))}>↓</button><button type="button" className="link" onClick={() => { setQs(qs.filter((_, k) => k !== i)); setProblems([]); }}>Delete question {i + 1}</button></div>
        </fieldset>))}
      <button type="button" onClick={() => setQs([...qs, blankQuestion()])}>Add a question</button>
      {problems.length > 0 && <div role="alert" className="note error"><p>Please fix:</p><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}<ErrorNote error={error} />
      <p><button disabled={busy}>{busy ? 'Saving…' : 'Save quiz'}</button></p>
    </form>
  );
}

function AssignmentEditor({ topic, reload, setDone }: { topic: AuthoredTopic; reload: () => Promise<void>; setDone: (m: string | null) => void }) {
  const a = topic.assignment; const pol = (a?.policy ?? {}) as { dimensions?: { name: string; weight: number }[]; passPercent?: number };
  const initial: CriterionDraft[] = a?.rubric.criteria?.length ? a.rubric.criteria.map((c) => ({ criterion: c.criterion, weight: String(c.weight), description: c.description ?? '' })) : pol.dimensions?.length ? pol.dimensions.map((d) => ({ criterion: d.name, weight: String(d.weight), description: '' })) : blankCriteria();
  const [ins, setIns] = useState(a?.instructions ?? ''); const [max, setMax] = useState(String(a?.maxSubmissions ?? 3)); const [pass, setPass] = useState(String(pol.passPercent ?? 60)); const [cs, setCs] = useState(initial);
  const [problems, setProblems] = useState<string[]>([]); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    const out: string[] = []; if (!ins.trim()) out.push('Write the instructions.'); const m = Number(max), p = Number(pass);
    if (!(Number.isInteger(m) && m >= 1)) out.push('Submissions allowed must be a whole number, 1 or more.'); if (!(p >= 0 && p <= 100)) out.push('The pass mark must be between 0 and 100.');
    const r = validateRubric(cs); if (r) out.push(r); setProblems(out); if (out.length) return; setBusy(true); setError(null); setDone(null);
    try {
      await api.put(`/v1/authoring/topics/${topic.id}/assignment`, { instructions: ins.trim(), maxSubmissions: m, rubric: { criteria: cs.map((c) => ({ criterion: c.criterion.trim(), weight: Number(c.weight), ...(c.description.trim() && { description: c.description.trim() }) })) } });
      await api.put(`/v1/authoring/topics/${topic.id}/assignment-policy`, { dimensions: [], passPercent: p }); // dimensions: [] makes the server rebuild the scoring scale from these criteria, so an older stored scale cannot linger
      setDone('Assignment saved.'); await reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const setC = (i: number, f: Partial<CriterionDraft>) => { setCs(cs.map((c, k) => (k === i ? { ...c, ...f } : c))); setProblems([]); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
      <label htmlFor={`ai-${topic.id}`}>Instructions for the learner</label><textarea id={`ai-${topic.id}`} value={ins} onChange={(e) => { setIns(e.target.value); setProblems([]); }} />
      <div className="choices"><label htmlFor={`am-${topic.id}`}>Submissions allowed</label><input id={`am-${topic.id}`} inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} style={{ width: '5rem' }} /><label htmlFor={`ap-${topic.id}`}>Pass mark (%)</label><input id={`ap-${topic.id}`} inputMode="numeric" value={pass} onChange={(e) => setPass(e.target.value)} style={{ width: '5rem' }} /></div>
      <h4>Marking criteria</h4><p className="muted">Weights must add up to 100. Each criterion is scored on a standard five-level scale (0–4). Saving rebuilds the scale from these criteria. Late penalties and integrity rules are set through the API.</p>
      {cs.map((c, i) => (
        <div key={i} className="choices"><input aria-label={`Criterion ${i + 1} name`} placeholder="Criterion" value={c.criterion} onChange={(e) => setC(i, { criterion: e.target.value })} /><input aria-label={`Criterion ${i + 1} weight`} inputMode="decimal" value={c.weight} onChange={(e) => setC(i, { weight: e.target.value })} style={{ width: '5rem' }} /><input aria-label={`Criterion ${i + 1} description`} placeholder="What excellent looks like (optional)" value={c.description} onChange={(e) => setC(i, { description: e.target.value })} style={{ flex: 1 }} />{cs.length > 1 && <button type="button" className="link" onClick={() => { setCs(cs.filter((_, k) => k !== i)); setProblems([]); }}>Remove criterion {i + 1}</button>}</div>))}
      <button type="button" onClick={() => setCs([...cs, { criterion: '', weight: '', description: '' }])}>Add a criterion</button>
      {problems.length > 0 && <div role="alert" className="note error"><p>Please fix:</p><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}<ErrorNote error={error} />
      <p><button disabled={busy}>{busy ? 'Saving…' : 'Save assignment'}</button></p>
    </form>
  );
}

function VideoEditor({ topic, languages, reload, setDone }: { topic: AuthoredTopic; languages: string[]; reload: () => Promise<void>; setDone: (m: string | null) => void }) {
  const [lang, setLang] = useState(languages[0] ?? 'en'); const [mins, setMins] = useState(''); const [rights, setRights] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const register = async () => {
    const m = Number(mins); const p = !(m > 0) ? 'Enter the video length in minutes.' : !rights.trim() ? 'Say who owns the rights and under what licence the video is used.' : topic.assets.some((a) => a.kind === 'VIDEO' && a.language === lang) ? `This topic already has a ${langName(lang)} video. Upload files to it below.` : null; setProblem(p); if (p) return;
    setBusy(true); setError(null); setDone(null);
    try { await api.post(`/v1/authoring/topics/${topic.id}/assets`, { kind: 'VIDEO', language: lang, durationSec: Math.round(m * 60), rights: { statement: rights.trim() }, provenance: { source: 'manual' } }); setMins(''); setRights(''); setDone('Video added. Now upload its files.'); await reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div>
      {topic.assets.map((a) => <AssetFiles key={a.id} a={a} reload={reload} setDone={setDone} />)}
      <form onSubmit={(e) => { e.preventDefault(); void register(); }} noValidate className="subcard">
        <h4>Add a video</h4>
        <label htmlFor={`vl-${topic.id}`}>Language</label><select id={`vl-${topic.id}`} value={lang} onChange={(e) => { setLang(e.target.value); setProblem(null); }}>{languages.map((l) => <option key={l} value={l}>{langName(l)}</option>)}</select>
        <label htmlFor={`vm-${topic.id}`}>Length (minutes)</label><input id={`vm-${topic.id}`} inputMode="decimal" value={mins} onChange={(e) => { setMins(e.target.value); setProblem(null); }} style={{ width: '6rem' }} />
        <label htmlFor={`vr-${topic.id}`}>Rights and licence</label><input id={`vr-${topic.id}`} value={rights} onChange={(e) => { setRights(e.target.value); setProblem(null); }} />
        {problem && <p role="alert" className="note error">{problem}</p>}<ErrorNote error={error} />
        <button disabled={busy}>{busy ? 'Adding…' : 'Add video'}</button>
        <p className="muted">Interactive questions inside a video are added through the API.</p>
      </form>
    </div>
  );
}

function AssetFiles({ a, reload, setDone }: { a: AuthoredAsset; reload: () => Promise<void>; setDone: (m: string | null) => void }) {
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const files = useMemo(() => a.files ?? {}, [a.files]);
  const upload = async (label: string, f: File | undefined) => {
    if (!f) return; setBusy(label); setError(null); setDone(null);
    try { await api.upload(`/v1/authoring/assets/${a.id}/files/${label}`, f); setDone(`${label} uploaded.`); await reload(); } catch (e) { setError(e); } finally { setBusy(null); if (inputs.current[label]) inputs.current[label]!.value = ''; }
  };
  return (
    <div className="subcard">
      <h4>{langName(a.language)} {a.kind.toLowerCase()} <span className="muted">{a.durationSec ? `${Math.round(a.durationSec / 60)} min` : ''}</span></h4>
      <ul className="plain">{LABELS.map(([k, l, req]) => (
        <li key={k} className="choices"><span>{l}: {files[k] ? <Badge tone="ok">uploaded · {sizeText(files[k].size)}</Badge> : <Badge tone={req ? 'warn' : 'muted'}>{req ? 'missing' : 'not added'}</Badge>}</span>
          <label className="inline"><input type="file" aria-label={`${files[k] ? 'Replace' : 'Upload'} ${k}`} ref={(el) => { inputs.current[k] = el; }} disabled={busy !== null} onChange={(e) => void upload(k, e.target.files?.[0])} /></label>{busy === k && <span role="status">Uploading…</span>}</li>))}</ul>
      <ErrorNote error={error} />
    </div>
  );
}
