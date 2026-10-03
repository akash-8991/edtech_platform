import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { PrivacyCase, RetentionResult } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { caseStatus, describeDetails, retentionLabel, typeLabel, validateOnBehalf, waiting, who } from '../lib/privacyops';
import { canSee, hasAny, PRIVACY } from '../lib/roles';

type Tab = 'DECIDE' | 'ACTIVE' | 'DONE' | 'FILE' | 'RETENTION';
const STATUSES: Record<'DECIDE' | 'ACTIVE' | 'DONE', string> = { DECIDE: 'REQUESTED', ACTIVE: 'APPROVED,PROCESSING', DONE: 'COMPLETED,REJECTED,BLOCKED' };

export default function PrivacyDesk() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'privacy')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  const canDecide = hasAny(me?.roles, PRIVACY.decide), canFile = hasAny(me?.roles, PRIVACY.file);
  return <Desk canDecide={canDecide} canFile={canFile} />;
}

function Desk({ canDecide, canFile }: { canDecide: boolean; canFile: boolean }) {
  const tabs: [Tab, string][] = [['DECIDE', 'Needs a decision'], ['ACTIVE', 'In progress'], ['DONE', 'Finished']]; if (canFile) tabs.push(['FILE', 'File for someone']); if (canDecide) tabs.push(['RETENTION', 'Retention']);
  const [tab, setTab] = useState<Tab>('DECIDE');
  return (
    <div>
      <h1>Privacy</h1>
      <p className="muted">People can ask to download, correct or erase their data. A person other than the one who filed a request must decide it. Longest-waiting first.</p>
      <div className="tabs" role="group" aria-label="Privacy">{tabs.map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {(tab === 'DECIDE' || tab === 'ACTIVE' || tab === 'DONE') && <Requests key={tab} tab={tab} canDecide={canDecide} />}
      {tab === 'FILE' && <FileFor />}
      {tab === 'RETENTION' && <Retention />}
    </div>
  );
}

function Requests({ tab, canDecide }: { tab: 'DECIDE' | 'ACTIVE' | 'DONE'; canDecide: boolean }) {
  const [type, setType] = useState(''); const [rows, setRows] = useState<PrivacyCase[] | null>(null); const [error, setError] = useState<unknown>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (clear = true) => { const q = new URLSearchParams({ status: STATUSES[tab] }); if (type) q.set('type', type); try { setRows(await api.get<PrivacyCase[]>(`/v1/privacy/requests?${q}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [tab, type]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const run = async () => { setBusy(true); setError(null); setMsg(null); try { const r = await api.post<{ exports: number; corrections: number; erasures: number; blocked: number; failed: number }>('/v1/privacy/process'); setMsg(`Carried out ${r.exports} export${r.exports === 1 ? '' : 's'}, ${r.corrections} correction${r.corrections === 1 ? '' : 's'} and ${r.erasures} erasure${r.erasures === 1 ? '' : 's'}; ${r.blocked} could not be completed; ${r.failed} failed and will be retried.`); await load(false); } catch (e) { setError(e); } finally { setBusy(false); } };
  return (
    <>
      <label htmlFor="pr-t" className="inline">Kind</label> <select id="pr-t" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}><option value="">All</option>{['EXPORT', 'CORRECTION', 'ERASURE'].map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}</select>
      {tab === 'ACTIVE' && canDecide && <p><button onClick={() => void run()} disabled={busy}>{busy ? 'Working…' : 'Carry out approved requests now'}</button> <span className="muted">The worker does this regularly; erasures are permanent.</span></p>}
      {msg && <p role="status" className="note">{msg}</p>}<ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading requests" />) : !rows.length ? <Card><p>{tab === 'DECIDE' ? 'Nothing is waiting for a decision.' : 'Nothing here.'}</p></Card> : (
        <ul className="plain">{rows.map((r) => { const st = caseStatus(r.status); return (
          <li key={r.id}><Card title={<Link to={`/staff/privacy/requests/${r.id}`}>{typeLabel(r.type)}: {who(r)}</Link>} actions={<Badge tone={st.tone}>{st.label}</Badge>}>
            <p className="muted">{r.userEmail} · filed {r.onBehalf ? `for them by ${r.requestedByName ?? 'staff'}` : 'by them'} · waiting {waiting(r.requestedAt)}{r.decidedByName ? ` · decided by ${r.decidedByName}` : ''}</p><p>{describeDetails(r)}</p>
          </Card></li>); })}</ul>)}
    </>
  );
}

function FileFor() {
  const [q, setQ] = useState(''); const [found, setFound] = useState<{ id: string; name: string; email?: string }[] | null>(null); const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [f, setF] = useState({ type: '', name: '', language: '', reason: '' }); const [problem, setProblem] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const search = async () => { setError(null); setFound(null); try { setFound(await api.get(`/v1/admin/users?q=${encodeURIComponent(q.trim())}&limit=10`)); } catch (e) { setError(e); } };
  const submit = async () => {
    const p = validateOnBehalf({ userId: pick?.id ?? '', ...f }); setProblem(p); if (p) return; setBusy(true); setError(null); setDone(null);
    const details = f.type === 'CORRECTION' ? { ...(f.name.trim() && { name: f.name.trim() }), ...(f.language && { language: f.language }) } : f.type === 'ERASURE' ? { reason: f.reason.trim() } : {};
    try { const r = await api.post<{ id: string }>('/v1/privacy/requests/on-behalf', { userId: pick!.id, type: f.type, details }); setDone(`Filed for ${pick!.name}. Someone else must now decide it.`); setPick(null); setF({ type: '', name: '', language: '', reason: '' }); void r; } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card title="File a request for someone">
      <p className="muted">For a person who asked you by phone or in writing. Check who they are first. A downloaded copy is made for them to collect themselves; you cannot download it.</p>
      <form className="choices" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void search(); }}><label htmlFor="pf-q" className="sr-only">Find the person</label><input id="pf-q" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} /><button>Find</button></form>
      {found && (!found.length ? <p>No one found.</p> : <ul className="plain">{found.map((u) => <li key={u.id}><button className="link" onClick={() => { setPick(u); setFound(null); setProblem(null); }}>{u.name}</button> <span className="muted">{u.email}</span></li>)}</ul>)}
      {pick && (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <p>For: <strong>{pick.name}</strong> <button type="button" className="link" onClick={() => setPick(null)}>Choose someone else</button></p>
          <label htmlFor="pf-type">They asked for</label><select id="pf-type" value={f.type} onChange={(e) => { setF({ ...f, type: e.target.value }); setProblem(null); }}><option value="">Choose…</option>{['EXPORT', 'CORRECTION', 'ERASURE'].map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}</select>
          {f.type === 'CORRECTION' && <><label htmlFor="pf-name">Correct name</label><input id="pf-name" value={f.name} onChange={(e) => { setF({ ...f, name: e.target.value }); setProblem(null); }} /><label htmlFor="pf-lang">Correct language</label><select id="pf-lang" value={f.language} onChange={(e) => { setF({ ...f, language: e.target.value }); setProblem(null); }}><option value="">Leave as it is</option><option value="en">English</option><option value="hi">Hindi</option></select></>}
          {f.type === 'ERASURE' && <><label htmlFor="pf-why">Reason they gave (optional)</label><textarea id="pf-why" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /><p className="note">Erasure is permanent once approved and carried out.</p></>}
          {problem && <p role="alert" className="note error">{problem}</p>}<button disabled={busy}>{busy ? 'Filing…' : 'File the request'}</button>
        </form>)}
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
    </Card>
  );
}

function Retention() {
  const [r, setR] = useState<RetentionResult | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (dry: boolean) => {
    if (!dry && !window.confirm('Remove everything past its retention period now? This cannot be undone.')) return;
    setBusy(true); setError(null); try { setR(await api.post<RetentionResult>(`/v1/privacy/retention/run${dry ? '?dryRun=true' : ''}`)); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const counts = r ? (r.wouldRemove ?? r.removed ?? {}) : {};
  return (
    <Card title="Retention">
      <p className="muted">Data kept longer than its retention period (set under Operations → settings) is removed: old notifications, tutor chat text, proctoring callbacks, expired sign-ins and expired downloads. Academic records and the audit trail are not touched. The worker runs this daily.</p>
      <div className="choices"><button onClick={() => void go(true)} disabled={busy}>See what would be removed</button><button onClick={() => void go(false)} disabled={busy}>Remove it now</button></div>
      <ErrorNote error={error} />
      {r && <div role="status" className="note"><p>{r.dryRun ? 'Nothing was removed. This is what would be:' : 'Removed:'}</p><ul>{Object.entries(counts).map(([k, n]) => <li key={k}>{n} {retentionLabel(k)}</li>)}</ul></div>}
    </Card>
  );
}
