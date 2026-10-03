import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GradeChanges from '../staff/GradeChanges';
import OverrideCase from '../staff/OverrideCase';
import SubmissionHistory from '../staff/SubmissionHistory';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { OverrideCase as Case, PolicyDims, SubmissionHistory as History } from '../api/types';
import { changeText, decideBlock, passText, previewPercent, proposeBlock, sideEffects, startingScores, validateProposal } from '../lib/gradechanges';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); window.confirm = vi.fn(() => true); });
const signIn = (roles: string[], id = 'me') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/gradechanges" element={<GradeChanges />} /><Route path="/staff/gradechanges/overrides/:overrideId" element={<OverrideCase />} /><Route path="/staff/gradechanges/submissions/:submissionId" element={<SubmissionHistory />} /></Routes></Gate></AuthProvider></MemoryRouter>);

const POLICY: PolicyDims = { passPercent: 60, unlockOn: 'SUBMISSION', dimensions: [{ id: 'correctness', name: 'Correctness', min: 0, max: 4, weight: 60 }, { id: 'clarity', name: 'Clarity', min: 0, max: 4, weight: 40 }] };
const ocase = (o: Partial<Case> = {}): Case => ({ id: 'o1', status: 'PENDING', reason: 'Committee decision', feedback: 'Re-marked', decisionReason: null, createdAt: '2030-01-01T00:00:00Z', decidedAt: null, proposedById: 'prop', proposedByName: 'Pat Proposer', decidedByName: null,
  submission: { id: 's1', attemptNo: 2, submittedAt: '2030-01-01T00:00:00Z', state: 'GRADED', topic: 'Sensors', programme: 'AI (AIML)', learnerName: 'Lena Learner' }, policy: POLICY,
  current: { seq: 1, kind: 'AI', dimensions: [{ id: 'correctness', score: 2 }, { id: 'clarity', score: 2 }], rawPercent: 50, finalPercent: 50, passed: false }, proposed: { dimensions: [{ id: 'correctness', score: 4, rationale: '' }, { id: 'clarity', score: 3, rationale: '' }], rawPercent: 90, latePenaltyPercent: 10, finalPercent: 80, passed: true }, ...o });
const hist = (o: Partial<History> = {}): History => ({ submission: { id: 's1', attemptNo: 2, submittedAt: '2030-01-01T00:00:00Z', contentHash: 'abcdef0123456789abcd', topic: 'Sensors', learnerName: 'Lena Learner' }, policy: POLICY, grade: { state: 'GRADED', finalPercent: 50, passed: false, appealDeadline: null },
  records: [{ seq: 1, kind: 'AI', dimensions: [{ id: 'correctness', score: 2, max: 4 }, { id: 'clarity', score: 2, max: 4 }], rawPercent: 50, latePenaltyPercent: 0, finalPercent: 50, passed: false, createdAt: '2030-01-01T00:00:00Z', reason: null } as any], tasks: [], overrides: [], ...o });

describe('grade change helpers', () => {
  it('tells who may decide, what changes and what approving does', () => {
    expect(decideBlock({ status: 'PENDING', proposedById: 'a' }, 'a')).toMatch(/proposed this override/); expect(decideBlock({ status: 'PENDING', proposedById: 'a' }, 'b')).toBeNull(); expect(decideBlock({ status: 'APPROVED', proposedById: 'a' }, 'b')).toMatch(/already been decided/);
    expect(changeText(50, 80)).toBe('50% → 80% (+30 points)'); expect(changeText(80, 50)).toBe('80% → 50% (-30 points)'); expect(changeText(null, 80)).toBe('to 80%'); expect(passText(false, true)).toBe('Changes from fail to pass'); expect(passText(true, false)).toBe('Changes from pass to fail'); expect(passText(true, true)).toBe('Passes'); expect(passText(null, false)).toBe('Does not pass');
    expect(sideEffects('APPEALED')).toMatch(/settles it/); expect(sideEffects('GRADED')).toBeNull(); expect(proposeBlock('PENDING_AI')).toMatch(/not been graded/); expect(proposeBlock('GRADED')).toBeNull();
  });
  it('validates a proposal: every score in range and in half points, something must change, and a reason', () => {
    const cur = [{ id: 'correctness', score: 2 }, { id: 'clarity', score: 2 }]; expect(startingScores(POLICY, cur)).toEqual({ correctness: '2', clarity: '2' });
    expect(validateProposal(POLICY, { scores: { correctness: '3', clarity: '2' }, feedback: '', reason: 'why' }, cur)).toEqual([]);
    expect(validateProposal(POLICY, { scores: { correctness: '2', clarity: '2' }, feedback: '', reason: 'why' }, cur)[0]).toMatch(/same as the current/); expect(validateProposal(POLICY, { scores: { correctness: '5', clarity: '2.2' }, feedback: '', reason: '' }, cur).join(' ')).toMatch(/Between 0 and 4.*half-point.*reason/s); expect(validateProposal(POLICY, { scores: { correctness: '', clarity: 'x' }, feedback: '', reason: 'r' }, cur).join(' ')).toMatch(/Enter a score.*Enter a number/s);
    expect(previewPercent(POLICY, { correctness: '4', clarity: '2' })).toBe(80); expect(previewPercent(POLICY, { correctness: '', clarity: '' })).toBe(0);
  });
});

