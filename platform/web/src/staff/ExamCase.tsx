import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, messageFor } from '../api/client';
import type { ExamCaseFile, LogCheck } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { evidenceMessage, INCIDENT_DECISIONS, isOpenIncident, nextStep, reasonError, resultStateLabel, SEVERITIES, severityTone, statusLabel, typeLabel } from '../lib/examops';
import { EXAMOPS, hasAny } from '../lib/roles';

export default function ExamCase() {
  const { me } = useAuth();
  if (hasAny(me?.roles, EXAMOPS.caseView)) return <Case roles={me!.roles} />;
  if (hasAny(me?.roles, EXAMOPS.release)) return <ReleaseOnly />; // may release but may not read the case file (the server refuses it)
  return <Navigate to="/staff/examops" replace />; // checked before anything is fetched
}

/** For a releaser who is not an adjudicator: the state of the result and the release button, without the integrity case file. */
function ReleaseOnly() {
  const { attemptId = '' } = useParams();
  const [r, setR] = useState<{ resultState: string; outcome: string | null } | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState(false);
  const load = useCallback(async (clear = true) => { try { setR(await api.get(`/v1/exam-ops/attempts/${attemptId}/result`)); if (clear) setError(null); } catch (e) { setError(e); } }, [attemptId]);
  useEffect(() => { void load(); }, [load]);
  const release = async () => { setError(null); try { await api.post(`/v1/exam-ops/attempts/${attemptId}/release`); setDone(true); await load(false); return true; } catch (e) { setError(e); await load(false); return false; } };
  return (
    <div>
      <p><Link to="/staff/examops">Back to the queue</Link></p><h1>Release a result</h1>
      <ErrorNote error={error} />{done && <p role="status" className="note">Result released to the learner.</p>}
      {!r ? (!error && <Loading />) : <Card title="Where this stands" actions={<Badge tone={r.resultState === 'READY' ? 'ok' : 'muted'}>{resultStateLabel(r.resultState)}</Badge>}><p>Your role releases results; it does not review integrity evidence.{r.outcome ? ` Outcome: ${r.outcome.toLowerCase()}.` : ''}</p><Release state={r.resultState} onRelease={release} /></Card>}
    </div>
  );
}

function Case({ roles }: { roles: string[] }) {
  const { attemptId = '' } = useParams(); const can = (l: readonly string[]) => hasAny(roles, l);
  const [c, setC] = useState<ExamCaseFile | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setC(await api.get<ExamCaseFile>(`/v1/exam-ops/attempts/${attemptId}/case`)); if (clear) setError(null); } catch (e) { setError(e); } }, [attemptId]);
  useEffect(() => { setC(null); void load(); }, [load]);
  /** Runs one action, then refreshes the case but keeps the error on screen (a refusal's reason is what the person needs to read). */
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); setDone(null); try { await fn(); setDone(ok); await load(false); return true; } catch (e) { setError(e); await load(false); return false; } };
  if (!c) return <div><p><Link to="/staff/examops">Back to the queue</Link></p><h1>Exam case</h1><ErrorNote error={error} />{!error && <Loading what="Loading the case" />}</div>;
  const open = c.incidents.filter((i) => isOpenIncident(i.status)).length;
  return (
    <div>
      <p><Link to="/staff/examops">Back to the queue</Link></p>
      <h1>Case {c.learnerRef}</h1>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      <Card title="Where this stands" actions={<Badge tone={c.resultState === 'READY' ? 'ok' : 'muted'}>{resultStateLabel(c.resultState)}</Badge>}>
        <p>{nextStep(c)}</p>
        <ul>
          <li>Attempt {c.attemptNo}, {c.mode === 'REMOTE' ? 'remote' : 'at a centre'}{c.autoSubmitted ? ', submitted automatically at the deadline' : ''}.</li>
          <li>Window or session switches: {c.sessionSwitches}. Outcome: {c.outcome ? c.outcome.toLowerCase() : 'not set'}. Proctor report: {c.proctorReportFinal ? 'final' : 'not final'}.</li>
          {!!c.accommodations.length && <li>Accommodations: {c.accommodations.map((a) => `${typeLabel(a.type.toLowerCase())}${a.extraTimePercent ? ` (+${a.extraTimePercent}% time)` : ''}`).join(', ')}.</li>}
        </ul>
        <LogVerify key={c.timeline.length} attemptId={attemptId} />
      </Card>
      <Card title={`Incidents (${c.incidents.length})`}>
        {!c.incidents.length ? <p>No incidents were raised.</p> : <ul className="plain">{c.incidents.map((i) => <li key={i.id}><IncidentItem i={i} canDecide={can(EXAMOPS.adjudicate)} canEvidence={can(EXAMOPS.evidence)} onDecide={(d, r) => act(() => api.post(`/v1/exam-ops/incidents/${i.id}/decide`, { decision: d, reason: r }), 'Decision recorded.')} /></li>)}</ul>}
        {can(EXAMOPS.proctor) && <ManualIncident onSave={(t, s, n) => act(() => api.post(`/v1/proctor/attempts/${attemptId}/incidents`, { type: t, severity: s, detail: { note: n } }), 'Incident recorded. You cannot decide it yourself: another adjudicator must.')} />}
      </Card>
      {c.status === 'SUBMITTED' && (
        <Card title="Outcome and release">
          {can(EXAMOPS.adjudicate) && <Outcome blocked={open > 0} onSet={(o, r) => act(() => api.post(`/v1/exam-ops/attempts/${attemptId}/outcome`, { outcome: o, reason: r }), o === 'INVALIDATED' ? 'Attempt invalidated. The learner has been told and may appeal.' : 'Marked valid.')} />}
          {can(EXAMOPS.release) && <Release state={c.resultState} onRelease={() => act(() => api.post(`/v1/exam-ops/attempts/${attemptId}/release`), 'Result released to the learner.')} />}
          {can(EXAMOPS.proctor) && !c.proctorReportFinal && <Waive onWaive={(r) => act(() => api.post(`/v1/exam-ops/attempts/${attemptId}/waive-report`, { reason: r }), 'Proctor report waived.')} />}
        </Card>)}
      {can(EXAMOPS.proctor) && c.mode === 'CENTRE' && <Card title="Check ID at the centre"><VerifyId onSave={(s, n) => act(() => api.post(`/v1/proctor/attempts/${attemptId}/verify-id`, { status: s, note: n }), 'Identity check recorded.')} /></Card>}
      <Card title="Timeline"><p className="muted">The exam's tamper-evident log. Answers are not shown, only that the learner saved.</p>
        <table><thead><tr><th>#</th><th>When</th><th>What</th><th>Detail</th></tr></thead><tbody>{c.timeline.map((e) => <tr key={e.seq}><td>{e.seq}</td><td>{new Date(e.at).toLocaleTimeString()}</td><td>{typeLabel(e.type.toLowerCase())}</td><td className="muted">{Object.keys(e.payload ?? {}).length ? Object.entries(e.payload).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ') : ''}</td></tr>)}</tbody></table></Card>
    </div>
  );
}

