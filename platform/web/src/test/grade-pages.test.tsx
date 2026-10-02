import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GradeDetail from '../pages/GradeDetail';
import Grades from '../pages/Grades';
import { api } from '../api/client';
import { appealWindow, describeState, pct } from '../lib/grades';
import { notificationLink, notificationText } from '../lib/format';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; headers: any; body: any }[] = [];
type H = (c: { body: any; headers: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(init.body) : undefined; calls.push({ method, url, headers: init?.headers ?? {}, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, headers: init?.headers ?? {}, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); });

const future = (days: number) => new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString();
const graded = (o: any = {}) => ({ submissionId: 'S1', topicId: 'T1', state: 'GRADED', finalPercent: 52.5, rawPercent: 75, latePenaltyPercent: 30, passed: false, passMark: 60, gradedBy: 'AI (automated)', feedback: 'Good structure, but the second point needs an example.',
  dimensions: [{ id: 'correctness', name: 'Correctness', score: 3, max: 4, rationale: 'Mostly right.', evidence: [{ quote: 'gating is enforced on the server', location: 'text' }] }, { id: 'clarity', name: 'Clarity', score: 2, max: 4, rationale: 'Some jargon.', evidence: [] }],
  appeal: { eligible: true, deadline: future(5), appealed: false }, ...o });
const page = (id = 'S1', pollMs = 25) => render(<MemoryRouter initialEntries={[`/grades/${id}`]}><Routes><Route path="/grades/:submissionId" element={<GradeDetail pollMs={pollMs} />} /><Route path="/grades" element={<p>LIST</p>} /></Routes></MemoryRouter>);

describe('grade helpers', () => {
  it('describes every state in plain language and marks the waiting ones', () => {
    expect(describeState('PENDING_AI')).toMatchObject({ label: 'Being evaluated', pending: true }); expect(describeState('MODERATION_REQUIRED').pending).toBe(true); expect(describeState('APPEALED').pending).toBe(true);
    expect(describeState('GRADED')).toMatchObject({ tone: 'ok', pending: false }); expect(describeState('SOMETHING_NEW').label).toBe('something new');
  });
  it('formats scores and the appeal window', () => {
    expect(pct(52.54)).toBe('52.5%'); expect(pct(null)).toBe(''); expect(appealWindow(future(3))).toMatch(/3 more days/); expect(appealWindow(new Date(Date.now() + 3_600_000).toISOString())).toMatch(/closes today/);
    expect(appealWindow(new Date(Date.now() - 1000).toISOString())).toMatch(/closed/); expect(appealWindow(null)).toBe(''); expect(appealWindow('garbage')).toBe('');
  });
  it('maps assignment notifications to the grade page', () => {
    expect(notificationLink('assignment.graded', { submissionId: 'S9' })).toBe('/grades/S9'); expect(notificationLink('topic.completed', { submissionId: 'S9' })).toBeNull(); expect(notificationLink('assignment.graded')).toBeNull();
    expect(notificationText('assignment.appeal_decided')).toMatch(/appeal/); expect(notificationLink('exam.submitted', { attemptId: 'A1' })).toBe('/exam-results/A1'); expect(notificationLink('exam.registered', { attemptId: 'A1' })).toBeNull(); expect(notificationText('exam.result_released')).toMatch(/released/);
  });
});

describe('GradeDetail', () => {
  it('shows score, the late penalty, the rubric with the evidence quoted from the learner, feedback, and that an AI graded it', async () => {
    route({ 'GET /v1/me/submissions/S1': () => res(200, graded()) }); page();
    expect(await screen.findByText('You did not reach the pass mark')).toBeInTheDocument(); expect(screen.getByText('52.5%')).toBeInTheDocument(); expect(screen.getByText(/pass mark 60%/)).toBeInTheDocument();
    expect(screen.getByText(/late-submission penalty of 30%/)).toHaveTextContent(/score before the penalty: 75%/); expect(screen.getByText(/automated evaluation/)).toBeInTheDocument();
    expect(screen.getByText('Correctness')).toBeInTheDocument(); expect(screen.getByText('3 / 4')).toBeInTheDocument(); expect(screen.getByText(/gating is enforced on the server/)).toBeInTheDocument(); expect(screen.getByText(/needs an example/)).toBeInTheDocument();
  });
  it('does not call a teacher grade automated, and omits the penalty note when there is none', async () => {
    route({ 'GET /v1/me/submissions/S1': () => res(200, graded({ gradedBy: 'Teacher', latePenaltyPercent: 0, finalPercent: 80, passed: true })) }); page();
    expect(await screen.findByText('You passed this assignment')).toBeInTheDocument(); expect(screen.queryByText(/automated evaluation/)).toBeNull(); expect(screen.queryByText(/late-submission/)).toBeNull();
  });
  it('waits patiently while evaluating and updates itself when the grade arrives (no manual refresh)', async () => {
    route({ 'GET /v1/me/submissions/S1': ({ n }) => (n < 3 ? res(200, { submissionId: 'S1', topicId: 'T1', state: 'PENDING_AI', message: 'Your submission is being evaluated.' }) : res(200, graded({ latePenaltyPercent: 0 }))) }); page();
    expect(await screen.findByText('Being evaluated')).toBeInTheDocument(); expect(screen.getByText('Your submission is being evaluated.')).toBeInTheDocument(); expect(screen.queryByText('Rubric')).toBeNull();
    expect(await screen.findByText('Rubric', undefined, { timeout: 3000 })).toBeInTheDocument(); const gets = calls.filter((c) => c.method === 'GET').length; await new Promise((r) => setTimeout(r, 120)); expect(calls.filter((c) => c.method === 'GET').length).toBe(gets); // polling stops once graded
  });
  it('says a teacher is reviewing when moderation is required', async () => {
    route({ 'GET /v1/me/submissions/S1': () => res(200, { submissionId: 'S1', topicId: 'T1', state: 'MODERATION_REQUIRED', message: 'Your submission is being reviewed by a teacher.' }) }); page(); expect(await screen.findByText('With a teacher')).toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent(/teacher/);
  });
  it('requires a real explanation, sends the appeal once with a retry-safe key, and then shows it as appealed', async () => {
    route({ 'GET /v1/me/submissions/S1': ({ n }) => res(200, n === 1 ? graded() : graded({ state: 'APPEALED', appeal: { eligible: false, deadline: future(5), appealed: true } })), 'POST /v1/me/submissions/S1/appeal': () => res(201, { taskId: 't', state: 'APPEALED' }) });
    const u = userEvent.setup(); page(); const btn = await screen.findByRole('button', { name: 'Submit appeal' }); expect(btn).toBeDisabled(); expect(screen.getByText(/5 more days/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(/Explain what you think/), 'too short'); expect(btn).toBeDisabled(); await u.clear(screen.getByLabelText(/Explain what you think/)); await u.type(screen.getByLabelText(/Explain what you think/), 'My second paragraph gives an example that was not credited.'); await u.click(btn);
    expect(await screen.findByText(/You have appealed this grade/)).toBeInTheDocument(); expect(screen.getByText(/appeal is under review/)).toBeInTheDocument(); const ap = calls.find((c) => c.url.endsWith('/appeal'))!; expect(ap.body.reason).toMatch(/second paragraph/); expect(ap.headers['Idempotency-Key']).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Submit appeal' })).toBeNull();
  });
  it('shows the server reason when an appeal is refused and keeps what the learner wrote', async () => {
    route({ 'GET /v1/me/submissions/S1': () => res(200, graded()), 'POST /v1/me/submissions/S1/appeal': () => res(409, { message: 'appeal window has closed' }) });
    const u = userEvent.setup(); page(); await u.type(await screen.findByLabelText(/Explain what you think/), 'I believe the evidence I quoted supports full marks.'); await u.click(screen.getByRole('button', { name: 'Submit appeal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('appeal window has closed'); expect(screen.getByLabelText(/Explain what you think/)).toHaveValue('I believe the evidence I quoted supports full marks.');
  });
  it('explains why there is no appeal: final grade, closed window', async () => {
    route({ 'GET /v1/me/submissions/S1': () => res(200, graded({ state: 'FINAL', appeal: { eligible: false, deadline: null, appealed: false } })) }); page(); expect(await screen.findByText('This grade is final.')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Submit appeal' })).toBeNull();
  });
  it('shows a clear error for a submission that is not yours or does not exist', async () => {
    route({ 'GET /v1/me/submissions/NOPE': () => res(404, { message: 'Not Found' }) }); page('NOPE'); expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Grades list', () => {
  it('lists submissions with topic titles, states and scores, newest first as served', async () => {
    route({ 'GET /v1/me/submissions': () => res(200, [{ submissionId: 'S2', topicId: 'T2', attemptNo: 1, submittedAt: '2026-10-01T10:00:00Z', state: 'PENDING_AI' }, { submissionId: 'S1', topicId: 'T1', attemptNo: 2, submittedAt: '2026-09-30T10:00:00Z', state: 'GRADED', finalPercent: 82, passed: true }]),
      'GET /v1/me/entitlements': () => res(200, [{ id: 'E1', learningAccess: true }]), 'GET /v1/me/entitlements/E1/progress': () => res(200, { entitlementId: 'E1', percentComplete: 0, topics: [{ topicId: 'T1', title: 'Sensors' }, { topicId: 'T2', title: 'Networks' }] }) });
    render(<MemoryRouter><Grades /></MemoryRouter>); expect(await screen.findByRole('link', { name: /Sensors \(attempt 2\)/ })).toHaveAttribute('href', '/grades/S1'); expect(screen.getByText('Being evaluated')).toBeInTheDocument(); expect(screen.getByText('82%')).toBeInTheDocument(); expect(screen.getByText(/passed/)).toBeInTheDocument();
  });
  it('has a helpful empty state', async () => {
    route({ 'GET /v1/me/submissions': () => res(200, []), 'GET /v1/me/entitlements': () => res(200, []) }); render(<MemoryRouter><Grades /></MemoryRouter>); expect(await screen.findByText(/not submitted any assignments/)).toBeInTheDocument();
  });
  it('still lists grades when a course title cannot be loaded', async () => {
    route({ 'GET /v1/me/submissions': () => res(200, [{ submissionId: 'S1', topicId: 'T1', state: 'FINAL', finalPercent: 40, passed: false }]), 'GET /v1/me/entitlements': () => res(200, [{ id: 'E1', learningAccess: true }]), 'GET /v1/me/entitlements/E1/progress': () => res(500, {}) });
    render(<MemoryRouter><Grades /></MemoryRouter>); await waitFor(() => expect(screen.getByRole('link', { name: 'Assignment' })).toBeInTheDocument()); expect(screen.getByText(/not passed/)).toBeInTheDocument();
  });
});
