import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { GradeView } from '../api/types';
import { Badge, Card, ErrorNote, Progress, Hold } from '../components/ui';
import { appealWindow, describeState, pct } from '../lib/grades';
import { idempotencyKey } from '../lib/format';

/** One submission's grade: the score, the rubric breakdown with the evidence the grader pointed to, written feedback, and the right to appeal. */
export default function GradeDetail({ pollMs = 15_000 }: { pollMs?: number }) {
  const { submissionId = '' } = useParams();
  const [g, setG] = useState<GradeView | null>(null); const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [appealed, setAppealed] = useState(false); const [key] = useState(idempotencyKey);
  const load = useCallback(() => api.get<GradeView>(`/v1/me/submissions/${submissionId}`).then((x) => { setG(x); setError(null); }).catch(setError), [submissionId]);
  useEffect(() => { void load(); }, [load]);
  // pending states refresh themselves until a grade arrives
  useEffect(() => { if (!g || !describeState(g.state).pending || g.dimensions) return; const t = setInterval(() => void load(), pollMs); return () => clearInterval(t); }, [g, load, pollMs]);

  const appeal = async () => { setBusy(true); setError(null); try { await api.post(`/v1/me/submissions/${submissionId}/appeal`, { reason: reason.trim() }, key); setAppealed(true); await load(); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (!g) return <Hold title="Assignment feedback" error={error} what="Loading your grade" />;
  const s = describeState(g.state); const graded = !!g.dimensions;
  return (
    <div>
      <p><Link to="/grades">All grades</Link></p>
      <h1>Assignment feedback</h1>
      {!graded && <Card title="Status" actions={<Badge tone={s.tone}>{s.label}</Badge>}><p role="status" aria-live="polite">{g.message ?? s.blurb}</p></Card>}
      {graded && (<>
        <Card title={g.passed ? 'You passed this assignment' : g.passed === false ? 'You did not reach the pass mark' : 'Your grade'} actions={<Badge tone={s.tone}>{s.label}</Badge>}>
          <Progress value={Math.round(g.finalPercent ?? 0)} label="Score" />
          <p><strong>{pct(g.finalPercent)}</strong>{typeof g.passMark === 'number' && <span className="muted"> · pass mark {pct(g.passMark)}</span>}</p>
          {!!g.latePenaltyPercent && <p className="note warn">A late-submission penalty of {pct(g.latePenaltyPercent)} was applied (score before the penalty: {pct(g.rawPercent)}).</p>}
          <p className="muted">Graded by: {g.gradedBy}.{g.gradedBy?.startsWith('AI') ? ' This is an automated evaluation; you can ask a teacher to review it (below).' : ''}</p>
          {g.state === 'APPEALED' && <p className="note warn" role="status">Your appeal is under review. The grade shown is the original one until a teacher decides.</p>}
        </Card>
        <Card title="Rubric">
          <ul className="plain">{g.dimensions!.map((d) => (
            <li key={d.id} className="dim"><div className="row"><h3>{d.name ?? d.id}</h3><span className="strong">{d.score} / {d.max}</span></div>
              {d.rationale && <p>{d.rationale}</p>}
              {d.evidence.length > 0 && <details><summary>Where in your work ({d.evidence.length})</summary>{d.evidence.map((e, i) => <blockquote key={i}>&ldquo;{e.quote}&rdquo;{e.location && <footer className="muted">{e.location}</footer>}</blockquote>)}</details>}
            </li>))}</ul>
        </Card>
        {g.feedback && <Card title="Feedback"><p className="qtext">{g.feedback}</p></Card>}
        <Card title="Disagree with this grade?">
          {g.appeal?.appealed || appealed ? <p className="note ok" role="status">You have appealed this grade. A teacher who was not involved will review it and you will be notified.</p>
            : g.appeal?.eligible ? (
              <form onSubmit={(e) => { e.preventDefault(); void appeal(); }}>
                <p className="muted">{appealWindow(g.appeal.deadline)} You can appeal once per grade.</p>
                <label htmlFor="ap">Explain what you think was missed or wrong (at least 20 characters)</label>
                <textarea id="ap" rows={5} value={reason} onChange={(e) => setReason(e.target.value)} />
                <ErrorNote error={error} /><button type="submit" disabled={busy || reason.trim().length < 20}>Submit appeal</button>
              </form>)
              : <p className="muted">{g.state === 'FINAL' ? 'This grade is final.' : appealWindow(g.appeal?.deadline) || 'This grade cannot be appealed.'}</p>}
        </Card>
      </>)}
      {error && !graded ? <ErrorNote error={error} /> : null}
    </div>
  );
}
