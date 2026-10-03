import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { CatalogueItem, EntitlementRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { daysLeft, statusLabel, STATUS_TONE } from '../lib/entitlements';
import { canSee } from '../lib/roles';

export default function Entitlements() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'entitlements')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Search />;
}

function Search() {
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [programme, setProgramme] = useState(''); const [applied, setApplied] = useState({ q: '', status: '', programme: '' });
  const [programmes, setProgrammes] = useState<CatalogueItem[]>([]); const [rows, setRows] = useState<EntitlementRow[] | null>(null); const [next, setNext] = useState<string | null>(null); const [error, setError] = useState<unknown>(null); const [more, setMore] = useState(false);
  useEffect(() => { api.get<CatalogueItem[]>('/v1/catalogue').then(setProgrammes).catch(() => undefined); }, []);
  const url = useCallback((cursor?: string) => { const p = new URLSearchParams({ limit: '50' }); if (applied.q.trim()) p.set('q', applied.q.trim()); if (applied.status) p.set('status', applied.status); if (applied.programme) p.set('programme', applied.programme); if (cursor) p.set('cursor', cursor); return `/v1/admin/entitlements?${p}`; }, [applied]);
  const load = useCallback(async () => { try { const r = await api.page<EntitlementRow>(url()); setRows(r.items); setNext(r.next); setError(null); } catch (e) { setError(e); } }, [url]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const loadMore = async () => { setMore(true); try { const r = await api.page<EntitlementRow>(url(next!)); setRows((x) => [...(x ?? []), ...r.items]); setNext(r.next); } catch (e) { setError(e); } finally { setMore(false); } };
  const codes = [...new Map(programmes.map((p) => [p.code, p])).values()];
  return (
    <div>
      <h1>Entitlements</h1>
      <p className="muted">Each row is one learner's access to one programme. Open a row to pause, extend, revoke or unlock a topic. Every change is recorded with your reason.</p>
      <form className="choices" role="search" onSubmit={(e) => { e.preventDefault(); setApplied({ q, status, programme }); }}>
        <label htmlFor="en-q" className="sr-only">Search by learner name or email</label><input id="en-q" type="search" placeholder="Search by learner name or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <label htmlFor="en-p">Programme</label><select id="en-p" value={programme} onChange={(e) => setProgramme(e.target.value)} style={{ width: 'auto' }}><option value="">Any</option>{codes.map((p) => <option key={p.code} value={p.code}>{p.code} · {p.title}</option>)}</select>
        <label htmlFor="en-s">Status</label><select id="en-s" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Any</option>{['ACTIVE', 'PAUSED', 'EXPIRED', 'REVOKED'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select>
        <button>Search</button>
      </form>
      <ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading entitlements" />) : !rows.length ? <Card><p>No entitlements match.</p></Card> : (
        <Card><div className="scroll"><table><thead><tr><th>Learner</th><th>Programme</th><th>Status</th><th>Ends</th><th>Pauses</th></tr></thead><tbody>{rows.map((e) => (
          <tr key={e.id}><td><Link to={`/staff/entitlements/${e.id}`}>{e.learner.name}</Link><br /><span className="muted">{e.learner.email}</span></td><td>{e.programme.code} v{e.versionNumber}<br /><span className="muted">{e.cohort}</span></td>
            <td><Badge tone={STATUS_TONE(e.effectiveStatus)}>{statusLabel(e.effectiveStatus)}</Badge></td><td>{new Date(e.endAt).toLocaleDateString()}<br /><span className="muted">{daysLeft(e.endAt) > 0 ? `${daysLeft(e.endAt)} days left` : 'ended'}</span></td><td>{e.pauseCount} ({e.pausedDays} days)</td></tr>))}</tbody></table></div>
          {next && <p><button onClick={() => void loadMore()} disabled={more}>{more ? 'Loading…' : 'Show more'}</button></p>}</Card>)}
    </div>
  );
}
