import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, messageFor } from '../api/client';
import type { ExamInfo, ExamSessionInfo } from '../api/types';
import { Badge, Card, ErrorNote, Hold } from '../components/ui';
import { fmtDateTime, mark, tr, useT } from '../lib/i18n';

const when = (iso: string) => fmtDateTime(iso);
const ATTEMPT_STATUS: Record<string, string> = { IN_PROGRESS: mark('in progress'), SUBMITTED: mark('submitted'), READY: mark('ready'), CHECKED_IN: mark('checked in'), INVALIDATED: mark('invalidated'), EXPIRED: mark('expired') };

export default function Exams() {
  const t = useT(); const [exams, setExams] = useState<ExamInfo[] | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api.get<ExamInfo[]>('/v1/me/exams').then(setExams).catch(setError), []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => { setBusy(id); setError(null); try { await fn(); await load(); } catch (e) { setError(e); } finally { setBusy(null); } };
  if (!exams) return <Hold title={t('Exams')} error={error} what={t('Loading your exams')} />;
  return (
    <div>
      <h1>{t('Exams')}</h1>
      <ErrorNote error={error} />
      {!exams.length && <Card><p>{t('No exams are available for your courses yet.')}</p></Card>}
      {exams.map((e) => {
        const open = e.attempts.find((a) => a.status === 'IN_PROGRESS');
        const checkedIn = e.attempts.find((a) => a.status === 'CHECKED_IN' || a.status === 'READY');
        return (
          <Card key={e.examId} title={e.title} actions={<Badge tone={e.eligibility.eligible ? 'ok' : 'warn'}>{e.eligibility.eligible ? t('Eligible') : t('Not yet eligible')}</Badge>}>
            <p className="muted">{t('{n} minutes', { n: e.durationMin })} · {t('pass mark {n}%', { n: e.passPercent })} · {e.mode === 'CENTRE' ? t('at a test centre') : t('online, proctored')}{e.eligibility.overridden ? ` · ${t('eligibility granted by an administrator')}` : ''}</p>
            <details open={!e.eligibility.eligible}><summary>{t('Eligibility checklist')}</summary>
              <ul className="steps" aria-label={t('Eligibility checks')}>{e.eligibility.checks.map((c) => <li key={c.key} className={c.ok ? 'done' : ''}><span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> <span className="sr-only">{c.ok ? t('Met:') : t('Not met:')} </span>{c.detail ?? c.key.replace(/_/g, ' ')}</li>)}</ul></details>

            {open && <p className="note warn" role="status">{t('You have an exam in progress.')} <Link to={`/exam-attempts/${open.id}`}>{t('Return to it now')}</Link>{t(': the clock is still running.')}</p>}
            {checkedIn && !open && <p className="note ok">{t('You are checked in.')} <Link to={`/exams/${e.examId}/check-in/${findSession(e, checkedIn.id)?.id ?? ''}`}>{t('Continue check-in')}</Link>.</p>}

            <h3>{t('Sessions')}</h3>
            {!e.sessions.length ? <p className="muted">{t('No sessions are scheduled yet.')}</p> : (
              <ul className="plain">{e.sessions.map((s) => (
                <li key={s.id} className="row session"><span>{t('{from} to {to}', { from: when(s.startsAt), to: when(s.endsAt) })} {s.centre ? `· ${s.centre}` : ''}</span>
                  {s.registered ? <span className="row"><Badge tone="ok">{t('Registered')}</Badge>
                      <Link to={`/exams/${e.examId}/check-in/${s.id}`}>{t('Check in')}</Link>
                      <button className="link" disabled={busy === s.id} onClick={() => void act(s.id, () => api.post(`/v1/exam-sessions/${s.id}/unregister`))}>{t('Cancel registration')}</button></span>
                    : <button disabled={!e.eligibility.eligible || busy === s.id} onClick={() => void act(s.id, () => api.post(`/v1/exams/${e.examId}/register`, { sessionId: s.id }))}>{t('Register')}</button>}
                </li>))}</ul>)}

            {!!e.attempts.length && (<><h3>{t('Your attempts')}</h3><ul className="plain">{e.attempts.map((a) => (
              <li key={a.id} className="row"><span>{t('Attempt {n}: {status}', { n: a.attemptNo, status: tr(ATTEMPT_STATUS[a.status] ?? a.status.toLowerCase().replace(/_/g, ' ')) })}</span>
                {a.status === 'SUBMITTED' && <Link to={`/exam-results/${a.id}`}>{a.result === 'RELEASED' ? t('View result') : t('View status')}</Link>}
                {a.status === 'IN_PROGRESS' && <Link to={`/exam-attempts/${a.id}`}>{t('Resume')}</Link>}</li>))}</ul></>)}
          </Card>);
      })}
      <p className="muted"><Link to="/completion">{t('See your overall programme completion')}</Link></p>
    </div>
  );
}
const findSession = (e: ExamInfo, _attemptId: string): ExamSessionInfo | undefined => e.sessions.find((s) => s.registered);
export { messageFor };
