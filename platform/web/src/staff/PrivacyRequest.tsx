import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { PrivacyCaseDetail } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { actionLabel, caseStatus, decideBlock, describeDetails, describeResult, ERASURE_KEPT, erasureBlockers, typeLabel, waiting, who } from '../lib/privacyops';
import { canSee, hasAny, PRIVACY } from '../lib/roles';

export default function PrivacyRequest() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'privacy')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Page meId={me!.id} canDecide={hasAny(me?.roles, PRIVACY.decide)} />;
}

function Page({ meId, canDecide }: { meId: string; canDecide: boolean }) {
  const { requestId = '' } = useParams(); const [r, setR] = useState<PrivacyCaseDetail | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setR(await api.get<PrivacyCaseDetail>(`/v1/privacy/requests/${requestId}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [requestId]);
  useEffect(() => { setR(null); setDone(null); void load(); }, [load]);
  /** Decides, then refreshes but keeps a refusal on screen (the reason is what the decider needs to read). */
  const decide = async (decision: 'APPROVE' | 'REJECT', reason: string) => { setError(null); setDone(null); try { await api.post(`/v1/privacy/requests/${requestId}/decide`, { decision, reason }); setDone(decision === 'APPROVE' ? 'Approved. It will be carried out shortly, and the person is told.' : 'Declined. The person is told.'); await load(false); return true; } catch (e) { setError(e); await load(false); return false; } };
  if (!r) return <div><p><Link to="/staff/privacy">Back to privacy</Link></p><h1>Privacy request</h1><ErrorNote error={error} />{!error && <Loading what="Loading the request" />}</div>;
  const st = caseStatus(r.status); const block = decideBlock(r, meId); const blockers = r.type === 'ERASURE' ? erasureBlockers(r.subject) : []; const result = describeResult(r);
  return (
    <div>
      <p><Link to="/staff/privacy">Back to privacy</Link></p>
      <h1>{typeLabel(r.type)}: {who(r)}</h1>
      <p><Badge tone={st.tone}>{st.label}</Badge> <span className="muted">{r.userEmail} · filed {r.onBehalf ? `for them by ${r.requestedByName ?? 'staff'}` : 'by them'} · waiting {waiting(r.requestedAt)}{r.decidedByName ? ` · decided by ${r.decidedByName}` : ''}</span></p>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      <Card title="What was asked"><p>{describeDetails(r)}</p>{r.decisionReason && <p className="muted">Decision reason: {r.decisionReason}</p>}</Card>
      {r.type === 'ERASURE' && r.status === 'REQUESTED' && (
        <Card title="Before you decide"><p>{ERASURE_KEPT}</p>
          {blockers.length ? <div className="note error"><p>It cannot be carried out now:</p><ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul><p className="muted">You may still approve it; it will then be recorded as “could not be completed” and the person is told to contact support.</p></div> : r.status === 'REQUESTED' && <p>Nothing stops it today. <strong>Erasure cannot be undone.</strong></p>}
        </Card>)}
      {canDecide && r.status === 'REQUESTED' && <Decide block={block} type={r.type} onDecide={decide} />}
      {!canDecide && r.status === 'REQUESTED' && <p className="muted">Your role can read requests but not decide them.</p>}
      {result.length > 0 && <Card title="What happened"><ul>{result.map((x) => <li key={x}>{x}</li>)}</ul></Card>}
      <Card title="History">{!r.history.length ? <p>Nothing recorded.</p> : <table><thead><tr><th>When</th><th>What</th><th>By</th><th>Reason</th></tr></thead><tbody>{r.history.map((h, i) => <tr key={i}><td>{new Date(h.at).toLocaleString()}</td><td>{actionLabel(h.action)}</td><td>{h.by}</td><td>{h.reason ?? ''}</td></tr>)}</tbody></table>}</Card>
    </div>
  );
}

function Decide({ block, type, onDecide }: { block: string | null; type: string; onDecide: (d: 'APPROVE' | 'REJECT', r: string) => Promise<boolean> }) {
  const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = (d: 'APPROVE' | 'REJECT') => { if (!reason.trim()) { setProblem('Write the reason: it is recorded in the audit trail and the person can read it.'); return; } if (d === 'APPROVE' && type === 'ERASURE' && !window.confirm('Approve this erasure? Once carried out it cannot be undone.')) return; setBusy(true); void onDecide(d, reason.trim()).finally(() => setBusy(false)); };
  return (
    <Card title="Decide">
      {block && <p className="note">{block} The server will refuse it; ask a colleague.</p>}
      <label htmlFor="pd-why">Reason (recorded in the audit trail; the person can read it)</label><textarea id="pd-why" value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} />
      {problem && <p role="alert" className="note error">{problem}</p>}
      <div className="choices"><button disabled={busy} onClick={() => go('APPROVE')}>Approve</button><button disabled={busy} onClick={() => go('REJECT')}>Decline</button></div>
    </Card>
  );
}
