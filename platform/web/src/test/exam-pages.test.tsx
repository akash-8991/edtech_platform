import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExamRunner from '../pages/ExamRunner';
import Exams from '../pages/Exams';
import ExamResultPage from '../pages/ExamResult';
import CheckIn from '../pages/CheckIn';
import { api } from '../api/client';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; headers: any; body: any }[] = [];
type H = (c: { body: any; headers: any }) => Response;
const route = (map: Record<string, H>) => vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(init.body) : undefined; calls.push({ method, url, headers: init?.headers ?? {}, body });
  const k = Object.keys(map).find((m) => m.split(' ')[0] === method && url === m.split(' ')[1]); return k ? map[k]({ body, headers: init?.headers ?? {} }) : res(404, { message: `no route ${method} ${url}` });
}));
beforeEach(() => { calls = []; api.clear(); api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); });

const Q = [
  { id: 'q1', type: 'MCQ_SINGLE', text: 'Pick the second', options: ['A', 'B', 'C'], points: 2 },
  { id: 'q2', type: 'MCQ_MULTI', text: 'Pick two', options: ['A', 'B', 'C'], points: 3 },
  { id: 'q3', type: 'NUMERIC', text: 'Ten', options: [], points: 1 },
];
const start = (over: any = {}) => ({ attemptId: 'AT1', sessionToken: 'TOK1', serverTime: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(), watermark: 'WM-123', questions: Q, ...over });
const runner = (path = '/exam-attempts/AT1') => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/exam-attempts/:attemptId" element={<ExamRunner />} /><Route path="/exam-results/:attemptId" element={<p>RESULT PAGE</p>} /><Route path="/exams" element={<p>EXAMS</p>} /></Routes></MemoryRouter>);
const base = (status: string, extra: Record<string, H> = {}) => ({ 'GET /v1/me/exam-attempts/AT1': () => res(200, { attemptId: 'AT1', status }), ...extra });

