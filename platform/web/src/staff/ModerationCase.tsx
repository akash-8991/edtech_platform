import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CaseFile, DecideResult, GradeRecordView } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { canConfirmAi, describeReason, estimatePercent, hasIntegrityFlag, kindLabel, lastRecord, scoreError, validateDecision, type DecisionInput } from '../lib/moderation';
import { AREAS, canSee, hasAny } from '../lib/roles';

export default function ModerationCase() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'moderation') || !hasAny(me?.roles, AREAS.moderation.act)) return <Navigate to="/staff/moderation" replace />; // only reviewers open case files
  return <Case />;
}

function Case() {
  const { taskId = '' } = useParams(); const nav = useNavigate();
  const [c, setC] = useState<CaseFile | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<CaseFile>(`/v1/moderation/tasks/${taskId}`).then(setC).catch(setError); }, [taskId]);
  if (!c) return error ? <div><ErrorNote error={error} /><p><Link to="/staff/moderation">Back to the queue</Link></p></div> : <Loading what="Opening the case file" />;
  return (
    <div>
      <p><Link to="/staff/moderation">Back to the queue</Link></p>
      <h1>Submission {c.learnerRef}</h1>
      <p><Badge tone={c.task.kind === 'APPEAL' ? 'warn' : 'muted'}>{kindLabel(c.task.kind)}</Badge> <span className="muted">attempt {c.attemptNo} · submitted {new Date(c.submittedAt).toLocaleString()} · state {c.state.toLowerCase().replace(/_/g, ' ')}</span></p>
      <Card title="Why this is here"><ul>{c.reasons.concat(c.task.reasons.filter((r) => !c.reasons.includes(r))).map((r) => <li key={r}>{describeReason(r)}</li>)}</ul></Card>
      <Card title="The assignment"><p className="qtext">{c.assignment.instructions || '(no instructions recorded)'}</p></Card>
      <Card title="What the learner submitted">
        {c.submission.text ? <pre className="transcript" tabIndex={0} aria-label="Submitted text">{c.submission.text}</pre> : <p className="muted">No text was submitted.</p>}
        {c.submission.files.length > 0 && <><h3>Files</h3><ul>{c.submission.files.map((f, i) => <li key={i}>{f.name ?? f.key}{f.size ? ` (${Math.round(f.size / 1024)} KB)` : ''}</li>)}</ul></>}
        {c.submission.testResults != null && <details><summary>Automated test results</summary><pre className="transcript">{JSON.stringify(c.submission.testResults, null, 1)}</pre></details>}
        <p className="muted mono">content hash {c.submission.contentHash.slice(0, 16)}…</p>
      </Card>
      {c.similarity.length > 0 && (
        <Card title="Similar submissions" actions={<Badge tone="warn">Staff only</Badge>}><p className="muted">Never shown to the learner. High similarity is a reason to look closely, not proof of copying.</p>
          <ul className="plain">{c.similarity.map((s, i) => <li key={i} className="dim"><div className="row"><span className="strong">Submission {s.otherRef}</span><span>{Math.round(s.score * 100)}% overlap</span></div><blockquote>{s.excerpt}</blockquote></li>)}</ul></Card>)}
      <History records={c.records} />
      <DecisionForm c={c} onDone={(r) => { /* result shown inside the form */ void r; }} onBack={() => nav('/staff/moderation')} />
    </div>
  );
}