describe('grade changes desk', () => {
  it('lists overrides waiting for approval with names and the current grade, and links to the case', async () => {
    route({ ...signIn(['ASSESSMENT_ADMIN']), 'GET /v1/grading/overrides?status=PENDING': () => res(200, [{ id: 'o1', submissionId: 's1', status: 'PENDING', reason: 'Committee decision', decisionReason: null, createdAt: '2030-01-01T00:00:00Z', decidedAt: null, proposedById: 'p', proposedByName: 'Pat Proposer', decidedByName: null, topic: 'Sensors', learnerName: 'Lena Learner', attemptNo: 2, currentPercent: 50 }]) });
    mount('/staff/gradechanges'); expect(await screen.findByRole('link', { name: 'Lena Learner: Sensors (attempt 2)' })).toHaveAttribute('href', '/staff/gradechanges/overrides/o1'); expect(screen.getByText(/Currently 50% · proposed by Pat Proposer/)).toBeInTheDocument(); expect(screen.getByText('Waiting for a second person')).toBeInTheDocument();
  });
  it('shows decided overrides, and blocks a role without access before fetching', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/grading/overrides?status=PENDING': () => res(200, []), 'GET /v1/grading/overrides?status=APPROVED,REJECTED': () => res(200, [{ id: 'o2', submissionId: 's2', status: 'APPROVED', reason: 'r', decisionReason: null, createdAt: '2030-01-01T00:00:00Z', decidedAt: '2030-01-02T00:00:00Z', proposedById: 'p', proposedByName: 'Pat', decidedByName: 'Dee', topic: 'T', learnerName: 'L', attemptNo: 1, currentPercent: 80 }]) });
    const { unmount } = mount('/staff/gradechanges'); await userEvent.click(await screen.findByRole('button', { name: 'Decided' })); expect(await screen.findByText(/decided by Dee/)).toBeInTheDocument(); expect(screen.getByText('Approved and applied')).toBeInTheDocument(); unmount(); calls = [];
    route(signIn(['DOUBT_TEACHER'])); mount('/staff/gradechanges'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('grading'))).toBe(false);
  });
  it("finds a learner's work, requiring three letters, and closes appeal windows on request", async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/grading/overrides?status=PENDING': () => res(200, []), 'GET /v1/admin/users?role=LEARNER&q=lena&limit=10': () => res(200, [{ id: 'l1', name: 'Lena Learner', email: 'l@x.test' }]), 'GET /v1/grading/submissions?learnerId=l1': () => res(200, [{ submissionId: 's1', topic: 'Sensors', programme: 'AI (AIML)', attemptNo: 2, submittedAt: '2030-01-01T00:00:00Z', state: 'GRADED', finalPercent: 72.5, passed: true }]), 'POST /v1/grading/sweep': () => res(201, { finalised: 3 }) });
    mount('/staff/gradechanges'); await userEvent.click(await screen.findByRole('button', { name: "Find a learner's work" })); await userEvent.type(screen.getByLabelText(/Find the learner/), 'le'); await userEvent.click(screen.getByRole('button', { name: 'Find' })); expect(await screen.findByText('Type at least 3 letters.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Find the learner/), 'na'); await userEvent.click(screen.getByRole('button', { name: 'Find' })); await userEvent.click(await screen.findByRole('button', { name: 'Lena Learner' })); expect(await screen.findByRole('link', { name: 'Sensors (attempt 2)' })).toHaveAttribute('href', '/staff/gradechanges/submissions/s1'); expect(screen.getByText(/grade 72.5% \(pass\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Make eligible grades final' })); expect(await screen.findByText('3 grades became final because the appeal window had closed.')).toBeInTheDocument();
  });
});