describe('ExamRunner', () => {
  it('starts a READY attempt, shows the server paper with a watermark, and saves answers with the exam-session header and increasing seq', async () => {
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(201, start()), 'PUT /v1/exam-attempts/AT1/answers': ({ body }) => res(200, { saved: true, saveSeq: body.seq, remainingMs: 1, serverTime: new Date().toISOString() }) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ }));
    expect(await screen.findByText('Pick the second')).toBeInTheDocument(); expect(document.querySelector('.watermark')).toHaveTextContent('WM-123'); expect(screen.getByRole('timer')).toHaveTextContent(/^(29|30):/);
    await u.click(screen.getByLabelText('B')); await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true), { timeout: 4000 });
    const put = calls.find((c) => c.method === 'PUT')!; expect(put.headers['X-Exam-Session']).toBe('TOK1'); expect(put.body).toEqual({ seq: 1, answers: { q1: 1 } });
    expect(await screen.findByText(/All answers saved/)).toBeInTheDocument();
  });
  it('navigates with the palette, shows answered state, and the confirm dialog counts what is unanswered', async () => {
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(201, start()), 'PUT /v1/exam-attempts/AT1/answers': ({ body }) => res(200, { saved: true, saveSeq: body.seq, remainingMs: 1, serverTime: new Date().toISOString() }) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ })); await u.click(await screen.findByLabelText('C'));
    await u.click(screen.getByRole('button', { name: /Question 1, answered/ })); await u.click(screen.getByRole('button', { name: 'Next' })); await u.click(screen.getByLabelText('A')); await u.click(screen.getByLabelText('C'));
    await u.click(screen.getByLabelText('Flag for review')); expect(screen.getByRole('button', { name: /Question 2, answered, flagged/ })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Submit exam' })); const dlg = await screen.findByRole('dialog'); expect(dlg).toHaveTextContent(/1\s*question\(s\) are unanswered/); expect(dlg).toHaveTextContent(/1 flagged/);
    await u.click(within(dlg).getByRole('button', { name: 'Go back' })); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('submits once after flushing saves, shows the receipt, and clears the local backup', async () => {
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(201, start()), 'PUT /v1/exam-attempts/AT1/answers': ({ body }) => res(200, { saved: true, saveSeq: body.seq, remainingMs: 1, serverTime: new Date().toISOString() }),
      'POST /v1/exam-attempts/AT1/submit': ({ headers }) => (headers['X-Exam-Session'] === 'TOK1' ? res(201, { receiptCode: 'RCPT-9', submittedAt: new Date().toISOString(), autoSubmitted: false, answered: 1 }) : res(409, {})) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ })); await u.click(await screen.findByLabelText('B'));
    expect(localStorage.getItem('edtech.exam.AT1')).toContain('"q1":1'); await u.click(screen.getByRole('button', { name: 'Submit exam' })); await u.click(await screen.findByRole('button', { name: 'Yes, submit now' }));
    expect(await screen.findByText('RCPT-9')).toBeInTheDocument(); const order = calls.map((c) => c.method + c.url.split('/').pop()); expect(order.indexOf('PUTanswers')).toBeLessThan(order.indexOf('POSTsubmit')); expect(calls.filter((c) => c.url.endsWith('/submit')).length).toBe(1); expect(localStorage.getItem('edtech.exam.AT1')).toBeNull();
  });
  it('submits automatically when the SERVER clock says time is up, even if the learner never clicks', async () => {
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(201, start({ deadlineAt: new Date(Date.now() + 1200).toISOString() })), 'POST /v1/exam-attempts/AT1/submit': () => res(201, { receiptCode: 'AUTO-1', submittedAt: 'x', autoSubmitted: true, answered: 0 }) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ }));
    expect(await screen.findByText('AUTO-1', undefined, { timeout: 5000 })).toBeInTheDocument(); expect(screen.getByText(/submitted automatically/)).toBeInTheDocument();
  });
  it('a different laptop clock cannot extend the exam (deadline is judged against server time)', async () => {
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(201, start({ serverTime: new Date(Date.now() + 10 * 60_000).toISOString(), deadlineAt: new Date(Date.now() + 10 * 60_000 + 20 * 60_000).toISOString() })) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ })); await screen.findByText('Pick the second'); await waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent(/^(19|20):/));
  });
  it('another window taking over pauses this one with a way to continue here; resume restores saved answers', async () => {
    let first = true;
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(201, start()), 'PUT /v1/exam-attempts/AT1/answers': () => (first ? res(409, { error: 'session_invalid', message: 'opened elsewhere' }) : res(200, { saved: true, saveSeq: 3, remainingMs: 1, serverTime: new Date().toISOString() })),
      'POST /v1/exam-attempts/AT1/resume': () => { first = false; return res(201, start({ sessionToken: 'TOK2', saveSeq: 2, answers: { q1: 0 } })); } }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ })); await u.click(await screen.findByLabelText('B'));
    expect(await screen.findByText(/opened in another window/, undefined, { timeout: 5000 })).toBeInTheDocument(); await u.click(screen.getByRole('button', { name: 'Continue here instead' }));
    await waitFor(() => expect(screen.queryByText(/opened in another window/)).toBeNull()); expect(screen.getByLabelText('B')).toBeChecked(); expect(screen.getByLabelText('A')).not.toBeChecked(); // the server copy said A, but the learner's newer unsent answer B wins
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.headers['X-Exam-Session'] === 'TOK2')).toBe(true), { timeout: 4000 }); const re = calls.find((c) => c.method === 'PUT' && c.headers['X-Exam-Session'] === 'TOK2')!; expect(re.body).toEqual({ seq: 3, answers: { q1: 1 } }); // continues the server's sequence, resends the unsent answer
  });
  it('reports focus loss, copy and paste as signals', async () => {
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(201, start()), 'POST /v1/exam-attempts/AT1/signals': () => res(201, { ok: true }) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ })); await screen.findByText('Pick the second');
    window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('copy')); await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/signals')).map((c) => c.body.kind).sort()).toEqual(['COPY', 'FOCUS_LOST']));
    expect(calls.find((c) => c.url.endsWith('/signals'))!.headers['X-Exam-Session']).toBe('TOK1');
  });
  it('resumes an IN_PROGRESS attempt (rotating the session) and goes straight to results when already submitted', async () => {
    route(base('IN_PROGRESS', { 'POST /v1/exam-attempts/AT1/resume': () => res(201, start({ sessionToken: 'T9', saveSeq: 4, answers: { q3: 10 } })) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: 'Resume exam' })); await u.click(await screen.findByRole('button', { name: /Question 3, answered/ })); expect(screen.getByLabelText(/Your answer/)).toHaveValue(10);
    route({ 'GET /v1/me/exam-attempts/AT1': () => res(200, { attemptId: 'AT1', status: 'SUBMITTED' }) }); document.body.innerHTML = ''; runner(); expect(await screen.findByText('RESULT PAGE')).toBeInTheDocument();
  });
  it('explains a session that has not opened yet instead of showing a raw server message', async () => {
    route(base('READY', { 'POST /v1/exam-attempts/AT1/start': () => res(409, { message: 'the exam window is not open' }) }));
    const u = userEvent.setup(); runner(); await u.click(await screen.findByRole('button', { name: /Start exam/ })); expect(await screen.findByRole('alert')).toHaveTextContent(/not open yet.*come back/s); expect(screen.getByRole('button', { name: /Start exam/ })).toBeInTheDocument();
  });
  it('refuses to start before check-in is complete', async () => {
    route(base('CHECKED_IN')); runner(); expect(await screen.findByRole('alert')).toHaveTextContent(/check-in is not complete/);
  });
});

