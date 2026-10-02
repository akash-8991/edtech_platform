import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { CheckInResult, ExamInfo } from '../api/types';
import { collectDeviceReport } from '../lib/device';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';

/** Consent, device check and identity, then wait until the exam is READY (identity can be confirmed by the proctoring provider or an invigilator). */
export default function CheckIn() {
  const { examId = '', sessionId = '' } = useParams(); const nav = useNavigate();
  const [exam, setExam] = useState<ExamInfo | null>(null); const [error, setError] = useState<unknown>(null);
  const [agree, setAgree] = useState(false); const [busy, setBusy] = useState(false); const [res, setRes] = useState<CheckInResult | null>(null); const [status, setStatus] = useState<string>('');
  const poll = useRef<ReturnType<typeof setInterval>>();

  const load = useCallback(async () => { try { const all = await api.get<ExamInfo[]>('/v1/me/exams'); const e = all.find((x) => x.examId === examId) ?? null; setExam(e); return e; } catch (err) { setError(err); return null; } }, [examId]);
  useEffect(() => { void load(); return () => clearInterval(poll.current); }, [load]);

  const waitForReady = useCallback(() => {
    clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const e = await load(); const a = e?.attempts.filter((x) => x.status === 'READY' || x.status === 'CHECKED_IN' || x.status === 'IN_PROGRESS').at(-1);
      if (a) { setStatus(a.status); if (a.status === 'READY') clearInterval(poll.current); }
    }, 4000);
  }, [load]);

  // the API does not expose the exam's device policy to learners; remote proctored exams are assumed to need camera and microphone
  const needs = { camera: exam?.mode === 'REMOTE', microphone: exam?.mode === 'REMOTE' };
  const submit = async () => {
    if (!exam) return; setBusy(true); setError(null);
    try {
      const device = await collectDeviceReport(needs);
      const r = await api.post<CheckInResult>(`/v1/exam-sessions/${sessionId}/check-in`, { consent: true, consentHash: exam.consent.hash, device });
      setRes(r); setStatus(r.status); if (r.status !== 'READY') waitForReady();
    } catch (e) { setError(e instanceof ApiError && e.code === 'consent_required' ? new ApiError(400, { message: 'Consent is required to take this exam.' }) : e); } finally { setBusy(false); }
  };

  if (!exam) return error ? <ErrorNote error={error} /> : <Loading what="Loading" />;
  const attempt = res?.attemptId ?? exam.attempts.find((a) => a.status === 'READY' || a.status === 'CHECKED_IN')?.id;
  return (
    <div>
      <p><Link to="/exams">All exams</Link></p><h1>Check in: {exam.title}</h1>
      {!res && (<>
        <Card title="1. Consent">
          <p>{exam.consent.text}</p>
          <label className="choice"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I have read this and I consent.</label>
        </Card>
        <Card title="2. Device check">
          <p>When you continue, your browser may ask to use your <strong>camera</strong> and <strong>microphone</strong>, and we measure your connection speed. Close other screens and applications. You need a stable connection for the whole exam.</p>
          <ErrorNote error={error} />
          <button disabled={!agree || busy} onClick={() => void submit()}>{busy ? 'Checking…' : 'Check my device and check in'}</button>
        </Card></>)}
      {res && (<>
        <Card title="Device" actions={<Badge tone={res.device.ok ? 'ok' : 'warn'}>{res.device.ok ? 'Passed' : 'Problems found'}</Badge>}>
          {res.device.ok ? <p>Your device meets the exam requirements.</p> : (<><p className="note warn" role="alert">Fix these and check in again:</p><ul>{res.device.problems.map((p) => <li key={p}>{p}</li>)}</ul><button onClick={() => { setRes(null); setAgree(true); }}>Try the device check again</button></>)}
        </Card>
        <Card title="Identity and readiness" actions={<Badge tone={status === 'READY' ? 'ok' : 'warn'}>{status === 'READY' ? 'Ready' : 'Waiting'}</Badge>}>
          {status === 'READY' ? <p>You are ready. Start when you are comfortable: the clock begins as soon as you press Start.</p>
            : <p role="status" aria-live="polite">{res.mode === 'CENTRE' ? 'Show your photo ID to the invigilator. This page updates automatically.' : 'Waiting for identity verification. This page updates automatically.'}</p>}
          {res.launchUrl && <p><a href={res.launchUrl} target="_blank" rel="noreferrer noopener">Open the proctoring window</a> (keep it open during the exam).</p>}
          <button disabled={status !== 'READY' || !attempt} onClick={() => nav(`/exam-attempts/${attempt}`)}>Start the exam</button>
        </Card></>)}
    </div>
  );
}
