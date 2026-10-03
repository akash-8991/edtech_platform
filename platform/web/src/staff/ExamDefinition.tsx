import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { ExamDetail, ExamIndexRow, OverrideRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { eligibilityLines, lineText, localToIso, modeLabel, publishBlock, reasonError, statusLabel, validateSession, type SessionForm } from '../lib/examsetup';
import { canSee, EXAMSETUP, hasAny } from '../lib/roles';
import { LearnerPicker, type PickedLearner } from './LearnerPicker';

export default function ExamDefinition() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'examsetup')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Page meId={me!.id} roles={me!.roles} />;
}

function Page({ meId, roles }: { meId: string; roles: string[] }) {
  const { examId = '' } = useParams(); const can = (l: readonly string[]) => hasAny(roles, l);
  const [e, setE] = useState<ExamDetail | null>(null); const [sessions, setSessions] = useState<ExamIndexRow['sessions']>([]); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null); const [issues, setIssues] = useState<string[] | null>(null);
  const load = useCallback(async (clear = true) => { try { const [d, all] = await Promise.all([api.get<ExamDetail>(`/v1/exam-ops/exams/${examId}`), api.get<ExamIndexRow[]>('/v1/exam-ops/exams')]); setE(d); setSessions(all.find((x) => x.id === examId)?.sessions ?? []); if (clear) setError(null); } catch (er) { setError(er); } }, [examId]);
  useEffect(() => { setE(null); setDone(null); void load(); }, [load]);
  /** Runs an action, then refreshes but keeps a refusal on screen (what the server says is what the person must read). */
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); setIssues(null); try { await fn(); setDone(ok); await load(false); return true; } catch (er) { if (er instanceof ApiError && Array.isArray(er.body?.issues)) setIssues(er.body.issues); else setError(er); await load(false); return false; } };
  if (!e) return <div><p><Link to="/staff/examsetup">Back to exam set-up</Link></p><ErrorNote error={error} />{!error && <Loading what="Loading the exam" />}</div>;
  const block = publishBlock(e, meId);
  return (
    <div>
      <p><Link to="/staff/examsetup">Back to exam set-up</Link></p>
      <h1>{e.title} <span className="muted">({e.code})</span></h1>
      <p><Badge tone={e.status === 'PUBLISHED' ? 'ok' : 'warn'}>{statusLabel(e.status)}</Badge> <span className="muted">{e.programme.title}, version {e.programme.version} · defined by {e.createdByName ?? 'staff'}{e.approvedByName ? ` · published by ${e.approvedByName}` : ''}</span></p>
      {e.changeFrozen && <p role="alert" className="note error">Exam changes are frozen right now.</p>}
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      {issues && <div role="alert" className="note error"><p>It cannot be published yet:</p><ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul></div>}
      <Card title="The exam"><ul><li>{e.durationMin} minutes, pass mark {e.passPercent}%, {e.maxAttempts} attempt{e.maxAttempts === 1 ? '' : 's'} with {e.cooldownDays} day{e.cooldownDays === 1 ? '' : 's'} between{e.shuffle ? ', answer options shuffled' : ''}</li><li>{modeLabel(e.proctoring.mode)}{e.proctoring.requireId ? ', photo ID checked' : ''}; device needs {[e.proctoring.device.camera && 'a camera', e.proctoring.device.microphone && 'a microphone', e.proctoring.device.singleScreen && 'a single screen'].filter(Boolean).join(', ') || 'nothing special'}</li></ul>
        <h3>Who may sit it</h3><ul>{eligibilityLines(e.eligibility).map((l) => <li key={l}>{l}</li>)}</ul></Card>
      <Card title="What is in the paper"><ul>{e.blueprint.map((l, i) => <li key={i}>{lineText(l)}</li>)}</ul>
        {e.blueprintCheck.errors.map((x) => <p key={x} className="note error">{x}</p>)}{e.blueprintCheck.warnings.map((x) => <p key={x} className="note">{x}</p>)}{!e.blueprintCheck.errors.length && !e.blueprintCheck.warnings.length && <p><Badge tone="ok">The question bank covers every section.</Badge></p>}</Card>
      {e.status === 'DRAFT' && can(EXAMSETUP.publish) && (
        <Card title="Publish"><p className="muted">Publishing makes the exam available for sittings. A different administrator from the one who defined it must do this, after checking it.</p>
          {block && <p className="note">{block}</p>}
          <button disabled={!!block} onClick={() => { if (window.confirm('Publish this exam? It cannot be edited afterwards.')) void act(() => api.post(`/v1/exams/${e.id}/publish`), 'Published. You can now schedule sittings.'); }}>Publish</button></Card>)}
      {e.status === 'PUBLISHED' && <Sittings e={e} sessions={sessions} canSchedule={can(EXAMSETUP.author) && !e.changeFrozen} onCreate={(b) => act(() => api.post(`/v1/exams/${e.id}/sessions`, b), 'Sitting scheduled. Learners who are eligible can now register.')} />}
      {can(EXAMSETUP.override) || hasAny(roles, ['AUDITOR']) ? <Overrides examId={e.id} canGrant={can(EXAMSETUP.override)} /> : null}
    </div>
  );
}

