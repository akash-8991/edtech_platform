import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Quiz } from '../components/Quiz';
import { Assignment } from '../components/Assignment';
import Login from '../pages/Login';
import Topic from '../pages/Topic';
import { Routes, Route } from 'react-router-dom';
import { api } from '../api/client';
import { AuthProvider } from '../auth';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { url: string; init: any }[] = [];
const route = (map: Record<string, (init: any) => Response>) => vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => { const url = String(u); calls.push({ url, init: init ?? {} }); const k = Object.keys(map).find((m) => url.startsWith(m.split(' ')[1]) && (init?.method ?? 'GET') === m.split(' ')[0]); return k ? map[k](init) : res(404, { message: `no route ${url}` }); }));
beforeEach(() => { calls = []; api.clear(); });

describe('Quiz', () => {
  const start = { attemptId: 'att-1', questions: [{ id: 'q1', type: 'MCQ_SINGLE', text: 'Pick b', options: ['a', 'b'] }, { id: 'q2', type: 'NUMERIC', text: '2+2' }, { id: 'q3', type: 'MCQ_MULTI', text: 'Pick all', options: ['x', 'y', 'z'] }] };
  it('blocks submission until everything is answered, then submits once with a retry-safe key', async () => {
    route({ 'POST /v1/topics/T/quiz/start': () => res(201, start), 'POST /v1/quiz-attempts/att-1/submit': () => res(201, { passed: true, scorePercent: 100 }) });
    const onDone = vi.fn(); const u = userEvent.setup(); render(<Quiz topicId="T" remaining={2} onDone={onDone} />);
    await u.click(screen.getByRole('button', { name: 'Start quiz' }));
    const submit = await screen.findByRole('button', { name: 'Submit answers' }); expect(submit).toBeDisabled();
    await u.click(screen.getByLabelText('b')); await u.type(screen.getByLabelText(/2\+2/), '4'); expect(submit).toBeDisabled(); await u.click(screen.getByLabelText('x')); await u.click(screen.getByLabelText('z')); expect(submit).toBeEnabled();
    await u.click(submit); expect(await screen.findByText(/Passed/)).toBeInTheDocument(); expect(onDone).toHaveBeenCalled();
    const sub = calls.find((c) => c.url.includes('/submit'))!; expect(JSON.parse(sub.init.body)).toEqual({ answers: { q1: 1, q2: 4, q3: [0, 2] } }); expect(sub.init.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_\-:.]{8,128}$/);
  });
  it('offers another attempt after a fail, and explains when none are left', async () => {
    route({ 'POST /v1/topics/T/quiz/start': () => res(201, { attemptId: 'a', questions: [{ id: 'q1', type: 'NUMERIC', text: 'n' }] }), 'POST /v1/quiz-attempts/a/submit': () => res(201, { passed: false, scorePercent: 0, attemptsRemaining: 0 }) });
    const u = userEvent.setup(); render(<Quiz topicId="T" remaining={1} onDone={() => {}} />); await u.click(screen.getByRole('button', { name: 'Start quiz' })); await u.type(await screen.findByLabelText(/n$/), '9'); await u.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(await screen.findByText(/Not passed/)).toBeInTheDocument(); expect(screen.getByText(/No attempts left/)).toBeInTheDocument();
  });
  it('shows the server reason when the quiz cannot start (e.g. video not watched yet)', async () => {
    route({ 'POST /v1/topics/T/quiz/start': () => res(409, { message: 'watch the video first' }) });
    const u = userEvent.setup(); render(<Quiz topicId="T" remaining={null} onDone={() => {}} />); await u.click(screen.getByRole('button', { name: 'Start quiz' })); expect(await screen.findByRole('alert')).toHaveTextContent('watch the video first');
  });
  it('disables start when no attempts remain', () => { render(<Quiz topicId="T" remaining={0} onDone={() => {}} />); expect(screen.getByRole('button', { name: 'Start quiz' })).toBeDisabled(); });
});