function LogVerify({ attemptId }: { attemptId: string }) {
  const [r, setR] = useState<LogCheck | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setError(null); try { setR(await api.get<LogCheck>(`/v1/exam-ops/attempts/${attemptId}/verify-log`)); } catch (e) { setError(e); } finally { setBusy(false); } };
  return <div><button onClick={() => void run()} disabled={busy}>{busy ? 'Checking…' : 'Check the log has not been altered'}</button><ErrorNote error={error} />
    {r && <p role="status">{r.intact ? <Badge tone="ok">Intact</Badge> : <Badge tone="warn">TAMPERED</Badge>} {r.events} events checked{r.intact ? '.' : `; the chain breaks at event ${r.firstBrokenIndex}. Tell the platform administrator before deciding anything.`}</p>}</div>;
}

function IncidentItem({ i, canDecide, canEvidence, onDecide }: { i: ExamCaseFile['incidents'][number]; canDecide: boolean; canEvidence: boolean; onDecide: (d: string, r: string) => Promise<boolean> }) {
  const [decision, setDecision] = useState('DISMISSED'); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [show, setShow] = useState(false);
  const [ev, setEv] = useState<{ url: string; expiresAt: string | null } | null>(null); const [evMsg, setEvMsg] = useState<string | null>(null);
  const getEvidence = async () => { setEvMsg(null); try { setEv(await api.get(`/v1/incidents/${i.id}/evidence`)); } catch (e) { setEv(null); setEvMsg(evidenceMessage(e) ?? messageFor(e)); } };
  const submit = async () => { const p = reasonError(reason); setProblem(p); if (p) return; setBusy(true); const ok = await onDecide(decision, reason.trim()); setBusy(false); if (ok) { setShow(false); setReason(''); } };
  return (
    <div className="subcard">
      <p><strong>{typeLabel(i.type)}</strong> <Badge tone={severityTone(i.severity)}>{i.severity}</Badge> <Badge tone="muted">{statusLabel(i.status)}</Badge></p>
      <p className="muted">{i.source === 'PROVIDER' ? 'Provider' : 'Proctor'} · {new Date(i.occurredAt).toLocaleString()}{i.decisionReason ? ` · Decision: ${i.decisionReason}` : ''}</p>
      {i.hasEvidence && canEvidence && <p><button className="link" onClick={() => void getEvidence()}>View the evidence</button> <span className="muted">(each view is logged)</span>{ev && <> · <a href={ev.url} target="_blank" rel="noopener noreferrer">Open the evidence</a>{ev.expiresAt && <span className="muted"> (link works until {new Date(ev.expiresAt).toLocaleString()})</span>}</>}{evMsg && <span role="alert" className="note error">{evMsg}</span>}</p>}
      {canDecide && !show && <button onClick={() => setShow(true)}>{isOpenIncident(i.status) ? 'Decide' : 'Change the decision'}</button>}
      {show && (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <label htmlFor={`dec-${i.id}`}>Decision</label><select id={`dec-${i.id}`} value={decision} onChange={(e) => setDecision(e.target.value)}>{INCIDENT_DECISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <label htmlFor={`why-${i.id}`}>Reason (recorded in the audit trail)</label><textarea id={`why-${i.id}`} value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} />
          {problem && <p role="alert" className="note error">{problem}</p>}
          <div className="choices"><button disabled={busy}>{busy ? 'Saving…' : 'Record decision'}</button><button type="button" className="link" onClick={() => setShow(false)}>Cancel</button></div>
        </form>)}
    </div>
  );
}