describe('Exams list and check-in', () => {
  const exam = (o: any = {}) => ({ examId: 'E1', code: 'FINAL', title: 'Final exam', durationMin: 30, mode: 'REMOTE', passPercent: 60, eligibility: { eligible: true, overridden: false, checks: [{ key: 'programme_progress', ok: true, detail: 'Programme completion 100% (need 100%)' }, { key: 'labs', ok: true, detail: 'Required labs completed' }] },
    consent: { text: 'I consent to monitoring.', hash: 'HASH1' }, sessions: [{ id: 'S1', startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7_200_000).toISOString(), mode: 'REMOTE', centre: null, registered: false }], attempts: [], ...o });
  it('explains why you are not eligible and blocks registration', async () => {
    route({ 'GET /v1/me/exams': () => res(200, [exam({ eligibility: { eligible: false, overridden: false, checks: [{ key: 'programme_progress', ok: false, detail: 'Programme completion 60% (need 100%)' }, { key: 'labs', ok: true, detail: 'Required labs completed' }] } })]) });
    render(<MemoryRouter><Exams /></MemoryRouter>); expect(await screen.findByText('Not yet eligible')).toBeInTheDocument(); expect(screen.getByText(/Programme completion 60% \(need 100%\)/)).toBeInTheDocument(); expect(screen.getByText(/Not met:/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
  });
  it('registers for a session, then offers check-in and cancellation; flags an exam in progress', async () => {
    let registered = false;
    route({ 'GET /v1/me/exams': () => res(200, [exam({ sessions: [{ ...exam().sessions[0], registered }], attempts: registered ? [{ id: 'A9', attemptNo: 1, status: 'IN_PROGRESS', result: null }] : [] })]), 'POST /v1/exams/E1/register': () => { registered = true; return res(201, { ok: true }); } });
    const u = userEvent.setup(); render(<MemoryRouter><Exams /></MemoryRouter>); await u.click(await screen.findByRole('button', { name: 'Register' }));
    expect(await screen.findByText('Registered')).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'Check in' })).toHaveAttribute('href', '/exams/E1/check-in/S1'); expect(screen.getByText(/exam in progress/)).toBeInTheDocument(); expect(calls.find((c) => c.url.endsWith('/register'))!.body).toEqual({ sessionId: 'S1' });
  });
  it('requires consent before check-in, then sends the consent hash and a device report, and waits for READY', async () => {
    let readyAfter = false;
    route({ 'GET /v1/me/exams': () => res(200, [exam({ sessions: [{ ...exam().sessions[0], registered: true }], attempts: [{ id: 'A1', attemptNo: 1, status: readyAfter ? 'READY' : 'CHECKED_IN', result: null }] })]),
      'POST /v1/exam-sessions/S1/check-in': () => { setTimeout(() => (readyAfter = true), 300); return res(201, { attemptId: 'A1', status: 'CHECKED_IN', device: { ok: true, problems: [] }, idCheck: 'PENDING', launchUrl: 'https://proctor.example/s/1', mode: 'REMOTE' }); } });
    const u = userEvent.setup(); render(<MemoryRouter initialEntries={['/exams/E1/check-in/S1']}><Routes><Route path="/exams/:examId/check-in/:sessionId" element={<CheckIn />} /><Route path="/exam-attempts/:attemptId" element={<p>RUNNER</p>} /></Routes></MemoryRouter>);
    const btn = await screen.findByRole('button', { name: /Check my device/ }); expect(btn).toBeDisabled(); await u.click(screen.getByLabelText(/I have read this/)); await u.click(btn);
    expect(await screen.findByText(/Waiting for identity verification/)).toBeInTheDocument(); const ci = calls.find((c) => c.url.endsWith('/check-in'))!; expect(ci.body.consent).toBe(true); expect(ci.body.consentHash).toBe('HASH1'); expect(ci.body.device).toHaveProperty('bandwidthKbps');
    expect(screen.getByRole('link', { name: /proctoring window/ })).toHaveAttribute('rel', expect.stringContaining('noopener')); expect(screen.getByRole('button', { name: 'Start the exam' })).toBeDisabled();
  });
  it('shows device problems with a way to try again', async () => {
    route({ 'GET /v1/me/exams': () => res(200, [exam({ sessions: [{ ...exam().sessions[0], registered: true }] })]), 'POST /v1/exam-sessions/S1/check-in': () => res(201, { attemptId: 'A1', status: 'CHECKED_IN', device: { ok: false, problems: ['camera not available'] }, launchUrl: null, mode: 'REMOTE' }) });
    const u = userEvent.setup(); render(<MemoryRouter initialEntries={['/exams/E1/check-in/S1']}><Routes><Route path="/exams/:examId/check-in/:sessionId" element={<CheckIn />} /></Routes></MemoryRouter>);
    await u.click(await screen.findByLabelText(/I have read this/)); await u.click(screen.getByRole('button', { name: /Check my device/ })); expect(await screen.findByText('camera not available')).toBeInTheDocument(); expect(screen.getByRole('button', { name: /device check again/ })).toBeInTheDocument();
  });
});

