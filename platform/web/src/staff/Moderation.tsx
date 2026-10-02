import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ModerationRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { ageText, describeReason, kindLabel } from '../lib/moderation';
import { AREAS, canSee, hasAny } from '../lib/roles';

type View = 'OPEN' | 'MINE' | 'CLAIMED';
const KINDS: [string, string][] = [['', 'All kinds'], ['BLOCKING', 'Needs a grade'], ['APPEAL', 'Appeals'], ['SAMPLE', 'Quality checks']];

export default function Moderation() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'moderation')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Queue canAct={hasAny(me?.roles, AREAS.moderation.act)} meId={me!.id} />;
}

function Queue({ canAct, meId }: { canAct: boolean; meId: string }) {
  const nav = useNavigate();
  const [view, setView] = useState<View>('OPEN'); const [kind, setKind] = useState(''); const [rows, setRows] = useState<ModerationRow[] | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async (clearError = true) => {
    const q = new URLSearchParams({ status: view === 'OPEN' ? 'OPEN' : 'CLAIMED' }); if (view === 'MINE') q.set('mine', 'true'); if (kind) q.set('kind', kind);
    try { setRows(await api.get<ModerationRow[]>(`/v1/moderation/queue?${q}`)); if (clearError) setError(null); } catch (e) { setError(e); }
  }, [view, kind]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const claim = async (r: ModerationRow) => { setBusy(r.taskId); setError(null); try { await api.post(`/v1/moderation/tasks/${r.taskId}/claim`); nav(`/staff/moderation/${r.taskId}`); } catch (e) { setError(e); await load(false); /* refresh the list but keep the reason the reviewer needs to read */ } finally { setBusy(null); } };
  const tabs: [View, string][] = canAct ? [['OPEN', 'Waiting for a reviewer'], ['MINE', 'Claimed by me']] : [['OPEN', 'Waiting for a reviewer'], ['CLAIMED', 'Being reviewed']];
  return (
    <div>
      <h1>Grading</h1>
      <p className="muted">Work the AI could not decide alone, quality checks of automatic grades, and learners' appeals. Learners are shown only a pseudonym here; you will never see who they are.</p>
      <div className="tabs" role="group" aria-label="Queue">{tabs.map(([k, label]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{label}</button>)}</div>
      <label htmlFor="mq-kind" className="inline">Show</label> <select id="mq-kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <ErrorNote error={error} />
      {!rows ? <Loading what="Loading the queue" /> : !rows.length ? <Card><p>{view === 'OPEN' ? 'Nothing is waiting. Well done.' : 'Nothing here.'}</p></Card> : (
        <ul className="plain">{rows.map((r) => (
          <li key={r.taskId}><Card title={<>Submission {r.learnerRef}</>} actions={<><Badge tone={r.kind === 'APPEAL' ? 'warn' : 'muted'}>{kindLabel(r.kind)}</Badge><span className="muted">waiting {ageText(r.ageMinutes)}</span></>}>
            <ul aria-label="Why this needs a person">{r.reasons.map((x) => <li key={x}>{describeReason(x)}</li>)}</ul>
            {r.aiPercent !== null && <p className="muted">AI's score: {r.aiPercent}%</p>}
            <div className="choices">
              {canAct && r.status === 'OPEN' && <button disabled={busy === r.taskId} onClick={() => void claim(r)}>Claim and open</button>}
              {canAct && r.status === 'CLAIMED' && r.claimedById === meId && <button onClick={() => nav(`/staff/moderation/${r.taskId}`)}>Open</button>}
              {r.status === 'CLAIMED' && r.claimedById !== meId && <span className="muted">Being reviewed by someone else</span>}</div>
          </Card></li>))}</ul>)}
    </div>
  );
}
