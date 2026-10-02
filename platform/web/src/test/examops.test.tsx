import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExamOps from '../staff/ExamOps';
import ExamCase from '../staff/ExamCase';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import { canSee } from '../lib/roles';
import { evidenceMessage, nextStep, reasonError } from '../lib/examops';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); });
const signIn = (roles: string[]) => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id: 'u1', email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
/** The real app mounts these under StaffShell, which waits for the session to load; do the same here. */
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (ui: JSX.Element, path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/examops" element={ui} /><Route path="/staff/examops/attempts/:attemptId" element={<ExamCase />} /></Routes></Gate></AuthProvider></MemoryRouter>);
const caseFile = (over: any = {}) => ({ attemptId: 'a1', learnerRef: 'ab12cd34', attemptNo: 1, mode: 'REMOTE', status: 'SUBMITTED', resultState: 'HELD', outcome: null, deviceCheck: {}, idCheck: {}, sessionSwitches: 2, autoSubmitted: false, accommodations: [], startedAt: null, submittedAt: null, proctorReportFinal: true,
  incidents: [{ id: 'i1', source: 'PROVIDER', type: 'second_person', severity: 'HIGH', status: 'OPEN', occurredAt: '2030-01-01T10:00:00Z', hasEvidence: true, decisionReason: null }], timeline: [{ seq: 1, type: 'STARTED', at: '2030-01-01T09:00:00Z', payload: {} }], ...over });

describe('exam-ops helpers', () => {
  it('explains the next step from the case state', () => {
    const base = { status: 'SUBMITTED', resultState: 'HELD', outcome: null, proctorReportFinal: true, mode: 'REMOTE', incidents: [] as { status: string }[] };
    expect(nextStep({ ...base, status: 'IN_PROGRESS' })).toMatch(/not been submitted/); expect(nextStep({ ...base, incidents: [{ status: 'OPEN' }] })).toMatch(/open incident/); expect(nextStep({ ...base, incidents: [{ status: 'OPEN' }, { status: 'NEEDS_INFO' }] })).toMatch(/all 2/);
    expect(nextStep({ ...base, resultState: 'READY' })).toMatch(/did not decide/); expect(nextStep({ ...base, resultState: 'RELEASED' })).toMatch(/released/); expect(nextStep({ ...base, resultState: 'INVALIDATED' })).toMatch(/appeal/);
    expect(nextStep({ ...base, incidents: [{ status: 'CONFIRMED_MAJOR' }] })).toMatch(/set the outcome/); expect(nextStep({ ...base, proctorReportFinal: false })).toMatch(/waive/);
    expect(reasonError(' ')).toMatch(/reason/); expect(reasonError('x')).toBeNull(); expect(evidenceMessage({ status: 410 })).toMatch(/expired/); expect(evidenceMessage({ status: 500 })).toBeNull();
  });
  it('shows the area to the roles the server allows', () => { expect(canSee(['EXAM_ADMIN'], 'examops')).toBe(true); expect(canSee(['LAB_COORDINATOR'], 'examops')).toBe(false); });
});

describe('exam integrity queue', () => {
  it('lists open incidents, filters by severity, and links to the case', async () => {
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/exam-ops/incidents?status=OPEN%2CNEEDS_INFO': () => res(200, [{ id: 'i1', attemptId: 'a1', source: 'PROVIDER', type: 'second_person', severity: 'CRITICAL', status: 'OPEN', occurredAt: '2030-01-01T10:00:00Z', hasEvidence: true, ageMinutes: 5 }]),
      'GET /v1/exam-ops/incidents?status=OPEN%2CNEEDS_INFO&severity=LOW': () => res(200, []) });
    mount(<ExamOps />, '/staff/examops');
    expect(await screen.findByText('second person')).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'Open the case' })).toHaveAttribute('href', '/staff/examops/attempts/a1');
    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'LOW'); expect(await screen.findByText(/No open incidents/)).toBeInTheDocument();
  });
  it('sends a role without access back to the staff home before fetching anything', async () => {
    route(signIn(['LAB_COORDINATOR'])); mount(<ExamOps />, '/staff/examops'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('exam-ops'))).toBe(false);
  });
  it('decides an appeal, refusing an empty reason, and keeps a conflict-of-interest message on screen', async () => {
    let n = 0;
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/exam-ops/incidents?status=OPEN%2CNEEDS_INFO': () => res(200, []), 'GET /v1/exam-ops/appeals?status=OPEN': () => res(200, [{ id: 'ap1', attemptId: 'a1', reason: 'The second person was my invigilator', status: 'OPEN', filedAt: '2030-01-02T00:00:00Z' }]),
      'POST /v1/exam-ops/appeals/ap1/decide': () => (++n === 1 ? res(403, { message: 'conflict of interest: you adjudicated the original decision' }) : res(200, { decision: 'UPHELD' })) });
    mount(<ExamOps />, '/staff/examops'); await userEvent.click(await screen.findByRole('button', { name: 'Appeals' })); await userEvent.click(await screen.findByRole('button', { name: 'Decide this appeal' }));
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText(/Reason/), 'Evidence is clear'); await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/conflict of interest/); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'UPHELD', reason: 'Evidence is clear' });
  });
});