describe('ExamResultPage', () => {
  const page = () => render(<MemoryRouter initialEntries={['/exam-results/A1']}><Routes><Route path="/exam-results/:attemptId" element={<ExamResultPage />} /></Routes></MemoryRouter>);
  it('shows score and sections only once released', async () => {
    route({ 'GET /v1/me/exam-attempts/A1': () => res(200, { attemptId: 'A1', status: 'SUBMITTED', receiptCode: 'R1', state: 'RELEASED', percent: 72.4, passed: true, passMark: 60, sections: { sensors: { percent: 80 } } }) });
    page(); expect(await screen.findByText('You passed')).toBeInTheDocument(); expect(screen.getByText(/Your score is 72%/)).toBeInTheDocument(); expect(screen.getByText('sensors')).toBeInTheDocument();
  });
  it('never reveals a score or incident detail while under review', async () => {
    route({ 'GET /v1/me/exam-attempts/A1': () => res(200, { attemptId: 'A1', status: 'SUBMITTED', state: 'UNDER_REVIEW', message: 'Your result is being reviewed.' }) });
    page(); expect(await screen.findByText('Your result is being reviewed.')).toBeInTheDocument(); expect(screen.queryByText(/score/i)).toBeNull();
  });
  it('lets an invalidated attempt be appealed, requiring a real explanation, and confirms', async () => {
    route({ 'GET /v1/me/exam-attempts/A1': () => res(200, { attemptId: 'A1', status: 'SUBMITTED', state: 'INVALIDATED', message: 'Your attempt was invalidated.', appeal: { eligible: true } }), 'POST /v1/me/exam-attempts/A1/appeal': () => res(201, { ok: true }) });
    const u = userEvent.setup(); page(); const btn = await screen.findByRole('button', { name: 'Submit appeal' }); expect(btn).toBeDisabled(); await u.type(screen.getByLabelText(/Why do you believe/), 'My connection dropped twice during the exam.'); await u.click(btn);
    expect(await screen.findByText(/appeal has been submitted/)).toBeInTheDocument(); expect(calls.find((c) => c.url.endsWith('/appeal'))!.body.reason).toMatch(/connection dropped/);
  });
});