describe('Assignment', () => {
  it('uploads a file then submits with its reference and a stable idempotency key', async () => {
    route({ 'PUT /v1/topics/T/assignment/upload': () => res(200, { key: 'submissions/u/x.pdf', name: 'x.pdf' }), 'POST /v1/topics/T/assignment/submit': () => res(201, { submissionId: 's' }) });
    const onDone = vi.fn(); const u = userEvent.setup(); render(<Assignment topicId="T" instructions="Write." submitted={false} onDone={onDone} />);
    expect(screen.getByRole('button', { name: /Submit assignment/ })).toBeDisabled();
    await u.type(screen.getByLabelText('Your answer'), 'my work'); await u.upload(screen.getByLabelText(/Attach a file/), new File(['%PDF'], 'x.pdf', { type: 'application/pdf' }));
    await u.click(screen.getByRole('button', { name: /Submit assignment/ })); expect(await screen.findByText(/Submitted/)).toBeInTheDocument();
    expect(calls[0].url).toContain('name=x.pdf'); expect(JSON.parse(calls[1].init.body)).toEqual({ text: 'my work', files: [{ key: 'submissions/u/x.pdf', name: 'x.pdf' }] }); expect(calls[1].init.headers['Idempotency-Key']).toBeTruthy(); expect(onDone).toHaveBeenCalled();
  });
  it('keeps the form and shows the reason when the server refuses (quiz not passed)', async () => {
    route({ 'POST /v1/topics/T/assignment/submit': () => res(409, { message: 'pass the quiz first' }) });
    const u = userEvent.setup(); render(<Assignment topicId="T" submitted={false} onDone={() => {}} />); await u.type(screen.getByLabelText('Your answer'), 'x'); await u.click(screen.getByRole('button', { name: /Submit assignment/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('pass the quiz first'); expect(screen.getByLabelText('Your answer')).toHaveValue('x');
  });
  it('shows the recorded state for an already submitted assignment', () => { render(<Assignment topicId="T" submitted onDone={() => {}} />); expect(screen.getByRole('status')).toHaveTextContent(/Submitted/); });
});

describe('Login', () => {
  const ui = () => render(<MemoryRouter><AuthProvider><Login /></AuthProvider></MemoryRouter>);
  it('keeps staff accounts out of the learner portal', async () => {
    route({ 'POST /v1/auth/login': () => res(201, { mfaRequired: true, mfaToken: 't' }), 'POST /v1/auth/refresh': () => res(401, {}) });
    const u = userEvent.setup(); ui(); await u.type(await screen.findByLabelText('Email'), 'admin@x.test'); await u.type(screen.getByLabelText('Password'), 'pw'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/for learners/); expect(api.signedIn).toBe(false);
  });
  it('shows a generic message for wrong credentials and requires both fields', async () => {
    route({ 'POST /v1/auth/login': () => res(401, { error: 'invalid_credentials', message: 'Invalid credentials or account temporarily locked' }) });
    const u = userEvent.setup(); ui(); const btn = await screen.findByRole('button', { name: 'Sign in' }); expect(btn).toBeDisabled();
    await u.type(screen.getByLabelText('Email'), 'a@b.co'); await u.type(screen.getByLabelText('Password'), 'x'); await u.click(btn); expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid credentials/);
  });
});

describe('Topic gating', () => {
  it('explains a locked topic instead of showing an error dump', async () => {
    route({ 'GET /v1/topics/T2': () => res(403, { message: 'topic locked' }), 'GET /v1/me/entitlements/E/progress': () => res(200, { entitlementId: 'E', percentComplete: 0, topics: [] }), 'GET /v1/topics/T2/playback': () => res(403, { message: 'locked' }) });
    render(<MemoryRouter initialEntries={['/courses/E/topics/T2']}><Routes><Route path="/courses/:entitlementId/topics/:topicId" element={<Topic />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/locked/i));
  });
});
