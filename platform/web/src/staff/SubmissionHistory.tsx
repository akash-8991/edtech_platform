import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { SubmissionHistory as History } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { gradeState, overrideStatus, pctText, previewPercent, proposeBlock, recordKind, startingScores, validateProposal } from '../lib/gradechanges';
import { canSee, GRADECHANGES, hasAny } from '../lib/roles';

export default function SubmissionHistory() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'gradechanges')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Page canAct={hasAny(me?.roles, GRADECHANGES.act)} />;
}

function Page({ canAct }: { canAct: boolean }) {
  const { submissionId = '' } = useParams(); const [h, setH] = useState<History | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setH(await api.get<History>(`/v1/grading/submissions/${submissionId}/history`)); if (clear) setError(null); } catch (e) { setError(e); } }, [submissionId]);
  useEffect(() => { setH(null); setDone(null); void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); return true; } catch (e) { setError(e); return false; } };
  if (!h) return <div><p><Link to="/staff/gradechanges">Back to grade changes</Link></p><ErrorNote error={error} />{!error && <Loading what="Loading the grade history" />}</div>;
  const cur = h.records[h.records.length - 1]; const state = h.grade?.state ?? ''; const block = proposeBlock(state); const open = h.overrides.some((o) => o.status === 'PENDING');
  return (
    <div>
      <p><Link to="/staff/gradechanges">Back to grade changes</Link></p>
      <h1>{h.submission.learnerName ?? 'A learner'}: {h.submission.topic ?? 'assignment'}</h1>
      <p><Badge tone="muted">{gradeState(state)}</Badge> <span className="muted">attempt {h.submission.attemptNo} · submitted {new Date(h.submission.submittedAt).toLocaleString()} · grade {pctText(h.grade?.finalPercent)} · pass mark {h.policy.passPercent}%</span></p>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      <Card title="Grade history"><p className="muted">Every grade this work has had, oldest first. Nothing is ever overwritten.</p>
        <ol>{h.records.map((r) => <li key={r.seq}><strong>{recordKind(r.kind)}</strong>: {pctText(r.finalPercent)}{r.latePenaltyPercent ? ` (after a ${r.latePenaltyPercent}% late penalty)` : ''}, {r.passed ? 'pass' : 'not a pass'} · {new Date(r.createdAt).toLocaleString()}{r.reason ? <><br /><span className="muted">Reason: {r.reason}</span></> : null}</li>)}</ol></Card>
      {h.overrides.length > 0 && <Card title="Overrides on this work"><ul>{h.overrides.map((o) => <li key={o.id}><Link to={`/staff/gradechanges/overrides/${o.id}`}>{o.reason}</Link> <Badge tone={overrideStatus(o.status).tone}>{overrideStatus(o.status).label}</Badge></li>)}</ul></Card>}
      {canAct && (block ? <p className="note">{block}</p> : <Propose h={h} open={open} onSend={(b) => act(() => api.post(`/v1/grading/submissions/${submissionId}/overrides`, b), 'Proposed. It changes nothing until a different administrator approves it.')} />)}
      {canAct && h.policy.unlockOn === 'MANUAL' && <Complete onGo={(r) => act(() => api.post(`/v1/grading/submissions/${submissionId}/complete`, { reason: r }), 'Marked as done: the assignment no longer holds the learner back.')} />}
      {cur && <p className="muted">Content fingerprint: {h.submission.contentHash?.slice(0, 16) ?? 'n/a'}…</p>}
    </div>
  );
}

function Propose({ h, open, onSend }: { h: History; open: boolean; onSend: (b: object) => Promise<boolean> }) {
  const cur = h.records[h.records.length - 1]; const curDims = cur?.dimensions.map((d) => ({ id: d.id, score: d.score }));
  const [show, setShow] = useState(false); const [scores, setScores] = useState<Record<string, string>>(() => startingScores(h.policy, curDims)); const [feedback, setFeedback] = useState(''); const [reason, setReason] = useState(''); const [problems, setProblems] = useState<string[]>([]);
  if (!show) return <p><button onClick={() => setShow(true)}>Propose a change to this grade</button>{open && <span className="muted"> (another override is already waiting for approval)</span>}</p>;
  const est = previewPercent(h.policy, scores);
  return (
    <Card title="Propose a change">
      <form onSubmit={(e) => { e.preventDefault(); const p = validateProposal(h.policy, { scores, feedback, reason }, curDims); setProblems(p); if (p.length) return; void onSend({ dimensions: h.policy.dimensions.map((d) => ({ id: d.id, score: Number(scores[d.id]) })), ...(feedback.trim() && { feedback: feedback.trim() }), reason: reason.trim() }).then((ok) => { if (ok) { setShow(false); setReason(''); setFeedback(''); } }); }} noValidate>
        <p className="muted">Set the score for every criterion, in half-point steps. Starting from the current grade.</p>
        {h.policy.dimensions.map((d) => <div key={d.id} className="choices"><label htmlFor={`ps-${d.id}`}>{d.name} (weight {d.weight}%, {d.min} to {d.max})</label><input id={`ps-${d.id}`} inputMode="decimal" value={scores[d.id] ?? ''} onChange={(e) => { setScores({ ...scores, [d.id]: e.target.value }); setProblems([]); }} style={{ width: '5rem' }} /></div>)}
        <p aria-live="polite">Before any late penalty this works out to about <strong>{pctText(est)}</strong>; the server works out the real grade.</p>
        <label htmlFor="ps-fb">New feedback for the learner (optional)</label><textarea id="ps-fb" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <label htmlFor="ps-why">Reason for the change (recorded in the audit trail and shown to the person who approves it)</label><textarea id="ps-why" value={reason} onChange={(e) => { setReason(e.target.value); setProblems([]); }} />
        {problems.length > 0 && <div role="alert" className="note error"><p>Please fix:</p><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        <div className="choices"><button>Send for approval</button><button type="button" className="link" onClick={() => setShow(false)}>Cancel</button></div>
      </form>
    </Card>
  );
}

function Complete({ onGo }: { onGo: (r: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [r, setR] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card title="Mark the assignment as done"><p className="muted">This assignment only counts as done when a person says so. Use it when the learner has met the requirement outside the platform.</p>
      {!open ? <button onClick={() => setOpen(true)}>Mark as done…</button> : <form onSubmit={(e) => { e.preventDefault(); if (!r.trim()) { setProblem('Write the reason: it is recorded in the audit trail.'); return; } void onGo(r.trim()).then((ok) => ok && setOpen(false)); }} noValidate>
        <label htmlFor="mc-why">Reason</label><textarea id="mc-why" value={r} onChange={(e) => { setR(e.target.value); setProblem(null); }} />{problem && <p role="alert" className="note error">{problem}</p>}<div className="choices"><button>Mark as done</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div></form>}
    </Card>
  );
}
