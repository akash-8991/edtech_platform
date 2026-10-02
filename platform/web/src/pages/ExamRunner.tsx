import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, messageFor } from '../api/client';
import type { ExamReceipt, ExamResult, ExamStart, SaveResult } from '../api/types';
import { ExamQuestionView, isAnswered } from '../components/ExamQuestionView';
import { ErrorNote, Loading } from '../components/ui';
import { Autosaver, FatalSaveError, type SaveStatus } from '../lib/autosave';
import { fmtRemaining, ServerClock } from '../lib/clock';
import { watchSignals } from '../lib/signals';

type Phase = 'loading' | 'begin' | 'running' | 'submitting' | 'done';

/**
 * The exam room. The server owns the clock, the paper and the answer sheet; this page shows them, saves continuously (and keeps working
 * through a bad connection), reports focus/full-screen/copy-paste signals for human review, and submits once.
 */
export default function ExamRunner() {
  const { attemptId = '' } = useParams(); const nav = useNavigate();
  const [phase, setPhase] = useState<Phase>('loading'); const [status, setStatus] = useState<string>(''); const [error, setError] = useState<unknown>(null);
  const [exam, setExam] = useState<ExamStart | null>(null); const [answers, setAnswers] = useState<Record<string, unknown>>({}); const [flags, setFlags] = useState<Set<string>>(new Set());
  const [idx, setIdx] = useState(0); const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: 'idle' }); const [remaining, setRemaining] = useState(0);
  const [replaced, setReplaced] = useState(false); const [confirm, setConfirm] = useState(false); const [receipt, setReceipt] = useState<ExamReceipt | null>(null); const [fs, setFs] = useState(true);
  const [announce, setAnnounce] = useState('');
  const clock = useMemo(() => new ServerClock(), []); const token = useRef(''); const saver = useRef<Autosaver | null>(null); const submitted = useRef(false);
  const warned = useRef(new Set<number>());

  // ---- decide what to show from the attempt's real state --------------------------------------------------------------------------------------
  useEffect(() => {
    api.get<ExamResult>(`/v1/me/exam-attempts/${attemptId}`).then((r) => {
      if (r.status === 'SUBMITTED') return nav(`/exam-results/${attemptId}`, { replace: true });
      setStatus(r.status); setPhase(r.status === 'READY' || r.status === 'IN_PROGRESS' ? 'begin' : 'loading');
      if (r.status === 'CHECKED_IN') setError(new ApiError(409, { message: 'Your check-in is not complete yet. Go back and finish the check-in steps.' }));
    }).catch(setError);
  }, [attemptId, nav]);

  const headers = () => ({ 'X-Exam-Session': token.current });
  const buildSaver = useCallback((start: ExamStart) => {
    saver.current?.stop();
    const s = new Autosaver({ attemptId, initialSeq: start.saveSeq ?? 0, initialAnswers: (start.answers ?? {}) as Record<string, unknown>, onStatus: setSaveStatus, onClock: (r: SaveResult) => clock.sync(r.serverTime),
      send: async (body) => {
        try { return await api.request<SaveResult>('PUT', `/v1/exam-attempts/${attemptId}/answers`, { body, headers: headers() }); }
        catch (e) {
          if (e instanceof ApiError && e.status === 409) { if (e.code === 'session_invalid') setReplaced(true); else setError(e); throw new FatalSaveError(e.message); }
          throw e;
        }
      } });
    saver.current = s; setAnswers(s.current); s.start();
  }, [attemptId, clock]);

  // ---- begin: start a READY attempt or resume an IN_PROGRESS one (a user gesture, so full screen can be requested) ------------------------------------
  const begin = async () => {
    setError(null);
    try {
      const data = await api.post<ExamStart>(`/v1/exam-attempts/${attemptId}/${status === 'IN_PROGRESS' ? 'resume' : 'start'}`, status === 'IN_PROGRESS' ? { deviceId: navigator.userAgent.slice(0, 60) } : {});
      token.current = data.sessionToken; clock.sync(data.serverTime); setExam(data); setReplaced(false); buildSaver(data); setPhase('running');
      try { await document.documentElement.requestFullscreen?.(); } catch { /* not allowed: the exam still runs, a reminder is shown */ }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 && /window is not open/i.test(e.message) ? new ApiError(409, { message: 'The exam window is not open yet. You are checked in: come back to this page when the session starts, then press Start.' }) : e);
    }
  };

  // ---- while running: timer, signals, full-screen reminder, leave warning ----------------------------------------------------------------------------
  const submit = useCallback(async (auto = false) => {
    if (submitted.current) return; submitted.current = true; setPhase('submitting'); setConfirm(false); setError(null);
    try {
      await saver.current?.flush();
      const r = await api.request<ExamReceipt>('POST', `/v1/exam-attempts/${attemptId}/submit`, { body: {}, headers: headers() });
      saver.current?.stop(); saver.current?.clearBackup(); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); setReceipt(r); setPhase('done');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && /time is up|SUBMITTED/i.test(e.message)) { saver.current?.stop(); nav(`/exam-results/${attemptId}`, { replace: true }); return; }
      submitted.current = false; setPhase('running'); setError(auto ? new ApiError(0, { message: 'Time is up but the submission did not go through. Keep this page open: we are retrying.' }) : e);
      if (auto) setTimeout(() => void submit(true), 5000);
    }
  }, [attemptId, nav]);

  useEffect(() => {
    if (phase !== 'running' || !exam) return;
    const step = () => {
      const ms = clock.remainingMs(exam.deadlineAt); setRemaining(ms);
      for (const m of [5, 1]) if (ms <= m * 60_000 && ms > 0 && !warned.current.has(m)) { warned.current.add(m); setAnnounce(`${m} minute${m > 1 ? 's' : ''} remaining.`); }
      if (ms <= 0) { clearInterval(tick); void submit(true); }
    };
    const tick = setInterval(step, 500); step(); // show the real remaining time immediately, not 0:00 until the first tick
    const stopSignals = watchSignals((kind) => { void api.request('POST', `/v1/exam-attempts/${attemptId}/signals`, { body: { kind }, headers: headers() }).catch(() => undefined); });
    const onFs = () => setFs(!!document.fullscreenElement); document.addEventListener('fullscreenchange', onFs); setFs(!!document.fullscreenElement);
    const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', leave);
    return () => { clearInterval(tick); stopSignals(); document.removeEventListener('fullscreenchange', onFs); window.removeEventListener('beforeunload', leave); };
  }, [phase, exam, clock, attemptId, submit]);
  useEffect(() => () => saver.current?.stop(), []);

  const setAnswer = (qid: string, v: unknown) => { saver.current?.set(qid, v); setAnswers((a) => ({ ...a, [qid]: v })); };
  const resumeHere = async () => { setError(null); try { const data = await api.post<ExamStart>(`/v1/exam-attempts/${attemptId}/resume`, { deviceId: navigator.userAgent.slice(0, 60) }); token.current = data.sessionToken; clock.sync(data.serverTime); setExam(data); setReplaced(false); buildSaver({ ...data, answers: { ...(data.answers ?? {}) } }); } catch (e) { setError(e); } };

  // ---- render --------------------------------------------------------------------------------------------------------------------------------------------
  if (phase === 'loading') return error ? <div><ErrorNote error={error} /><p><Link to="/exams">Back to exams</Link></p></div> : <Loading what="Loading your exam" />;
  if (phase === 'begin') return (
    <div className="exam-begin"><h1>{status === 'IN_PROGRESS' ? 'Resume your exam' : 'Start your exam'}</h1>
      <ul><li>The timer is controlled by the server and keeps running if you close this page.</li><li>Your answers are saved automatically; you can see the save status at the top.</li>
        <li>Leaving the window, exiting full screen, copying or pasting is recorded for review.</li><li>Do not open the exam in another window: that ends this one.</li></ul>
      <ErrorNote error={error} /><button onClick={() => void begin()}>{status === 'IN_PROGRESS' ? 'Resume exam' : 'Start exam and begin the timer'}</button>
      <p><Link to="/exams">Not now</Link></p></div>);
  if (phase === 'done' && receipt) return (
    <div className="card" role="status"><h1>Exam submitted</h1><p>Your answers are recorded{receipt.autoSubmitted ? ' (submitted automatically when time ran out)' : ''}. You answered {receipt.answered} question(s).</p>
      <p>Keep your receipt code: <strong className="mono">{receipt.receiptCode}</strong></p><p className="muted">Results are released after review. You will be notified.</p>
      <Link to={`/exam-results/${attemptId}`}>View status</Link> · <Link to="/exams">Back to exams</Link></div>);
  if (!exam) return <Loading />;

  const q = exam.questions[idx]; const answered = exam.questions.filter((x) => isAnswered(answers[x.id])).length; const unanswered = exam.questions.length - answered;
  const low = remaining <= 5 * 60_000;
  return (
    <div className="exam">
      <div className="watermark" aria-hidden="true">{Array.from({ length: 24 }, (_, i) => <span key={i}>{exam.watermark}</span>)}</div>
      <div className="exam-bar" role="region" aria-label="Exam status">
        <span className={`timer ${low ? 'low' : ''}`} role="timer" aria-label="Time remaining">{fmtRemaining(remaining)}</span>
        <span className="muted" role="status" aria-live="polite">{saveText(saveStatus)}</span>
        <button className="secondary" onClick={() => setConfirm(true)} disabled={phase === 'submitting'}>Submit exam</button>
      </div>
      <p className="sr-only" aria-live="assertive">{announce}</p>
      {!fs && <p className="note warn" role="alert">You have left full screen. This is recorded. <button className="link" onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}>Return to full screen</button></p>}
      {replaced && <p className="note error" role="alert">This exam was opened in another window, so this one has been paused. <button onClick={() => void resumeHere()}>Continue here instead</button></p>}
      <ErrorNote error={error} />
      <nav aria-label="Question navigator" className="palette">{exam.questions.map((x, i) => <button key={x.id} className={`pal ${i === idx ? 'cur' : ''} ${isAnswered(answers[x.id]) ? 'ans' : ''} ${flags.has(x.id) ? 'flag' : ''}`} aria-label={`Question ${i + 1}${isAnswered(answers[x.id]) ? ', answered' : ', not answered'}${flags.has(x.id) ? ', flagged' : ''}`} aria-current={i === idx} onClick={() => setIdx(i)}>{i + 1}</button>)}</nav>
      <ExamQuestionView q={q} n={idx + 1} total={exam.questions.length} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} flagged={flags.has(q.id)} onFlag={() => setFlags((f) => { const n = new Set(f); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })} />
      <div className="row"><button className="secondary" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>Previous</button><span className="muted">{answered} of {exam.questions.length} answered</span><button disabled={idx === exam.questions.length - 1} onClick={() => setIdx(idx + 1)}>Next</button></div>
      {confirm && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="sub-t"><div className="modal-body">
          <h3 id="sub-t">Submit your exam?</h3>
          <p>{unanswered ? <><strong>{unanswered}</strong> question(s) are unanswered.</> : 'You have answered every question.'} {flags.size ? `${flags.size} flagged for review. ` : ''}You cannot change your answers after submitting.</p>
          <div className="choices"><button autoFocus onClick={() => void submit(false)}>Yes, submit now</button><button className="secondary" onClick={() => setConfirm(false)}>Go back</button></div>
        </div></div>)}
    </div>
  );
}
const saveText = (s: SaveStatus) => s.state === 'saved' ? `All answers saved at ${new Date(s.at).toLocaleTimeString()}` : s.state === 'saving' ? 'Saving…'
  : s.state === 'retrying' ? 'Connection problem. Your answers are kept on this device and will be sent when the connection returns.' : s.state === 'closed' ? 'Saving has stopped.' : 'Answers are saved automatically.';
export { messageFor };