function History({ records }: { records: GradeRecordView[] }) {
  if (!records.length) return <Card title="Grading history"><p className="muted">No grade exists yet (the AI could not produce one).</p></Card>;
  return (
    <Card title="Grading history">
      <ul className="plain">{records.map((r) => (
        <li key={r.seq} className="dim"><div className="row"><span className="strong">{r.kind === 'AI' ? 'AI grade' : r.kind === 'MODERATED' ? 'Teacher grade' : r.kind === 'APPEAL' ? 'Appeal decision' : r.kind.toLowerCase()}</span><span>{r.finalPercent}% {r.passed ? '· passed' : '· not passed'}</span></div>
          <p className="muted">{new Date(r.at).toLocaleString()}{r.model ? ` · ${r.model}` : ''}{typeof r.confidence === 'number' ? ` · confidence ${Math.round(r.confidence * 100)}%` : ''}{r.latePenaltyPercent ? ` · late penalty ${r.latePenaltyPercent}%` : ''}</p>
          {r.flags && r.flags.length > 0 && <p>{r.flags.map((f) => <Badge key={f} tone="warn">{describeReason(f)}</Badge>)}</p>}
          <table className="grid"><thead><tr><th>Dimension</th><th>Score</th><th>Rationale and evidence</th></tr></thead><tbody>{r.dimensions.map((d) => (
            <tr key={d.id}><td>{d.id}</td><td>{d.score} / {d.max}</td><td>{d.rationale}{d.evidence?.map((e, i) => <blockquote key={i}>&ldquo;{e.quote}&rdquo; <span className="muted">{e.location}{e.verified === false ? ' · NOT verified against the submission' : ''}</span></blockquote>)}</td></tr>))}</tbody></table>
          {r.feedback && <p><strong>Feedback:</strong> {r.feedback}</p>}{r.reason && <p className="muted">Reason recorded: {r.reason}</p>}</li>))}</ul>
    </Card>
  );
}

