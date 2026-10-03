import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BankCoverage, BankQuestion, ExamSetupInfo } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { blankQuestion, questionFromDraft, removeOption, validateQuestion, type QuestionDraft } from '../lib/content';
import { difficultyLabel, reasonError, tagsOf } from '../lib/examsetup';

/** The question bank for one programme: what it holds per topic and difficulty, the questions with their answers, and adding or retiring them. */
export function Bank({ setup, canEdit }: { setup: ExamSetupInfo; canEdit: boolean }) {
  const progs = [...new Map(setup.versions.map((v) => [v.programmeId, v])).values()];
  const [pid, setPid] = useState(progs[0]?.programmeId ?? ''); const [tag, setTag] = useState('');
  const [cov, setCov] = useState<BankCoverage[] | null>(null); const [qs, setQs] = useState<BankQuestion[] | null>(null); const [next, setNext] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => {
    if (!pid) return; try {
      const [c, l] = await Promise.all([api.get<BankCoverage[]>(`/v1/exams/bank/${pid}/coverage`), api.page<BankQuestion>(`/v1/exams/bank/${pid}/questions?limit=50${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`)]); setCov(c); setQs(l.items); setNext(l.next); if (clear) setError(null);
    } catch (e) { setError(e); }
  }, [pid, tag]);
  useEffect(() => { setCov(null); setQs(null); void load(); }, [load]);
  const more = async () => { try { const l = await api.page<BankQuestion>(`/v1/exams/bank/${pid}/questions?limit=50&cursor=${next}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`); setQs((x) => [...(x ?? []), ...l.items]); setNext(l.next); } catch (e) { setError(e); } };
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); return true; } catch (e) { setError(e); return false; } };
  if (!progs.length) return <Card><p>No course is published yet, so there is nothing to build a question bank for.</p></Card>;
  const tags = cov ? tagsOf(cov) : [];
  return (
    <>
      <label htmlFor="bk-p" className="inline">Course</label> <select id="bk-p" value={pid} onChange={(e) => { setPid(e.target.value); setTag(''); }} style={{ width: 'auto' }}>{progs.map((p) => <option key={p.programmeId} value={p.programmeId}>{p.title} ({p.code})</option>)}</select>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      <Card title="What the bank holds">{!cov ? (!error && <Loading />) : !cov.length ? <p>The bank is empty. Add questions below.</p> : (
        <table><thead><tr><th>Topic tag</th>{[1, 2, 3, 4, 5].map((d) => <th key={d}>{d}</th>)}<th>Total</th></tr></thead><tbody>{tags.map((t) => <tr key={t}><td>{t}</td>{[1, 2, 3, 4, 5].map((d) => <td key={d}>{cov.find((c) => c.tag === t && c.difficulty === d)?.count ?? 0}</td>)}<td><strong>{cov.filter((c) => c.tag === t).reduce((n, c) => n + c.count, 0)}</strong></td></tr>)}</tbody></table>)}
        <p className="muted">Difficulty runs from 1 (very easy) to 5 (very hard). An exam's sections draw from these counts.</p></Card>
      {canEdit && <AddQuestion tags={tags} onAdd={(q) => act(() => api.post(`/v1/exams/bank/${pid}/questions`, { questions: [q] }), 'Question added to the bank.')} />}
      <Card title="Questions" actions={<><label htmlFor="bk-t" className="sr-only">Filter by tag</label><select id="bk-t" value={tag} onChange={(e) => setTag(e.target.value)} style={{ width: 'auto' }}><option value="">All tags</option>{tags.map((t) => <option key={t} value={t}>{t}</option>)}</select></>}>
        <p className="muted">This is the answer key. Keep it to yourselves.</p>
        {!qs ? (!error && <Loading />) : !qs.length ? <p>No questions.</p> : <ul className="plain">{qs.map((q) => (
          <li key={q.id} className="subcard"><p><Badge tone="muted">{q.tag}</Badge> <Badge tone="muted">{difficultyLabel(q.difficulty)}</Badge> <span className="muted">{q.points} point{q.points === 1 ? '' : 's'} · used {q.usedCount}×</span></p><p>{q.text}</p>
            {q.options.length > 0 ? <ul>{q.options.map((o, i) => <li key={i}>{(Array.isArray(q.answer) ? q.answer.includes(i) : q.answer === i) ? <strong>✓ {o}</strong> : o}</li>)}</ul> : <p>Answer: <strong>{String(q.answer)}</strong>{q.tolerance ? ` (± ${q.tolerance})` : ''}</p>}
            {canEdit && <Retire onRetire={(r) => act(() => api.post(`/v1/exams/bank/questions/${q.id}/retire`, { reason: r }), 'Question retired: new papers will not use it.')} />}
          </li>))}</ul>}
        {next && <p><button onClick={() => void more()}>Show more</button></p>}
      </Card>
    </>
  );
}

