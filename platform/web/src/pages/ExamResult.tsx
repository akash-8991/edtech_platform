import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ExamResult } from '../api/types';
import { Badge, Card, ErrorNote, Loading, Progress } from '../components/ui';

export default function ExamResultPage() {
  const { attemptId = '' } = useParams(); const [r, setR] = useState<ExamResult | null>(null); const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [appealed, setAppealed] = useState(false);
  useEffect(() => { api.get<ExamResult>(`/v1/me/exam-attempts/${attemptId}`).then(setR).catch(setError); }, [attemptId]);
  const appeal = async () => { setBusy(true); setError(null); try { await api.post(`/v1/me/exam-attempts/${attemptId}/appeal`, { reason: reason.trim() }); setAppealed(true); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (!r) return error ? <ErrorNote error={error} /> : <Loading what="Loading your result" />;
  return (
    <div>
      <p><Link to="/exams">All exams</Link></p><h1>Exam result</h1>
      {r.receiptCode && <p className="muted">Receipt code: <span className="mono">{r.receiptCode}</span></p>}
      {r.state === 'RELEASED' && (
        <Card title={r.passed ? 'You passed' : 'You did not pass'} actions={<Badge tone={r.passed ? 'ok' : 'warn'}>{Math.round(r.percent ?? 0)}%</Badge>}>
          <Progress value={Math.round(r.percent ?? 0)} label="Score" /><p>Your score is {Math.round(r.percent ?? 0)}%. The pass mark is {r.passMark}%.</p>
          {r.sections && <><h3>By section</h3><ul className="plain">{Object.entries(r.sections).map(([k, v]) => <li key={k} className="row"><span>{k}</span><span>{v.percent}%</span></li>)}</ul></>}
        </Card>)}
      {(r.state === 'UNDER_REVIEW' || r.state === 'AWAITING_RELEASE') && <Card title="Result pending"><p role="status">{r.message}</p><p className="muted">You will be notified when it is released. You do not need to do anything.</p></Card>}
      {r.state === 'INVALIDATED' && (
        <Card title="Attempt invalidated" actions={<Badge tone="warn">Integrity review</Badge>}>
          <p role="status">{r.message}</p>{r.reason && <p>Reason: {r.reason}</p>}
          {appealed ? <p className="note ok" role="status">Your appeal has been submitted. A reviewer who was not involved will look at it.</p> : r.appeal?.eligible ? (
            <form onSubmit={(e) => { e.preventDefault(); void appeal(); }}>
              <label htmlFor="ap">Why do you believe this is wrong? (at least 20 characters)</label><textarea id="ap" rows={5} value={reason} onChange={(e) => setReason(e.target.value)} />
              <ErrorNote error={error} /><button type="submit" disabled={busy || reason.trim().length < 20}>Submit appeal</button></form>) : <p className="muted">An appeal has already been filed or the appeal window has closed.</p>}
        </Card>)}
      {!r.state && <Card><p>This attempt has not been submitted (status: {r.status.toLowerCase()}). <Link to={`/exam-attempts/${attemptId}`}>Open it</Link>.</p></Card>}
    </div>
  );
}