function Sittings({ e, sessions, canSchedule, onCreate }: { e: ExamDetail; sessions: ExamIndexRow['sessions']; canSchedule: boolean; onCreate: (b: object) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [f, setF] = useState<SessionForm>({ startsAt: '', endsAt: '', centre: '', capacity: '100' }); const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card title="Sittings">
      {!sessions.length ? <p>None scheduled.</p> : <table><thead><tr><th>Window</th><th>Where</th><th>Places</th><th>Registered or sat</th></tr></thead><tbody>{sessions.map((s) => <tr key={s.id}><td>{new Date(s.startsAt).toLocaleString()} to {new Date(s.endsAt).toLocaleString()}</td><td>{modeLabel(s.mode)}{s.centre ? `, ${s.centre}` : ''}{s.status === 'CANCELLED' ? ' (cancelled)' : ''}</td><td>{s.capacity}</td><td>{s.attempts.total}</td></tr>)}</tbody></table>}
      {canSchedule && (!open ? <p><button onClick={() => setOpen(true)}>Schedule a sitting</button></p> : (
        <form onSubmit={(ev) => { ev.preventDefault(); const p = validateSession(f, e.durationMin, e.proctoring.mode); setProblem(p); if (p) return; void onCreate({ startsAt: localToIso(f.startsAt), endsAt: localToIso(f.endsAt), mode: e.proctoring.mode, ...(e.proctoring.mode === 'CENTRE' && { centre: f.centre.trim() }), capacity: Number(f.capacity) }).then((ok) => { if (ok) { setOpen(false); setF({ startsAt: '', endsAt: '', centre: '', capacity: '100' }); } }); }} noValidate>
          <p className="muted">This exam is sat {modeLabel(e.proctoring.mode).toLowerCase()}. The window must be at least {e.durationMin} minutes long so that everyone who starts at the very end can finish.</p>
          <label htmlFor="ss-s">Window opens</label><input id="ss-s" type="datetime-local" value={f.startsAt} onChange={(ev) => { setF({ ...f, startsAt: ev.target.value }); setProblem(null); }} style={{ width: 'auto' }} />
          <label htmlFor="ss-e">Window closes</label><input id="ss-e" type="datetime-local" value={f.endsAt} onChange={(ev) => { setF({ ...f, endsAt: ev.target.value }); setProblem(null); }} style={{ width: 'auto' }} />
          {e.proctoring.mode === 'CENTRE' && <><label htmlFor="ss-c">Centre</label><input id="ss-c" value={f.centre} onChange={(ev) => { setF({ ...f, centre: ev.target.value }); setProblem(null); }} /></>}
          <label htmlFor="ss-n">Places</label><input id="ss-n" inputMode="numeric" value={f.capacity} onChange={(ev) => { setF({ ...f, capacity: ev.target.value }); setProblem(null); }} style={{ width: '7rem' }} />
          {problem && <p role="alert" className="note error">{problem}</p>}<div className="choices"><button>Schedule</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>))}
    </Card>
  );
}

function Overrides({ examId, canGrant }: { examId: string; canGrant: boolean }) {
  const [rows, setRows] = useState<OverrideRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [who, setWho] = useState<PickedLearner | null>(null); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async () => { try { setRows(await api.get<OverrideRow[]>(`/v1/exams/${examId}/eligibility-overrides`)); } catch (e) { setError(e); } }, [examId]);
  useEffect(() => { void load(); }, [load]);
  const grant = async () => { const p = !who ? 'Choose the learner.' : reasonError(reason); setProblem(p); if (p) return; setError(null); setDone(null); try { await api.post(`/v1/exams/${examId}/eligibility-overrides`, { learnerId: who!.id, reason: reason.trim() }); setDone('Exception granted.'); setWho(null); setReason(''); await load(); } catch (e) { setError(e); } };
  return (
    <Card title="Exceptions to who may sit it">
      <p className="muted">An exception lets one learner sit this exam without meeting the academic requirements (completion, labs, assignments). It never overrides a lapsed entitlement or an open integrity case.</p>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      {!rows ? (!error && <Loading />) : !rows.length ? <p>None granted.</p> : <ul className="plain">{rows.map((o) => <li key={o.id} className="subcard"><strong>{o.learnerName ?? 'Unknown'}</strong> <span className="muted">{o.learnerEmail} · granted by {o.approvedByName ?? 'staff'} on {new Date(o.createdAt).toLocaleDateString()} · {o.reason}</span></li>)}</ul>}
      {canGrant && <form onSubmit={(ev) => { ev.preventDefault(); void grant(); }} noValidate className="subcard"><h3>Grant an exception</h3><LearnerPicker value={who} onChange={(l) => { setWho(l); setProblem(null); }} idPrefix="ov" />
        <label htmlFor="ov-r">Reason (recorded in the audit trail)</label><textarea id="ov-r" value={reason} onChange={(ev) => { setReason(ev.target.value); setProblem(null); }} />{problem && <p role="alert" className="note error">{problem}</p>}<button>Grant the exception</button></form>}
    </Card>
  );
}
