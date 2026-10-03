import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { FoundSubmission, OverrideRow } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { gradeState, overrideStatus, pctText } from '../lib/gradechanges';
import { canSee, GRADECHANGES, hasAny } from '../lib/roles';
import { LearnerPicker, type PickedLearner } from './LearnerPicker';

type Tab = 'PENDING' | 'DECIDED' | 'FIND';

export default function GradeChanges() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'gradechanges')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Desk canAct={hasAny(me?.roles, GRADECHANGES.act)} />;
}

function Desk({ canAct }: { canAct: boolean }) {
  const tabs: [Tab, string][] = [['PENDING', 'Waiting for approval'], ['DECIDED', 'Decided'], ['FIND', "Find a learner's work"]]; const [tab, setTab] = useState<Tab>('PENDING');
  return (
    <div>
      <h1>Grade changes</h1>
      <p className="muted">Changing a grade takes two people: one proposes it, a different administrator approves it. Nothing changes until it is approved, and the original grade stays on record. Late penalties still apply.</p>
      <div className="tabs" role="group" aria-label="Grade changes">{tabs.map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'FIND' ? <Find canAct={canAct} /> : <List key={tab} status={tab === 'PENDING' ? 'PENDING' : 'APPROVED,REJECTED'} empty={tab === 'PENDING' ? 'No override is waiting for approval.' : 'No override has been decided yet.'} />}
    </div>
  );
}

function List({ status, empty }: { status: string; empty: string }) {
  const [rows, setRows] = useState<OverrideRow[] | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<OverrideRow[]>(`/v1/grading/overrides?status=${status}`).then((r) => { setRows(r); setError(null); }).catch(setError); }, [status]);
  return (
    <>
      <ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading overrides" />) : !rows.length ? <Card><p>{empty}</p></Card> : (
        <ul className="plain">{rows.map((o) => { const st = overrideStatus(o.status); return (
          <li key={o.id}><Card title={<Link to={`/staff/gradechanges/overrides/${o.id}`}>{o.learnerName ?? 'A learner'}: {o.topic ?? 'assignment'}{o.attemptNo ? ` (attempt ${o.attemptNo})` : ''}</Link>} actions={<Badge tone={st.tone}>{st.label}</Badge>}>
            <p className="muted">Currently {pctText(o.currentPercent)} · proposed by {o.proposedByName ?? 'an administrator'} on {new Date(o.createdAt).toLocaleDateString()}{o.decidedByName ? ` · decided by ${o.decidedByName}` : ''}</p><p>{o.reason}</p>{o.decisionReason && <p className="muted">Decision: {o.decisionReason}</p>}
          </Card></li>); })}</ul>)}
    </>
  );
}

function Find({ canAct }: { canAct: boolean }) {
  const [who, setWho] = useState<PickedLearner | null>(null); const [rows, setRows] = useState<FoundSubmission[] | null>(null); const [error, setError] = useState<unknown>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (id: string) => { setRows(null); try { setRows(await api.get<FoundSubmission[]>(`/v1/grading/submissions?learnerId=${id}`)); setError(null); } catch (e) { setError(e); } }, []);
  useEffect(() => { if (who) void load(who.id); else setRows(null); }, [who, load]);
  const sweep = async () => { setBusy(true); setError(null); setMsg(null); try { const r = await api.post<{ finalised: number }>('/v1/grading/sweep'); setMsg(`${r.finalised} grade${r.finalised === 1 ? '' : 's'} became final because the appeal window had closed.`); } catch (e) { setError(e); } finally { setBusy(false); } };
  return (
    <>
      <Card title="Find a learner's work"><LearnerPicker value={who} onChange={setWho} idPrefix="gc" /></Card>
      <ErrorNote error={error} />
      {who && (!rows ? (!error && <Loading />) : !rows.length ? <Card><p>{who.name} has no graded work.</p></Card> : (
        <ul className="plain">{rows.map((r) => (
          <li key={r.submissionId}><Card title={<Link to={`/staff/gradechanges/submissions/${r.submissionId}`}>{r.topic ?? 'Assignment'}{r.attemptNo ? ` (attempt ${r.attemptNo})` : ''}</Link>} actions={<Badge tone="muted">{gradeState(r.state)}</Badge>}>
            <p className="muted">{r.programme} · submitted {r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : 'n/a'} · grade {pctText(r.finalPercent)}{r.passed === null ? '' : r.passed ? ' (pass)' : ' (not a pass)'}</p></Card></li>))}</ul>))}
      {canAct && <Card title="Close appeal windows"><p className="muted">A grade becomes final when its appeal window has passed. The worker does this regularly; you can do it now.</p><button onClick={() => void sweep()} disabled={busy}>{busy ? 'Working…' : 'Make eligible grades final'}</button>{msg && <p role="status" className="note">{msg}</p>}</Card>}
    </>
  );
}
