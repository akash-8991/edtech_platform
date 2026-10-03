import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { GradeView } from '../api/types';
import { Badge, Card, ErrorNote, Progress, Hold } from '../components/ui';
import { appealWindow, describeState, pct } from '../lib/grades';
import { idempotencyKey } from '../lib/format';
import { useT } from '../lib/i18n';

/** One submission's grade: the score, the rubric breakdown with the evidence the grader pointed to, written feedback, and the right to appeal. */
export default function GradeDetail({ pollMs = 15_000 }: { pollMs?: number }) {
  const { submissionId = '' } = useParams(); const t = useT();
  const [g, setG] = useState<GradeView | null>(null); const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [appealed, setAppealed] = useState(false); const [key] = useState(idempotencyKey);
  const load = useCallback(() => api.get<GradeView>(`/v1/me/submissions/${submissionId}`).then((x) => { setG(x); setError(null); }).catch(setError), [submissionId]);
  useEffect(() => { void load(); }, [load]);
  // pending states refresh themselves until a grade arrives
  useEffect(() => { if (!g || !describeState(g.state).pending || g.dimensions) return; const timer = setInterval(() => void load(), pollMs); return () => clearInterval(timer); }, [g, load, pollMs]);

  const appeal = async () => { setBusy(true); setError(null); try { await api.post(`/v1/me/submissions/${submissionId}/appeal`, { reason: reason.trim() }, key); setAppealed(true); await load(); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (!g) return <Hold title={t('Assignment feedback')} error={error} what={t('Loading your grade')} />;
  const s = describeState(g.state); const graded = !!g.dimensions;
  return (
    <div>
      <p><Link to="/grades">{t('All grades')}</Link></p>
      <h1>{t('Assignment feedback')}</h1>
      {!graded && <Card title={t('Status')} actions={<Badge tone={s.tone}>{s.label}</Badge>}><p role="status" aria-live="polite">{g.message ?? s.blurb}</p></Card>}
      {graded && (<>
        <Card title={g.passed ? t('You passed this assignment') : g.passed === false ? t('You did not reach the pass mark') : t('Your grade')} actions={<Badge tone={s.tone}>{s.label}</Badge>}>
          <Progress value={Math.round(g.finalPercent ?? 0)} label={t('Score')} />
          <p><strong>{pct(g.finalPercent)}</strong>{typeof g.passMark === 'number' && <span className="muted"> · {t('pass mark {n}', { n: pct(g.passMark) })}</span>}</p>
          {!!g.latePenaltyPercent && <p className="note warn">{t('A late-submission penalty of {penalty} was applied (score before the penalty: {raw}).', { penalty: pct(g.latePenaltyPercent), raw: pct(g.rawPercent) })}</p>}
          <p className="muted">{t('Graded by: {who}.', { who: g.gradedBy ?? '' })}{g.gradedBy?.startsWith('AI') ? ` ${t('This is an automated evaluation; you can ask a teacher to review it (below).')}` : ''}</p>
          {g.state === 'APPEALED' && <p className="note warn" role="status">{t('Your appeal is under review. The grade shown is the original one until a teacher decides.')}</p>}
        </Card>
        <Card title={t('Rubric')}>
          <ul className="plain">{g.dimensions!.map((d) => (
            <li key={d.id} className="dim"><div className="row"><h3>{d.name ?? d.id}</h3><span className="strong">{d.score} / {d.max}</span></div>
              {d.rationale && <p>{d.rationale}</p>}
              {d.evidence.length > 0 && <details><summary>{t('Where in your work ({n})', { n: d.evidence.length })}</summary>{d.evidence.map((e, i) => <blockquote key={i}>&ldquo;{e.quote}&rdquo;{e.location && <footer className="muted">{e.location}</footer>}</blockquote>)}</details>}
            </li>))}</ul>
        </Card>
        {g.feedback && <Card title={t('Feedback')}><p className="qtext">{g.feedback}</p></Card>}
        <Card title={t('Disagree with this grade?')}>
          {g.appeal?.appealed || appealed ? <p className="note ok" role="status">{t('You have appealed this grade. A teacher who was not involved will review it and you will be notified.')}</p>
            : g.appeal?.eligible ? (
              <form onSubmit={(e) => { e.preventDefault(); void appeal(); }}>
                <p className="muted">{appealWindow(g.appeal.deadline)} {t('You can appeal once per grade.')}</p>
                <label htmlFor="ap">{t('Explain what you think was missed or wrong (at least 20 characters)')}</label>
                <textarea id="ap" rows={5} value={reason} onChange={(e) => setReason(e.target.value)} />
                <ErrorNote error={error} /><button type="submit" disabled={busy || reason.trim().length < 20}>{t('Submit appeal')}</button>
              </form>)
              : <p className="muted">{g.state === 'FINAL' ? t('This grade is final.') : appealWindow(g.appeal?.deadline) || t('This grade cannot be appealed.')}</p>}
        </Card>
      </>)}
      {error && !graded ? <ErrorNote error={error} /> : null}
    </div>
  );
}