function DecisionForm({ c, onDone, onBack }: { c: CaseFile; onDone: (r: DecideResult) => void; onBack: () => void }) {
  const prev = lastRecord(c); const kind = c.task.kind; const integrity = kind === 'BLOCKING' && hasIntegrityFlag(c.reasons);
  const [d, setD] = useState<DecisionInput>({ scores: {}, feedback: '', reason: '', integrity: '', outcome: '', confirmAi: false });
  const [problems, setProblems] = useState<string[]>([]); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [result, setResult] = useState<DecideResult | null>(null); const [released, setReleased] = useState(false);
  const est = useMemo(() => estimatePercent(c.policy.dimensions, Object.fromEntries(Object.entries(d.scores).map(([k, v]) => [k, v === '' ? undefined : Number(v)]))), [c, d.scores]);
  const allScored = c.policy.dimensions.every((x) => d.scores[x.id] !== undefined && d.scores[x.id] !== '' && !scoreError(x, d.scores[x.id]));
  const set = (patch: Partial<DecisionInput>) => { setProblems([]); setD((x) => ({ ...x, ...patch })); }; // an old "please fix" list must not outlive the fix
  const startFromLast = () => prev && set({ scores: Object.fromEntries(prev.dimensions.map((x) => [x.id, String(x.score)])), feedback: d.feedback || prev.feedback || '' });
  const submit = async () => {
    const p = validateDecision(c, d); setProblems(p); if (p.length) return; setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { reason: d.reason.trim(), ...(d.feedback.trim() && { feedback: d.feedback.trim() }), ...(integrity && { integrityOutcome: d.integrity }), ...(kind === 'APPEAL' && { outcome: d.outcome }) };
      if (d.confirmAi) body.confirmAi = true; else body.dimensions = c.policy.dimensions.map((x) => ({ id: x.id, score: Number(d.scores[x.id]), ...(rationales[x.id]?.trim() && { rationale: rationales[x.id].trim() }) }));
      const r = await api.post<DecideResult>(`/v1/moderation/tasks/${c.task.id}/decide`, body); setResult(r); onDone(r);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const release = async () => { setError(null); try { await api.post(`/v1/moderation/tasks/${c.task.id}/release`); setReleased(true); } catch (e) { setError(e); } };
  if (result) return <Card title="Decision recorded"><p className="note ok" role="status">The grade is now <strong>{result.finalPercent}%</strong> ({result.passed ? 'passed' : 'not passed'}). The learner has been notified.</p><button onClick={onBack}>Back to the queue</button></Card>;
  if (released) return <Card title="Returned to the queue"><p>Another reviewer can pick this up.</p><button onClick={onBack}>Back to the queue</button></Card>;
  return (
    <Card title={kind === 'APPEAL' ? 'Decide the appeal' : 'Your grade'}>
      {kind === 'APPEAL' && <p className="note warn">You were chosen because you did not give the original grade. Decide on the merits: the learner has asked for a fresh look.</p>}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Decision">
        <div className="choices">{prev && <button type="button" className="secondary" onClick={startFromLast}>Start from the {prev.kind === 'AI' ? "AI's" : 'previous'} scores</button>}
          {canConfirmAi(c) && <label className="choice"><input type="checkbox" checked={d.confirmAi} onChange={(e) => set({ confirmAi: e.target.checked })} /> I have reviewed the AI's grade and agree with it as it stands</label>}</div>
        {!d.confirmAi && (
          <fieldset className="question" aria-label="Rubric">{c.policy.dimensions.map((x) => { const err = d.scores[x.id] ? scoreError(x, d.scores[x.id]) : null; return (
            <div key={x.id} className="dim"><label htmlFor={`sc-${x.id}`}>{x.name} <span className="muted">(weight {x.weight}%, score {x.min} to {x.max})</span></label>
              {x.levels?.length ? <details><summary>What each score means</summary><ul>{x.levels.map((l) => <li key={l.score}><strong>{l.score}</strong>: {l.descriptor}</li>)}</ul></details> : null}
              <input id={`sc-${x.id}`} type="number" step={0.5} min={x.min} max={x.max} value={d.scores[x.id] ?? ''} onChange={(e) => set({ scores: { ...d.scores, [x.id]: e.target.value } })} aria-invalid={!!err} aria-describedby={err ? `sce-${x.id}` : undefined} />
              {err && <p id={`sce-${x.id}`} role="alert" className="note error">{err}</p>}
              <label htmlFor={`ra-${x.id}`}>Why this score (the learner sees this)</label><textarea id={`ra-${x.id}`} rows={2} value={rationales[x.id] ?? ''} onChange={(e) => { setProblems([]); setRationales({ ...rationales, [x.id]: e.target.value }); }} /></div>); })}
            <p aria-live="polite" className="strong">Estimated score: {allScored ? `${est}%` : '…'} <span className="muted">(pass mark {c.policy.passPercent}%; the server computes the final grade, including any late penalty)</span></p></fieldset>)}
        <label htmlFor="mc-fb">Feedback for the learner</label><textarea id="mc-fb" rows={4} value={d.feedback} onChange={(e) => set({ feedback: e.target.value })} />
        {integrity && (<fieldset className="question"><legend>Integrity flag: your decision is required</legend>
          <label className="choice"><input type="radio" name="integ" checked={d.integrity === 'CLEARED'} onChange={() => set({ integrity: 'CLEARED' })} /> Cleared: the work is the learner's own</label>
          <label className="choice"><input type="radio" name="integ" checked={d.integrity === 'CONFIRMED_CONCERN'} onChange={() => set({ integrity: 'CONFIRMED_CONCERN' })} /> Concern confirmed: refer to the academic administrators</label></fieldset>)}
        {kind === 'APPEAL' && (<fieldset className="question"><legend>Outcome of the appeal</legend>
          <label className="choice"><input type="radio" name="outc" checked={d.outcome === 'UPHELD'} onChange={() => set({ outcome: 'UPHELD' })} /> Upheld: the original grade stands</label>
          <label className="choice"><input type="radio" name="outc" checked={d.outcome === 'ADJUSTED'} onChange={() => set({ outcome: 'ADJUSTED' })} /> Adjusted: the grade changes</label></fieldset>)}
        <label htmlFor="mc-reason">Reason for your decision (recorded in the audit trail)</label><textarea id="mc-reason" rows={3} value={d.reason} onChange={(e) => set({ reason: e.target.value })} />
        {problems.length > 0 && <div role="alert" className="note error"><p>Please fix:</p><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        <ErrorNote error={error} />
        <div className="choices"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Submit decision'}</button><button type="button" className="secondary" onClick={() => void release()}>Give back to the queue</button></div>
      </form>
    </Card>
  );
}
