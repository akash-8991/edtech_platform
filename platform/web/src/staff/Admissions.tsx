import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Application, ImportResult } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { idempotencyKey } from '../lib/format';
import { AREAS, canSee, hasAny } from '../lib/roles';

const TABS: [string, string][] = [['RECEIVED', 'To review'], ['RETURNED', 'Returned'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']];
const PAGE = 25;

export default function Admissions() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'admissions')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <AdmissionsInner />;
}

function AdmissionsInner() {
  const { me } = useAuth();
  const [status, setStatus] = useState('RECEIVED'); const [items, setItems] = useState<Application[] | null>(null); const [next, setNext] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [more, setMore] = useState(false);
  const canAct = hasAny(me?.roles, AREAS.admissions.act), canImport = hasAny(me?.roles, AREAS.admissions.import);
  const load = useCallback(async (cursor?: string) => {
    try { const r = await api.page<Application>(`/v1/applications?status=${status}&limit=${PAGE}${cursor ? `&cursor=${cursor}` : ''}`); setItems((cur) => (cursor && cur ? [...cur, ...r.items] : r.items)); setNext(r.next); setError(null); } catch (e) { setError(e); }
  }, [status]);
  useEffect(() => { setItems(null); void load(); }, [load]);
  const removed = (id: string) => setItems((xs) => xs?.filter((x) => x.id !== id) ?? null);
  return (
    <div>
      <h1>Admissions</h1>
      <div className="tabs" role="group" aria-label="Application status">{TABS.map(([k, label]) => <button key={k} aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>)}</div>
      <ErrorNote error={error} />
      {!items ? <Loading what="Loading applications" /> : !items.length ? <Card><p>No applications here.</p></Card> : (<>
        <ul className="plain">{items.map((a) => <li key={a.id}><ApplicationRow a={a} canAct={canAct && (a.status === 'RECEIVED' || a.status === 'RETURNED')} onDecided={() => removed(a.id)} /></li>)}</ul>
        {next && <button className="secondary" disabled={more} onClick={async () => { setMore(true); await load(next); setMore(false); }}>Load more</button>}</>)}
      {canImport && <ImportCard onImported={() => void load()} />}
    </div>
  );
}

type Decision = 'APPROVE' | 'RETURN' | 'REJECT';
function ApplicationRow({ a, canAct, onDecided }: { a: Application; canAct: boolean; onDecided: () => void }) {
  const [mode, setMode] = useState<Decision | null>(null); const [reason, setReason] = useState(''); const [start, setStart] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [key] = useState(idempotencyKey);
  const need = mode !== 'APPROVE' && !reason.trim();
  const submit = async () => {
    if (!mode) return; setBusy(true); setError(null);
    try { await api.post(`/v1/applications/${a.id}/decision`, { decision: mode, ...(reason.trim() && { reason: reason.trim() }), ...(mode === 'APPROVE' && start && { startAt: new Date(start).toISOString() }) }, key); onDecided(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card title={a.name} actions={<Badge tone={a.status === 'APPROVED' ? 'ok' : a.status === 'REJECTED' ? 'muted' : 'warn'}>{a.status.toLowerCase()}</Badge>}>
      <p>{a.email} · programme <strong>{a.programmeCode}</strong> · {a.duration === 'M12' ? '12 months' : a.duration === 'M18' ? '18 months' : a.duration} · cohort {a.cohort}</p>
      <p className="muted">Reference {a.externalRef} · received {new Date(a.createdAt).toLocaleString()}{a.reason ? ` · reason: ${a.reason}` : ''}</p>
      {canAct && !mode && <div className="choices"><button onClick={() => setMode('APPROVE')}>Approve</button><button className="secondary" onClick={() => setMode('RETURN')}>Return for changes</button><button className="secondary" onClick={() => setMode('REJECT')}>Reject</button></div>}
      {mode && (
        <form className="card inner" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={`Decision for ${a.name}`}>
          <h3>{mode === 'APPROVE' ? 'Approve and create the learner’s access' : mode === 'RETURN' ? 'Return to the applicant' : 'Reject this application'}</h3>
          {mode === 'APPROVE' && <><p className="muted">This creates the learner account and an entitlement to the latest published course version of {a.programmeCode}.</p><label htmlFor={`st-${a.id}`}>Access starts (optional, default now)</label><input id={`st-${a.id}`} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></>}
          <label htmlFor={`rs-${a.id}`}>{mode === 'APPROVE' ? 'Note (optional)' : 'Reason (required, recorded in the audit trail)'}</label><textarea id={`rs-${a.id}`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <ErrorNote error={error} />
          <div className="choices"><button type="submit" disabled={busy || need}>{busy ? 'Saving…' : mode === 'APPROVE' ? 'Confirm approval' : mode === 'RETURN' ? 'Confirm return' : 'Confirm rejection'}</button><button type="button" className="secondary" onClick={() => { setMode(null); setError(null); }}>Cancel</button></div>
        </form>)}
    </Card>
  );
}

const TEMPLATE = 'externalRef,email,name,programmeCode,duration,cohort\nADM-0001,asha@example.org,Asha Rao,DEMO-1,M12,2026-A\n';
function ImportCard({ onImported }: { onImported: () => void }) {
  const [csv, setCsv] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [result, setResult] = useState<ImportResult | null>(null);
  const run = async () => { setBusy(true); setError(null); setResult(null); try { const r = await api.post<ImportResult>('/v1/applications/import', { csv }, idempotencyKey()); setResult(r); if (r.summary.created) onImported(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const rows = csv.trim() ? Math.max(0, csv.trim().split('\n').length - 1) : 0;
  return (
    <Card title="Import applications (CSV)">
      <p className="muted">Columns: <span className="mono">externalRef,email,name,programmeCode,duration,cohort</span>. Duration is M12 or M18. Up to 1,000 rows. Re-importing a row with the same reference is harmless: it is reported as a duplicate.</p>
      <label htmlFor="imp-file">Choose a CSV file</label><input id="imp-file" type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
      <label htmlFor="imp-text">Or paste it here</label><textarea id="imp-text" rows={6} placeholder={TEMPLATE} value={csv} onChange={(e) => setCsv(e.target.value)} />
      <ErrorNote error={error} />
      <button disabled={busy || !csv.trim() || rows > 1000} onClick={() => void run()}>{busy ? 'Importing…' : `Import ${rows ? `${rows} row${rows > 1 ? 's' : ''}` : ''}`}</button>{rows > 1000 && <span className="note error"> too many rows (max 1,000)</span>}
      {result && (<div role="status" aria-live="polite"><p><strong>{result.summary.created}</strong> created · <strong>{result.summary.duplicate}</strong> duplicate · <strong>{result.summary.invalid}</strong> invalid</p>
        {result.summary.invalid > 0 && <table className="grid"><caption className="sr-only">Rows that were not imported</caption><thead><tr><th>Reference</th><th>Problem</th></tr></thead><tbody>{result.results.filter((r) => r.result === 'invalid').map((r, i) => <tr key={i}><td>{r.externalRef ?? '(missing)'}</td><td>{(r.errors ?? []).join('; ')}</td></tr>)}</tbody></table>}</div>)}
    </Card>
  );
}