function ManualIncident({ onSave }: { onSave: (type: string, severity: string, note: string) => Promise<boolean> }) {
  const [show, setShow] = useState(false); const [type, setType] = useState(''); const [sev, setSev] = useState('MEDIUM'); const [note, setNote] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  if (!show) return <p><button onClick={() => setShow(true)}>Record an incident</button></p>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!type.trim()) { setProblem('Say what happened (for example "phone seen").'); return; } void onSave(type.trim().toLowerCase().replace(/\s+/g, '_'), sev, note.trim()).then((ok) => { if (ok) { setShow(false); setType(''); setNote(''); setProblem(null); } }); }} noValidate>
      <label htmlFor="mi-type">What happened</label><input id="mi-type" value={type} onChange={(e) => { setType(e.target.value); setProblem(null); }} />
      <label htmlFor="mi-sev">Severity</label><select id="mi-sev" value={sev} onChange={(e) => setSev(e.target.value)}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
      <label htmlFor="mi-note">Notes</label><textarea id="mi-note" value={note} onChange={(e) => setNote(e.target.value)} />
      {problem && <p role="alert" className="note error">{problem}</p>}
      <div className="choices"><button>Save incident</button><button type="button" className="link" onClick={() => setShow(false)}>Cancel</button></div>
    </form>
  );
}

function Outcome({ blocked, onSet }: { blocked: boolean; onSet: (o: string, r: string) => Promise<boolean> }) {
  const [o, setO] = useState('VALID'); const [r, setR] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  return (
    <form onSubmit={(e) => { e.preventDefault(); const p = reasonError(r); setProblem(p); if (!p) void onSet(o, r.trim()).then((ok) => ok && setR('')); }} noValidate>
      <h3>Set the outcome</h3>{blocked && <p className="note">Decide every open incident first.</p>}
      <fieldset disabled={blocked}><legend>Outcome</legend>{([['VALID', 'Valid: the result stands'], ['INVALIDATED', 'Invalidated: the result is cancelled']] as const).map(([v, l]) => <label key={v} className="inline"><input type="radio" name="outcome" checked={o === v} onChange={() => setO(v)} /> {l}</label>)}
        <label htmlFor="oc-why">Reason (recorded in the audit trail)</label><textarea id="oc-why" value={r} onChange={(e) => { setR(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
        <button>Set outcome</button></fieldset>
    </form>
  );
}

function Release({ state, onRelease }: { state: string; onRelease: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return <div><h3>Release the result</h3>{state === 'READY' ? <button disabled={busy} onClick={() => { setBusy(true); void onRelease().finally(() => setBusy(false)); }}>{busy ? 'Releasing…' : 'Release to the learner'}</button> : <p className="muted">{state === 'RELEASED' ? 'This result has been released.' : `Not ready: ${resultStateLabel(state).toLowerCase()}. A result can be released only when it is ready.`}</p>}</div>;
}

function Waive({ onWaive }: { onWaive: (r: string) => Promise<boolean> }) {
  const [r, setR] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  return (
    <form onSubmit={(e) => { e.preventDefault(); const p = reasonError(r); setProblem(p); if (!p) void onWaive(r.trim()); }} noValidate>
      <h3>Waive the proctor report</h3><p className="muted">Use only if the provider's final report will never arrive. Without it, a remote result stays held.</p>
      <label htmlFor="wv-why">Reason (recorded in the audit trail)</label><textarea id="wv-why" value={r} onChange={(e) => { setR(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
      <button>Waive the report</button>
    </form>
  );
}

function VerifyId({ onSave }: { onSave: (s: string, n: string) => Promise<boolean> }) {
  const [s, setS] = useState('VERIFIED'); const [n, setN] = useState(''); const [problem, setProblem] = useState<string | null>(null);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!n.trim()) { setProblem('Write a note (for example which document you checked).'); return; } void onSave(s, n.trim()); }} noValidate>
      <fieldset><legend>Identity</legend>{([['VERIFIED', 'The ID matches the learner'], ['FAILED', 'The ID does not match']] as const).map(([v, l]) => <label key={v} className="inline"><input type="radio" name="idv" checked={s === v} onChange={() => setS(v)} /> {l}</label>)}</fieldset>
      <label htmlFor="id-note">Note</label><input id="id-note" value={n} onChange={(e) => { setN(e.target.value); setProblem(null); }} />{problem && <p role="alert" className="note error">{problem}</p>}
      <button>Record the check</button>
    </form>
  );
}