function Retire({ onRetire }: { onRetire: (r: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [r, setR] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  if (!open) return <button className="link" onClick={() => setOpen(true)}>Retire this question…</button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); const p = reasonError(r); setProblem(p); if (!p) void onRetire(r.trim()); }} noValidate>
      <label>Why it is being retired<textarea value={r} onChange={(e) => { setR(e.target.value); setProblem(null); }} /></label>{problem && <p role="alert" className="note error">{problem}</p>}
      <p className="muted">Papers already issued keep it; new papers will not draw it.</p><div className="choices"><button>Retire</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function AddQuestion({ tags, onAdd }: { tags: string[]; onAdd: (q: object) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState<QuestionDraft>(blankQuestion()); const [tag, setTag] = useState(''); const [diff, setDiff] = useState('2'); const [problem, setProblem] = useState<string | null>(null);
  const set = (f: Partial<QuestionDraft>) => { setQ({ ...q, ...f }); setProblem(null); };
  if (!open) return <p><button onClick={() => setOpen(true)}>Add a question</button></p>;
  return (
    <Card title="Add a question">
      <form onSubmit={(e) => { e.preventDefault(); const p = !tag.trim() ? 'Give the question a topic tag (exam sections draw questions by tag).' : validateQuestion(q); setProblem(p); if (p) return; const a = questionFromDraft(q, 1); void onAdd({ type: a.type, text: a.text, tag: tag.trim(), difficulty: Number(diff), options: a.options, answer: a.answer, tolerance: a.tolerance, points: a.points }).then((ok) => { if (ok) { setQ(blankQuestion()); setProblem(null); } }); }} noValidate>
        <label htmlFor="aq-tag">Topic tag</label><input id="aq-tag" list="aq-tags" value={tag} onChange={(e) => { setTag(e.target.value); setProblem(null); }} /><datalist id="aq-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
        <label htmlFor="aq-d">Difficulty</label><select id="aq-d" value={diff} onChange={(e) => setDiff(e.target.value)}>{[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d} – {difficultyLabel(d)}</option>)}</select>
        <label htmlFor="aq-t">Kind</label><select id="aq-t" value={q.type} onChange={(e) => set({ type: e.target.value as QuestionDraft['type'] })}><option value="MCQ_SINGLE">One correct answer</option><option value="MCQ_MULTI">Several correct answers</option><option value="NUMERIC">A number</option></select>
        <label htmlFor="aq-x">Question</label><textarea id="aq-x" value={q.text} onChange={(e) => set({ text: e.target.value })} />
        {q.type !== 'NUMERIC' ? <>{q.options.map((o, k) => (
          <div key={k} className="choices">{q.type === 'MCQ_SINGLE' ? <input type="radio" name="aq-ans" checked={q.single === k} onChange={() => set({ single: k })} aria-label={`Option ${k + 1} is correct`} /> : <input type="checkbox" checked={q.multi.includes(k)} onChange={(e) => set({ multi: e.target.checked ? [...q.multi, k] : q.multi.filter((n) => n !== k) })} aria-label={`Option ${k + 1} is correct`} />}
            <input value={o} aria-label={`Option ${k + 1} text`} onChange={(e) => set({ options: q.options.map((x, n) => (n === k ? e.target.value : x)) })} style={{ flex: 1 }} />{q.options.length > 2 && <button type="button" className="link" onClick={() => { setQ(removeOption(q, k)); setProblem(null); }}>Remove option {k + 1}</button>}</div>))}
          {q.options.length < 8 && <button type="button" onClick={() => set({ options: [...q.options, ''] })}>Add an option</button>}</>
          : <div className="choices"><label htmlFor="aq-n">Correct number</label><input id="aq-n" value={q.numeric} onChange={(e) => set({ numeric: e.target.value })} style={{ width: '8rem' }} /><label htmlFor="aq-o">Allowed difference (±)</label><input id="aq-o" value={q.tolerance} onChange={(e) => set({ tolerance: e.target.value })} style={{ width: '6rem' }} /></div>}
        <label htmlFor="aq-p">Points</label><input id="aq-p" inputMode="numeric" value={q.points} onChange={(e) => set({ points: e.target.value })} style={{ width: '5rem' }} />
        {problem && <p role="alert" className="note error">{problem}</p>}
        <div className="choices"><button>Add to the bank</button><button type="button" className="link" onClick={() => setOpen(false)}>Close</button></div>
      </form>
    </Card>
  );
}
