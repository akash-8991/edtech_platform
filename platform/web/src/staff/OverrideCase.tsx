import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { OverrideCase as Case } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { changeText, decideBlock, overrideStatus, passText, sideEffects } from '../lib/gradechanges';
import { canSee, GRADECHANGES, hasAny } from '../lib/roles';

export default function OverrideCase() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'gradechanges')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Page meId={me!.id} canAct={hasAny(me?.roles, GRADECHANGES.act)} />;
}

function Page({ meId, canAct }: { meId: string; canAct: boolean }) {
  const { overrideId = '' } = useParams(); const [c, setC] = useState<Case | null>(null); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async (clear = true) => { try { setC(await api.get<Case>(`/v1/grading/overrides/${overrideId}`)); if (clear) setError(null); } catch (e) { setError(e); } }, [overrideId]);
  useEffect(() => { setC(null); setDone(null); void load(); }, [load]);
  /** Decides, then refreshes but keeps a refusal on screen. */
  const decide = async (decision: 'APPROVE' | 'REJECT', reason: string) => { setError(null); setDone(null); try { await api.post(`/v1/grading/overrides/${overrideId}/decide`, { decision, ...(reason ? { reason } : {}) }); setDone(decision === 'APPROVE' ? 'Approved. The grade has changed and the learner has been told.' : 'Declined. The grade is unchanged.'); await load(false); return true; } catch (e) { setError(e); await load(false); return false; } };
  if (!c) return <div><p><Link to="/staff/gradechanges">Back to grade changes</Link></p><h1>Grade override</h1><ErrorNote error={error} />{!error && <Loading what="Loading the override" />}</div>;
  const st = overrideStatus(c.status); const block = decideBlock(c, meId); const dim = (id: string) => c.policy.dimensions.find((d) => d.id === id);
  return (
    <div>
      <p><Link to="/staff/gradechanges">Back to grade changes</Link></p>
      <h1>{c.submission.learnerName ?? 'A learner'}: {c.submission.topic ?? 'assignment'}</h1>
      <p><Badge tone={st.tone}>{st.label}</Badge> <span className="muted">{c.submission.programme} · attempt {c.submission.attemptNo} · proposed by {c.proposedByName ?? 'an administrator'} on {new Date(c.createdAt).toLocaleString()}{c.decidedByName ? ` · decided by ${c.decidedByName}` : ''} · <Link to={`/staff/gradechanges/submissions/${c.submission.id}`}>Full grade history</Link></span></p>
      <ErrorNote error={error} />{done && <p role="status" className="note">{done}</p>}
      <Card title="Why it was proposed"><p>{c.reason}</p>{c.feedback && <p className="muted">New feedback for the learner: {c.feedback}</p>}{c.decisionReason && <p className="muted">Decision reason: {c.decisionReason}</p>}</Card>
      <Card title="The change"><table><thead><tr><th>Criterion</th><th>Now</th><th>Proposed</th></tr></thead><tbody>{c.proposed.dimensions.map((p) => { const now = c.current?.dimensions.find((x) => x.id === p.id)?.score; const d = dim(p.id); return <tr key={p.id}><td>{d?.name ?? p.id}</td><td>{now ?? 'n/a'}{d ? ` of ${d.max}` : ''}</td><td><strong className={now !== p.score ? 'warnnum' : undefined}>{p.score}</strong>{d ? ` of ${d.max}` : ''}</td></tr>; })}</tbody></table>
        <p><strong>{changeText(c.current?.finalPercent, c.proposed.finalPercent)}</strong>. {passText(c.current?.passed, c.proposed.passed)} (pass mark {c.policy.passPercent}%).{c.proposed.latePenaltyPercent ? ` A late penalty of ${c.proposed.latePenaltyPercent}% is included.` : ''}</p>
        {c.current && <p className="muted">{c.status === 'APPROVED' ? 'This replaced' : 'The current grade is'} the {c.current.kind === 'AI' ? 'AI grade' : c.current.kind === 'OVERRIDE' ? 'previous override' : 'human grade'} (record {c.current.seq}). {c.status === 'APPROVED' ? 'Both stay on record.' : 'It stays on record; an approved override is added after it.'}</p>}
      </Card>
      {canAct && c.status === 'PENDING' && <Decide block={block} effect={sideEffects(c.submission.state)} onDecide={decide} />}
      {!canAct && c.status === 'PENDING' && <p className="muted">Your role can read overrides but not decide them.</p>}
    </div>
  );
}

function Decide({ block, effect, onDecide }: { block: string | null; effect: string | null; onDecide: (d: 'APPROVE' | 'REJECT', r: string) => Promise<boolean> }) {
  const [reason, setReason] = useState(''); const [problem, setProblem] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = (d: 'APPROVE' | 'REJECT') => { if (d === 'REJECT' && !reason.trim()) { setProblem('Write why it is declined: the person who proposed it will read it.'); return; } if (d === 'APPROVE' && !window.confirm('Approve this override? The learner\'s grade changes now.')) return; setBusy(true); void onDecide(d, reason.trim()).finally(() => setBusy(false)); };
  return (
    <Card title="Decide">
      {block && <p className="note">{block} The server will refuse it; ask a colleague.</p>}{effect && <p className="note">{effect}</p>}
      <label htmlFor="oc-why">Reason (required to decline; optional note when approving; recorded in the audit trail)</label><textarea id="oc-why" value={reason} onChange={(e) => { setReason(e.target.value); setProblem(null); }} aria-invalid={!!problem} />{problem && <p role="alert" className="note error">{problem}</p>}
      <div className="choices"><button disabled={busy} onClick={() => go('APPROVE')}>Approve</button><button disabled={busy} onClick={() => go('REJECT')}>Decline</button></div>
    </Card>
  );
}
