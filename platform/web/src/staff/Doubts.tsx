import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { DoubtRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { categoryLabel, priorityTone, slaInfo, statusLabel } from '../lib/doubts';
import { canSee, DOUBTS, hasAny } from '../lib/roles';
import { Appointments, Teachers } from './DoubtTeachers';
import { Faq } from './DoubtFaq';
import { Report } from './DoubtReport';

type Tab = 'MINE' | 'UNASSIGNED' | 'ALL' | 'FAQ' | 'APPOINTMENTS' | 'TEACHERS' | 'REPORT';

export default function Doubts() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'doubts')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Desk roles={me!.roles} />;
}

function Desk({ roles }: { roles: string[] }) {
  const can = (l: readonly string[]) => hasAny(roles, l);
  const tabs: [Tab, string][] = [];
  if (can(DOUBTS.teacher)) tabs.push(['MINE', 'My tickets']);
  if (can(DOUBTS.tickets)) tabs.push(['UNASSIGNED', 'Waiting for a teacher']);
  if (can(DOUBTS.staff)) tabs.push(['ALL', 'All tickets']);
  if (can(DOUBTS.faqRead)) tabs.push(['FAQ', 'Reusable answers']);
  if (can(DOUBTS.teacher)) tabs.push(['APPOINTMENTS', 'Appointments']);
  if (can(DOUBTS.teachersRead) || can(DOUBTS.teacher)) tabs.push(['TEACHERS', can(DOUBTS.teachersRead) ? 'Teachers' : 'My availability']);
  if (can(DOUBTS.report)) tabs.push(['REPORT', 'Report']);
  const [tab, setTab] = useState<Tab>(tabs[0][0]);
  return (
    <div>
      <h1>Doubt desk</h1>
      <p className="muted">Learners ask questions here. You see a learner's first name and what they were doing, never their contact details.</p>
      <div className="tabs" role="group" aria-label="Doubt desk">{tabs.map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {(tab === 'MINE' || tab === 'UNASSIGNED' || tab === 'ALL') && <Queue key={tab} scope={tab} canSweep={can(DOUBTS.staff)} />}
      {tab === 'FAQ' && <Faq canReview={can(DOUBTS.faqReview)} canTicket={can(DOUBTS.tickets)} />}
      {tab === 'APPOINTMENTS' && <Appointments />}
      {tab === 'TEACHERS' && <Teachers canRead={can(DOUBTS.teachersRead)} canEdit={can(DOUBTS.teachersEdit)} isTeacher={can(DOUBTS.teacher)} />}
      {tab === 'REPORT' && <Report />}
    </div>
  );
}

const SCOPE = { MINE: { q: '', empty: 'No tickets are assigned to you. Open "Waiting for a teacher" to pick one up.' }, UNASSIGNED: { q: 'scope=unassigned', empty: 'Nothing is waiting for a teacher.' }, ALL: { q: 'scope=all', empty: 'There are no tickets.' } } as const;

function Queue({ scope, canSweep }: { scope: 'MINE' | 'UNASSIGNED' | 'ALL'; canSweep: boolean }) {
  const [rows, setRows] = useState<DoubtRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [status, setStatus] = useState(''); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (clear = true) => { const q = [SCOPE[scope].q, status && `status=${status}`].filter(Boolean).join('&'); try { setRows(await api.get<DoubtRow[]>(`/v1/teacher/tickets${q ? `?${q}` : ''}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [scope, status]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const sweep = async () => { setBusy(true); setError(null); setMsg(null); try { const r = await api.post<{ routed: number; breached: number; rerouted: number; closed: number }>('/v1/doubt-centre/sweep'); setMsg(`Assigned ${r.routed} waiting ticket${r.routed === 1 ? '' : 's'}, flagged ${r.breached} late, moved ${r.rerouted} to another teacher, closed ${r.closed} old resolved ticket${r.closed === 1 ? '' : 's'}.`); await load(false); } catch (e) { setError(e); } finally { setBusy(false); } };
  return (
    <>
      {scope === 'ALL' && <><label htmlFor="dq-st" className="inline">Status</label> <select id="dq-st" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>{[['', 'Any'], ['NEW', 'New'], ['ASSIGNED', 'Assigned'], ['IN_PROGRESS', 'In progress'], ['WAITING_LEARNER', 'Waiting for the learner'], ['RESOLVED', 'Resolved']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></>}
      {canSweep && scope !== 'MINE' && <p><button onClick={() => void sweep()} disabled={busy}>{busy ? 'Working…' : 'Assign waiting tickets and check reply deadlines'}</button> <span className="muted">The worker also does this regularly.</span></p>}
      {msg && <p role="status" className="note">{msg}</p>}<ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading tickets" />) : !rows.length ? <Card><p>{SCOPE[scope].empty}</p></Card> : (
        <ul className="plain">{rows.map((t) => { const sla = slaInfo(t); return (
          <li key={t.id}><Card title={<Link to={`/staff/doubts/tickets/${t.id}`}>#{t.number} {t.subject}</Link>} actions={<><Badge tone={priorityTone(t.priority)}>{t.priority}</Badge><Badge tone="muted">{statusLabel(t.status)}</Badge></>}>
            <p className="muted">{categoryLabel(t.category)} · {t.assignedTeacherName ? `with ${t.assignedTeacherName}` : 'not assigned'} · asked {new Date(t.createdAt).toLocaleString()}{t.reopenCount ? ` · reopened ${t.reopenCount}×` : ''}</p>
            <p><Badge tone={sla.tone}>{sla.text}</Badge></p>
          </Card></li>); })}</ul>)}
    </>
  );
}