describe('exam case file', () => {
  it('records an incident decision with a reason and shows no score', async () => {
    let state = caseFile();
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/exam-ops/attempts/a1/case': () => res(200, state), 'POST /v1/exam-ops/incidents/i1/decide': () => { state = caseFile({ resultState: 'READY', incidents: [{ ...state.incidents[0], status: 'DISMISSED', decisionReason: 'Was a poster' }] }); return res(200, {}); } });
    mount(<ExamOps />, '/staff/examops/attempts/a1'); expect(await screen.findByText(/Decide the open incident first|Decide the open incident/)).toBeInTheDocument(); expect(screen.queryByText(/score/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Decide' })); await userEvent.click(screen.getByRole('button', { name: 'Record decision' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Reason/, { selector: '#why-i1' }), 'Was a poster'); await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    expect(await screen.findByText('Decision recorded.')).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'DISMISSED', reason: 'Was a poster' }); expect(await screen.findByText(/must be released by someone/)).toBeInTheDocument();
  });
  it('reports an expired evidence link plainly', async () => {
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/exam-ops/attempts/a1/case': () => res(200, caseFile()), 'GET /v1/incidents/i1/evidence': () => res(410, { message: 'gone' }) });
    mount(<ExamOps />, '/staff/examops/attempts/a1'); await userEvent.click(await screen.findByRole('button', { name: 'View the evidence' })); expect(await screen.findByText(/evidence link has expired/)).toBeInTheDocument();
  });
  it('opens evidence in a new tab without leaking the opener', async () => {
    route({ ...signIn(['FACULTY_REVIEWER']), 'GET /v1/exam-ops/attempts/a1/case': () => res(200, caseFile()), 'GET /v1/incidents/i1/evidence': () => res(200, { url: 'https://p.test/e', expiresAt: null }) });
    mount(<ExamOps />, '/staff/examops/attempts/a1'); await userEvent.click(await screen.findByRole('button', { name: 'View the evidence' })); const a = await screen.findByRole('link', { name: 'Open the evidence' }); expect(a).toHaveAttribute('target', '_blank'); expect(a.getAttribute('rel')).toContain('noopener');
  });
  it('shows a tamper warning when the log chain is broken', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/exam-ops/attempts/a1/case': () => res(200, caseFile()), 'GET /v1/exam-ops/attempts/a1/verify-log': () => res(200, { events: 9, intact: false, firstBrokenIndex: 4 }) });
    mount(<ExamOps />, '/staff/examops/attempts/a1'); await userEvent.click(await screen.findByRole('button', { name: /Check the log/ })); expect(await screen.findByText('TAMPERED')).toBeInTheDocument(); expect(screen.getByText(/breaks at event 4/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull(); // an auditor reads, never decides
  });
  it('keeps the separation-of-duties refusal on screen when releasing', async () => {
    route({ ...signIn(['ASSESSMENT_ADMIN']), 'GET /v1/exam-ops/attempts/a1/case': () => res(200, caseFile({ resultState: 'READY', incidents: [] })), 'POST /v1/exam-ops/attempts/a1/release': () => res(409, { message: 'segregation of duties: you adjudicated this attempt; another authorised person must release it' }) });
    mount(<ExamOps />, '/staff/examops/attempts/a1'); await userEvent.click(await screen.findByRole('button', { name: 'Release to the learner' })); expect(await screen.findByRole('alert')).toHaveTextContent(/segregation of duties/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Release to the learner' })).toBeEnabled());
  });
  it('only asks a centre proctor for ID checks on centre exams, and requires a note', async () => {
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/attempts/a1/case': () => res(200, caseFile({ mode: 'CENTRE' })), 'POST /v1/proctor/attempts/a1/verify-id': () => res(200, { status: 'VERIFIED' }) });
    mount(<ExamOps />, '/staff/examops/attempts/a1'); await userEvent.click(await screen.findByRole('button', { name: 'Record the check' })); expect(await screen.findByText(/Write a note/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Note'), 'Passport'); await userEvent.click(screen.getByRole('button', { name: 'Record the check' })); expect(await screen.findByText('Identity check recorded.')).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ status: 'VERIFIED', note: 'Passport' });
  });
});

describe('a releaser who cannot read cases', () => {
  it('gets a release-only view, never requests the case file, and sees the refusal when release fails', async () => {
    let state = 'READY';
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/exam-ops/attempts/a1/result': () => res(200, { attemptId: 'a1', resultState: state, outcome: null, score: { percent: 70 }, passed: true }), 'POST /v1/exam-ops/attempts/a1/release': ({ n }) => (n === 1 ? res(409, { message: 'segregation of duties: you adjudicated this attempt' }) : ((state = 'RELEASED'), res(200, {}))) });
    mount(<ExamOps />, '/staff/examops/attempts/a1');
    await userEvent.click(await screen.findByRole('button', { name: 'Release to the learner' })); expect(await screen.findByRole('alert')).toHaveTextContent(/segregation/);
    await userEvent.click(screen.getByRole('button', { name: 'Release to the learner' })); expect(await screen.findByText('Result released to the learner.')).toBeInTheDocument(); expect(calls.some((c) => c.url.endsWith('/case'))).toBe(false); expect(screen.queryByText(/70/)).toBeNull();
  });
});
