import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AppealRow, IncidentRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { ageText } from '../lib/moderation';
import { reasonError, severityTone, statusLabel, typeLabel } from '../lib/examops';
import { AREAS, canSee, EXAMOPS, hasAny } from '../lib/roles';

type View = 'INCIDENTS' | 'DECIDED' | 'APPEALS';

export default function ExamOps() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'examops')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Inner canCase={hasAny(me?.roles, [...EXAMOPS.caseView, ...EXAMOPS.release])} canDecideAppeal={hasAny(me?.roles, AREAS.examops.act)} />;
}

function Inner({ canCase, canDecideAppeal }: { canCase: boolean; canDecideAppeal: boolean }) {
  const [view, setView] = useState<View>('INCIDENTS'); const [severity, setSeverity] = useState('');
  return (
    <div>
      <h1>Exam integrity</h1>
      <p className="muted">Learners are shown only a short reference here, and you never see a score while deciding an incident: integrity is judged blind to performance.</p>
      <div className="tabs" role="group" aria-label="Queue">{([['INCIDENTS', 'Open incidents'], ['DECIDED', 'Decided incidents'], ['APPEALS', 'Appeals']] as [View, string][]).map(([k, l]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}</div>
      {view !== 'APPEALS' && <><label htmlFor="eo-sev" className="inline">Severity</label> <select id="eo-sev" value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ width: 'auto' }}>{['', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => <option key={s} value={s}>{s || 'All'}</option>)}</select></>}
      {view === 'APPEALS' ? <Appeals canCase={canCase} canDecide={canDecideAppeal} /> : <Incidents key={view} decided={view === 'DECIDED'} severity={severity} canCase={canCase} />}
    </div>
  );
}

function Incidents({ decided, severity, canCase }: { decided: boolean; severity: string; canCase: boolean }) {
  const [rows, setRows] = useState<IncidentRow[] | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { setRows(null); const q = new URLSearchParams({ status: decided ? 'DISMISSED,CONFIRMED_MINOR,CONFIRMED_MAJOR' : 'OPEN,NEEDS_INFO' }); if (severity) q.set('severity', severity); api.get<IncidentRow[]>(`/v1/exam-ops/incidents?${q}`).then((r) => { setRows(r); setError(null); }).catch(setError); }, [decided, severity]);
  return (
    <>
      <ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading incidents" />) : !rows.length ? <Card><p>{decided ? 'No decided incidents match.' : 'No open incidents. Well done.'}</p></Card> : (
        <ul className="plain">{rows.map((i) => (
          <li key={i.id}><Card title={typeLabel(i.type)} actions={<><Badge tone={severityTone(i.severity)}>{i.severity}</Badge><Badge tone="muted">{statusLabel(i.status)}</Badge></>}>
            <p className="muted">{i.source === 'PROVIDER' ? 'Reported by the proctoring provider' : i.source === 'PROCTOR' ? 'Recorded by a proctor' : i.source} · {new Date(i.occurredAt).toLocaleString()} · waiting {ageText(i.ageMinutes)}{i.hasEvidence ? ' · has evidence' : ''}</p>
            {canCase ? <Link to={`/staff/examops/attempts/${i.attemptId}`}>Open the case</Link> : <span className="muted">Your role cannot open the case file.</span>}
          </Card></li>))}</ul>)}
    </>
  );
}

function Appeals({ canCase, canDecide }: { canCase: boolean; canDecide: boolean }) {
  const [rows, setRows] = useState<AppealRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [open, setOpen] = useState<string | null>(null);
  const [decision, setDecision] = useState('UPHELD'); const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (clear = true) => { try { setRows(await api.get<AppealRow[]>('/v1/exam-ops/appeals?status=OPEN')); if (clear) setError(null); } catch (e) { setError(e); } }, []);
  useEffect(() => { void load(); }, [load]);
  const decide = async (a: AppealRow) => {
    const p = reasonError(reason); setProblem(p); if (p) return; setBusy(true); setError(null);
    try { await api.post(`/v1/exam-ops/appeals/${a.id}/decide`, { decision, reason: reason.trim() }); setOpen(null); setReason(''); await load(); } catch (e) { setError(e); await load(false); /* keep the reason (for example a conflict of interest) on screen */ } finally { setBusy(false); }
  };
  return (
    <>
      <ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading appeals" />) : !rows.length ? <Card><p>No open appeals.</p></Card> : (
        <ul className="plain">{rows.map((a) => (
          <li key={a.id}><Card title="Appeal" actions={<span className="muted">filed {new Date(a.filedAt).toLocaleDateString()}</span>}>
            <blockquote>{a.reason}</blockquote>
            <div className="choices">{canCase && <Link to={`/staff/examops/attempts/${a.attemptId}`}>Open the case</Link>}{canDecide && open !== a.id && <button onClick={() => { setOpen(a.id); setProblem(null); setError(null); }}>Decide this appeal</button>}</div>
            {open === a.id && (
              <form onSubmit={(e) => { e.preventDefault(); void decide(a); }} noValidate>
                <p className="muted">You cannot decide an appeal if you decided anything on the original attempt. Overturning releases a valid result to the learner.</p>
                <fieldset><legend>Decision</legend>{([['UPHELD', 'Uphold: the original decision stands'], ['OVERTURNED', 'Overturn: the result is valid and is released']] as const).map(([v, l]) => <label key={v} className="inline"><input type="radio" name={`d-${a.id}`} checked={decision === v} onChange={() => setDecision(v)} /> {l}</label>)}</fieldset>
                <label htmlFor={`r-${a.id}`}>Reason (recorded in the audit trail)</label><textarea id={`r-${a.id}`} value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} />
                {problem && <p role="alert" className="note error">{problem}</p>}
                <div className="choices"><button disabled={busy}>{busy ? 'Saving…' : 'Record decision'}</button><button type="button" className="link" onClick={() => setOpen(null)}>Cancel</button></div>
              </form>)}
          </Card></li>))}</ul>)}
    </>
  );
}
