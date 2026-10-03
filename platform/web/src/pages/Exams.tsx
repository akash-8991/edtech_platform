import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, messageFor } from '../api/client';
import type { ExamInfo, ExamSessionInfo } from '../api/types';
import { Badge, Card, ErrorNote, Hold } from '../components/ui';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function Exams() {
  const [exams, setExams] = useState<ExamInfo[] | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api.get<ExamInfo[]>('/v1/me/exams').then(setExams).catch(setError), []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => { setBusy(id); setError(null); try { await fn(); await load(); } catch (e) { setError(e); } finally { setBusy(null); } };
  if (!exams) return <Hold title="Exams" error={error} what="Loading your exams" />;
  return (
    <div>
      <h1>Exams</h1>
      <ErrorNote error={error} />
      {!exams.length && <Card><p>No exams are available for your courses yet.</p></Card>}
      {exams.map((e) => {
        const open = e.attempts.find((a) => a.status === 'IN_PROGRESS');
        const checkedIn = e.attempts.find((a) => a.status === 'CHECKED_IN' || a.status === 'READY');
        return (
          <Card key={e.examId} title={e.title} actions={<Badge tone={e.eligibility.eligible ? 'ok' : 'warn'}>{e.eligibility.eligible ? 'Eligible' : 'Not yet eligible'}</Badge>}>
            <p className="muted">{e.durationMin} minutes · pass mark {e.passPercent}% · {e.mode === 'CENTRE' ? 'at a test centre' : 'online, proctored'}{e.eligibility.overridden ? ' · eligibility granted by an administrator' : ''}</p>
            <details open={!e.eligibility.eligible}><summary>Eligibility checklist</summary>
              <ul className="steps" aria-label="Eligibility checks">{e.eligibility.checks.map((c) => <li key={c.key} className={c.ok ? 'done' : ''}><span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> <span className="sr-only">{c.ok ? 'Met: ' : 'Not met: '}</span>{c.detail ?? c.key.replace(/_/g, ' ')}</li>)}</ul></details>

            {open && <p className="note warn" role="status">You have an exam in progress. <Link to={`/exam-attempts/${open.id}`}>Return to it now</Link>: the clock is still running.</p>}
            {checkedIn && !open && <p className="note ok">You are checked in. <Link to={`/exams/${e.examId}/check-in/${findSession(e, checkedIn.id)?.id ?? ''}`}>Continue check-in</Link>.</p>}

            <h3>Sessions</h3>
            {!e.sessions.length ? <p className="muted">No sessions are scheduled yet.</p> : (
              <ul className="plain">{e.sessions.map((s) => (
                <li key={s.id} className="row session"><span>{when(s.startsAt)} to {when(s.endsAt)} {s.centre ? `· ${s.centre}` : ''}</span>
                  {s.registered ? <span className="row"><Badge tone="ok">Registered</Badge>
                      <Link to={`/exams/${e.examId}/check-in/${s.id}`}>Check in</Link>
                      <button className="link" disabled={busy === s.id} onClick={() => void act(s.id, () => api.post(`/v1/exam-sessions/${s.id}/unregister`))}>Cancel registration</button></span>
                    : <button disabled={!e.eligibility.eligible || busy === s.id} onClick={() => void act(s.id, () => api.post(`/v1/exams/${e.examId}/register`, { sessionId: s.id }))}>Register</button>}
                </li>))}</ul>)}

            {!!e.attempts.length && (<><h3>Your attempts</h3><ul className="plain">{e.attempts.map((a) => (
              <li key={a.id} className="row"><span>Attempt {a.attemptNo}: {a.status.toLowerCase().replace('_', ' ')}</span>
                {a.status === 'SUBMITTED' && <Link to={`/exam-results/${a.id}`}>{a.result === 'RELEASED' ? 'View result' : 'View status'}</Link>}
                {a.status === 'IN_PROGRESS' && <Link to={`/exam-attempts/${a.id}`}>Resume</Link>}</li>))}</ul></>)}
          </Card>);
      })}
      <p className="muted"><Link to="/completion">See your overall programme completion</Link></p>
    </div>
  );
}
const findSession = (e: ExamInfo, _attemptId: string): ExamSessionInfo | undefined => e.sessions.find((s) => s.registered);
export { messageFor };
