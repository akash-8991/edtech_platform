import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ExamResult } from '../api/types';
import { Badge, Card, ErrorNote, Progress, Hold } from '../components/ui';
import { useT } from '../lib/i18n';

export default function ExamResultPage() {
  const t = useT(); const { attemptId = '' } = useParams(); const [r, setR] = useState<ExamResult | null>(null); const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [appealed, setAppealed] = useState(false);
  useEffect(() => { api.get<ExamResult>(`/v1/me/exam-attempts/${attemptId}`).then(setR).catch(setError); }, [attemptId]);
  const appeal = async () => { setBusy(true); setError(null); try { await api.post(`/v1/me/exam-attempts/${attemptId}/appeal`, { reason: reason.trim() }); setAppealed(true); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (!r) return <Hold title={t('Exam result')} error={error} what={t('Loading your result')} />;
  return (
    <div>
      <p><Link to="/exams">{t('All exams')}</Link></p><h1>{t('Exam result')}</h1>
      {r.receiptCode && <p className="muted">{t('Receipt code:')} <span className="mono">{r.receiptCode}</span></p>}
      {r.state === 'RELEASED' && (
        <Card title={r.passed ? t('You passed') : t('You did not pass')} actions={<Badge tone={r.passed ? 'ok' : 'warn'}>{Math.round(r.percent ?? 0)}%</Badge>}>
          <Progress value={Math.round(r.percent ?? 0)} label={t('Score')} /><p>{t('Your score is {score}%. The pass mark is {mark}%.', { score: Math.round(r.percent ?? 0), mark: r.passMark ?? '' })}</p>
          {r.sections && <><h3>{t('By section')}</h3><ul className="plain">{Object.entries(r.sections).map(([k, v]) => <li key={k} className="row"><span>{k}</span><span>{v.percent}%</span></li>)}</ul></>}
        </Card>)}
      {(r.state === 'UNDER_REVIEW' || r.state === 'AWAITING_RELEASE') && <Card title={t('Result pending')}><p role="status">{r.message}</p><p className="muted">{t('You will be notified when it is released. You do not need to do anything.')}</p></Card>}
      {r.state === 'INVALIDATED' && (
        <Card title={t('Attempt invalidated')} actions={<Badge tone="warn">{t('Integrity review')}</Badge>}>
          <p role="status">{r.message}</p>{r.reason && <p>{t('Reason: {reason}', { reason: r.reason })}</p>}
          {appealed ? <p className="note ok" role="status">{t('Your appeal has been submitted. A reviewer who was not involved will look at it.')}</p> : r.appeal?.eligible ? (
            <form onSubmit={(e) => { e.preventDefault(); void appeal(); }}>
              <label htmlFor="ap">{t('Why do you believe this is wrong? (at least 20 characters)')}</label><textarea id="ap" rows={5} value={reason} onChange={(e) => setReason(e.target.value)} />
              <ErrorNote error={error} /><button type="submit" disabled={busy || reason.trim().length < 20}>{t('Submit appeal')}</button></form>) : <p className="muted">{t('An appeal has already been filed or the appeal window has closed.')}</p>}
        </Card>)}
      {!r.state && <Card><p>{t('This attempt has not been submitted (status: {status}).', { status: r.status.toLowerCase().replace(/_/g, ' ') })} <Link to={`/exam-attempts/${attemptId}`}>{t('Open it')}</Link>.</p></Card>}
    </div>
  );
}