describe('one override', () => {
  const page = (c: Case, extra: Record<string, H> = {}) => ({ [`GET /v1/grading/overrides/${c.id}`]: () => res(200, c), ...extra });
  it('shows the current grade beside the proposed one and approves only after a confirmation', async () => {
    let c = ocase(); route({ ...signIn(['ASSESSMENT_ADMIN'], 'approver'), ...page(c), 'GET /v1/grading/overrides/o1': () => res(200, c), 'POST /v1/grading/overrides/o1/decide': () => { c = ocase({ status: 'APPROVED', decidedByName: 'Sam' }); return res(201, {}); } });
    mount('/staff/gradechanges/overrides/o1'); expect(await screen.findByText('Committee decision')).toBeInTheDocument(); expect(screen.getByText(/50% → 80% \(\+30 points\)/)).toBeInTheDocument(); expect(screen.getByText(/Changes from fail to pass/)).toBeInTheDocument(); expect(screen.getByText(/late penalty of 10% is included/)).toBeInTheDocument(); expect(screen.getByRole('cell', { name: '4 of 4' })).toBeInTheDocument();
    window.confirm = vi.fn(() => false); await userEvent.click(screen.getByRole('button', { name: 'Approve' })); expect(calls.some((c2) => c2.method === 'POST')).toBe(false); window.confirm = vi.fn(() => true); await userEvent.click(screen.getByRole('button', { name: 'Approve' })); expect(await screen.findByText(/Approved\. The grade has changed/)).toBeInTheDocument(); expect(calls.find((c2) => c2.method === 'POST')!.body).toEqual({ decision: 'APPROVE' }); expect(screen.getByText(/This replaced the AI grade \(record 1\)\. Both stay on record/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });
  it('requires a reason to decline, warns the proposer, and keeps a refusal on screen', async () => {
    route({ ...signIn(['ASSESSMENT_ADMIN'], 'prop'), ...page(ocase({ submission: { ...ocase().submission, state: 'APPEALED' } })), 'POST /v1/grading/overrides/o1/decide': () => res(409, { message: 'segregation of duties: the proposer cannot approve their own override' }) });
    mount('/staff/gradechanges/overrides/o1'); expect(await screen.findByText(/You proposed this override/)).toBeInTheDocument(); expect(screen.getByText(/settles it: the grade becomes final/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Decline' })); expect(await screen.findByText(/Write why it is declined/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText(/Reason \(required to decline/), 'No grounds'); await userEvent.click(screen.getByRole('button', { name: 'Decline' })); expect(await screen.findByRole('alert')).toHaveTextContent(/segregation of duties/); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'REJECT', reason: 'No grounds' });
  });
  it('gives an auditor the comparison but no decision', async () => {
    route({ ...signIn(['AUDITOR']), ...page(ocase()) }); mount('/staff/gradechanges/overrides/o1'); expect(await screen.findByText(/can read overrides but not decide/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('a submission', () => {
  it('shows the grade history and proposes a change only with valid scores and a reason', async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/grading/submissions/s1/history': () => res(200, hist()), 'POST /v1/grading/submissions/s1/overrides': () => res(201, { id: 'o9' }) });
    mount('/staff/gradechanges/submissions/s1'); expect(await screen.findByText(/AI grade/)).toBeInTheDocument(); expect(screen.getByText(/grade 50% · pass mark 60%/)).toBeInTheDocument(); expect(screen.queryByText(/Invalid Date/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Propose a change to this grade' })); await userEvent.click(screen.getByRole('button', { name: 'Send for approval' })); expect(await screen.findByText(/same as the current grade/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    const cor = screen.getByLabelText(/Correctness/); await userEvent.clear(cor); await userEvent.type(cor, '4'); expect(screen.getByText('80%', { selector: 'strong' }).textContent).toBe('80%'); await userEvent.click(screen.getByRole('button', { name: 'Send for approval' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Reason for the change/), 'Second marker agrees'); await userEvent.click(screen.getByRole('button', { name: 'Send for approval' })); expect(await screen.findByText(/changes nothing until a different administrator approves/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ dimensions: [{ id: 'correctness', score: 4 }, { id: 'clarity', score: 2 }], reason: 'Second marker agrees' });
  });
  it('offers nothing to propose before the AI has graded, nor to an auditor; offers manual completion only for manual assignments', async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/grading/submissions/s1/history': () => res(200, hist({ grade: { state: 'PENDING_AI', finalPercent: null, passed: null, appealDeadline: null }, records: [] })) }); const a = mount('/staff/gradechanges/submissions/s1'); expect(await screen.findByText(/nothing to override/)).toBeInTheDocument(); a.unmount();
    route({ ...signIn(['AUDITOR']), 'GET /v1/grading/submissions/s1/history': () => res(200, hist()) }); const b = mount('/staff/gradechanges/submissions/s1'); await screen.findByText(/AI grade/); expect(screen.queryByRole('button', { name: 'Propose a change to this grade' })).toBeNull(); b.unmount();
    route({ ...signIn(['ASSESSMENT_ADMIN']), 'GET /v1/grading/submissions/s1/history': () => res(200, hist({ policy: { ...POLICY, unlockOn: 'MANUAL' } })), 'POST /v1/grading/submissions/s1/complete': () => res(201, { ok: true }) }); mount('/staff/gradechanges/submissions/s1');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as done…' })); await userEvent.click(screen.getByRole('button', { name: 'Mark as done' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); await userEvent.type(screen.getByLabelText('Reason'), 'Met in person'); await userEvent.click(screen.getByRole('button', { name: 'Mark as done' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reason: 'Met in person' });
  });
});
