import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ExamIndexRow, ReleaseOutcome } from '../api/types';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { modeLabel, releaseMessage, skipReason } from '../lib/examops';

/** Every exam with its sessions and how many results are waiting at each step. Releasers can release a whole session's ready results at once. */
export default function ExamList({ canRelease, canSweep, canCase }: { canRelease: boolean; canSweep: boolean; canCase: boolean }) {
  const [rows, setRows] = useState<ExamIndexRow[] | null>(null); const [error, setError] = useState<unknown>(null);
  const [out, setOut] = useState<{ session: string; o: ReleaseOutcome } | null>(null); const [busy, setBusy] = useState<string | null>(null); const [sweepMsg, setSweepMsg] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setRows(await api.get<ExamIndexRow[]>('/v1/exam-ops/exams')); if (clear) setError(null); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  const release = async (sessionId: string, ready: number) => {
    if (!window.confirm(`Release ${ready} ready result${ready === 1 ? '' : 's'} to the learners? Learners are told straight away.`)) return;
    setBusy(sessionId); setError(null); setOut(null);
    try { setOut({ session: sessionId, o: await api.post<ReleaseOutcome>(`/v1/exam-ops/sessions/${sessionId}/release-ready`) }); await load(false); } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const sweep = async () => { setBusy('sweep'); setError(null); setSweepMsg(null); try { const r = await api.post<{ autoSubmitted: number; reportsPolled: number }>('/v1/exam-ops/sweep'); setSweepMsg(`Submitted ${r.autoSubmitted} overdue attempt${r.autoSubmitted === 1 ? '' : 's'} and asked the proctoring provider for ${r.reportsPolled} missing report${r.reportsPolled === 1 ? '' : 's'}.`); await load(false); } catch (e) { setError(e); } finally { setBusy(null); } };
  return (
    <>
      <ErrorNote error={error} />
      {canSweep && <p><button onClick={() => void sweep()} disabled={busy === 'sweep'}>{busy === 'sweep' ? 'Checking…' : 'Submit overdue attempts and fetch missing proctor reports'}</button> <span className="muted">The worker also does this every few minutes.</span></p>}
      {sweepMsg && <p role="status" className="note">{sweepMsg}</p>}
      {!rows ? (!error && <Loading what="Loading exams" />) : !rows.length ? <Card><p>No exams yet.</p></Card> : rows.map((e) => (
        <Card key={e.id} title={<>{e.title} <span className="muted">({e.code})</span></>} actions={<Badge tone={e.status === 'PUBLISHED' ? 'ok' : 'muted'}>{e.status.toLowerCase()}</Badge>}>
          <p className="muted">{e.durationMin} minutes · pass mark {e.passPercent}% · <Link to={`/staff/examops/exams/${e.id}/report`}>Results report</Link></p>
          {!e.sessions.length ? <p className="muted">No sessions scheduled.</p> : (
            <table><thead><tr><th>Session</th><th>Attempts</th><th>In progress</th><th>Held</th><th>Ready</th><th>Released</th><th>Invalidated</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{e.sessions.map((s) => (
              <tr key={s.id}><td>{new Date(s.startsAt).toLocaleString()}<br /><span className="muted">{modeLabel(s.mode)}{s.centre ? `, ${s.centre}` : ''}{s.status === 'CANCELLED' ? ' · cancelled' : ''}</span></td><td>{s.attempts.total}</td><td>{s.attempts.inProgress}</td><td>{s.attempts.held}</td><td><strong>{s.attempts.ready}</strong></td><td>{s.attempts.released}</td><td>{s.attempts.invalidated}</td>
                <td>{canRelease && s.attempts.ready > 0 && <button disabled={busy === s.id} onClick={() => void release(s.id, s.attempts.ready)}>{busy === s.id ? 'Releasing…' : `Release ${s.attempts.ready} ready`}</button>}</td></tr>))}</tbody></table>)}
          {out && e.sessions.some((s) => s.id === out.session) && (
            <div role="status" className="note"><p>{releaseMessage(out.o)}</p>{out.o.skipped.length > 0 && <ul>{out.o.skipped.map((k) => <li key={k.attemptId}>{canCase ? <Link to={`/staff/examops/attempts/${k.attemptId}`}>Attempt {k.attemptId.slice(0, 8)}</Link> : `Attempt ${k.attemptId.slice(0, 8)}`}: {skipReason(k.reason)}</li>)}</ul>}</div>)}
        </Card>))}
    </>
  );
}
