import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExamSetup from '../staff/ExamSetup';
import ExamNew from '../staff/ExamNew';
import ExamDefinition from '../staff/ExamDefinition';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { BankCoverage, ExamDetail } from '../api/types';
import { blankExam, blueprintStatus, eligibilityLines, lineText, publishBlock, toBody, toLines, validateAccommodation, validateExam, validateSession } from '../lib/examsetup';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); window.confirm = vi.fn(() => true); });
const signIn = (roles: string[], id = 'me') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/examsetup" element={<ExamSetup />} /><Route path="/staff/examsetup/new" element={<ExamNew />} /><Route path="/staff/examsetup/exams/:examId" element={<ExamDefinition />} /></Routes></Gate></AuthProvider></MemoryRouter>);

const SETUP = { changeFrozen: false, versions: [{ versionId: 'v1', programmeId: 'p1', code: 'FIN', title: 'Finance', version: 2 }] };
const COV: BankCoverage[] = [{ tag: 'ledgers', difficulty: 2, count: 12 }, { tag: 'ledgers', difficulty: 4, count: 3 }, { tag: 'tax', difficulty: 3, count: 4 }];
const exam = (o: Partial<ExamDetail> = {}): ExamDetail => ({ id: 'e1', code: 'FIN-1', title: 'Finance final', status: 'DRAFT', durationMin: 60, passPercent: 50, maxAttempts: 2, cooldownDays: 7, shuffle: true, eligibility: { minProgrammePercent: 100, requiredLabs: 'ALL_MANDATORY', requireAssignmentsReleased: true, blockOnConfirmedIntegrityConcern: true }, blueprint: [{ tag: 'ledgers', count: 5 }], proctoring: { mode: 'REMOTE', requireId: true, requireDevice: true, device: { camera: true, microphone: true, singleScreen: true } }, publishedAt: null, programme: { id: 'p1', code: 'FIN', title: 'Finance', version: 2 }, createdById: 'creator', createdByName: 'Cara Creator', approvedByName: null, blueprintCheck: { errors: [], warnings: [] }, changeFrozen: false, ...o });
const idx = (sessions: any[] = []) => [{ id: 'e1', code: 'FIN-1', title: 'Finance final', status: 'DRAFT', durationMin: 60, passPercent: 50, publishedAt: null, sessions }];

describe('exam set-up helpers', () => {
  const ok = () => ({ ...blankExam(), versionId: 'v1', code: 'FIN-1', lines: [{ tag: 'ledgers', count: '5', minDifficulty: '', maxDifficulty: '' }] });
  it('validates the form with every problem at once, including what the bank cannot supply', () => {
    expect(validateExam(ok(), COV)).toEqual([]);
    const bad = { ...ok(), versionId: '', code: 'x', durationMin: '5', passPercent: '0', maxAttempts: '9', cooldownDays: '-1', minProgrammePercent: '120', labs: 'LIST' as const, labList: ' ', minAssignmentAverage: '150', lines: [{ tag: 'ledgers', count: '0', minDifficulty: '4', maxDifficulty: '2' }, { tag: '', count: '3', minDifficulty: '', maxDifficulty: '' }] };
    const out = validateExam(bad, COV); expect(out.length).toBeGreaterThanOrEqual(10); expect(out.join(' ')).toMatch(/Choose the course/); expect(out.join(' ')).toMatch(/exam code/); expect(out.join(' ')).toMatch(/10 to 300/); expect(out.join(' ')).toMatch(/lab codes/); expect(out.join(' ')).toMatch(/easiest level cannot be above/); expect(out.join(' ')).toMatch(/choose a topic tag/);
    expect(validateExam({ ...ok(), lines: [{ tag: 'tax', count: '9', minDifficulty: '', maxDifficulty: '' }] }, COV).join(' ')).toMatch(/needs 9 questions but the bank has 4/);
    expect(validateExam({ ...ok(), lines: [{ tag: 'tax', count: '2', minDifficulty: '', maxDifficulty: '' }, { tag: 'tax', count: '1', minDifficulty: '', maxDifficulty: '' }] }, COV).join(' ')).toMatch(/appears twice/); expect(validateExam({ ...ok(), lines: [] }, COV).join(' ')).toMatch(/at least one section/);
  });
  it('counts what the bank supplies per section and warns about overlap', () => {
    const s = blueprintStatus([{ tag: 'ledgers', count: 5 }, { tag: 'ledgers', count: 5, minDifficulty: 4 }, { tag: 'ledgers', count: 8 }, { tag: 'none', count: 1 }], COV); expect(s[0]).toMatchObject({ have: 15, errors: [], warnings: [] }); expect(s[1].errors[0]).toMatch(/has 3/); expect(s[2].warnings[0]).toMatch(/overlap/); expect(s[3].have).toBe(0);
  });
  it('builds exactly the body the server expects', () => {
    const b = toBody({ ...ok(), title: '  ', labs: 'LIST', labList: 'L1, L2', minAssignmentAverage: '60', mode: 'CENTRE', lines: [{ tag: 'ledgers', count: '5', minDifficulty: '2', maxDifficulty: '' }] });
    expect(b).toMatchObject({ versionId: 'v1', code: 'FIN-1', title: 'FIN-1', durationMin: 90, passPercent: 50, eligibility: { requiredLabs: ['L1', 'L2'], minAssignmentAveragePercent: 60, minProgrammePercent: 100 }, proctoring: { mode: 'CENTRE', device: { camera: true } }, blueprint: [{ tag: 'ledgers', count: 5, minDifficulty: 2 }] }); expect(toLines({ ...ok(), lines: [{ tag: '', count: '1', minDifficulty: '', maxDifficulty: '' }] })).toEqual([]);
    expect(lineText({ tag: 'tax', count: 3, minDifficulty: 2 })).toBe('3 × tax (difficulty 2–5)'); expect(eligibilityLines(exam().eligibility)).toEqual(expect.arrayContaining(['All mandatory labs completed', 'No open academic-integrity case']));
  });
  it('knows when an exam cannot be published by this person and validates sittings and accommodations', () => {
    expect(publishBlock(exam(), 'me')).toBeNull(); expect(publishBlock(exam(), 'creator')).toMatch(/different administrator/); expect(publishBlock(exam({ status: 'PUBLISHED' }), 'me')).toMatch(/Only a draft/); expect(publishBlock(exam({ changeFrozen: true }), 'me')).toMatch(/frozen/); expect(publishBlock(exam({ blueprintCheck: { errors: ['x'], warnings: [] } }), 'me')).toMatch(/cannot fill every section/);
    const now = Date.parse('2030-01-01T00:00:00Z'); const s = { startsAt: '2030-02-01T09:00', endsAt: '2030-02-01T11:00', centre: '', capacity: '100' };
    expect(validateSession(s, 60, 'REMOTE', now)).toBeNull(); expect(validateSession({ ...s, startsAt: '' }, 60, 'REMOTE', now)).toMatch(/Choose when/); expect(validateSession({ ...s, startsAt: '2029-01-01T09:00', endsAt: '2029-01-01T11:00' }, 60, 'REMOTE', now)).toMatch(/future/); expect(validateSession({ ...s, endsAt: '2030-02-01T09:30' }, 60, 'REMOTE', now)).toMatch(/at least as long as the exam \(60 minutes\)/); expect(validateSession(s, 60, 'CENTRE', now)).toMatch(/which centre/); expect(validateSession({ ...s, capacity: '0' }, 60, 'REMOTE', now)).toMatch(/Capacity/);
    expect(validateAccommodation({ learnerId: '', type: 'EXTRA_TIME', percent: '25', reason: 'x' })).toMatch(/Choose the learner/); expect(validateAccommodation({ learnerId: 'u', type: 'EXTRA_TIME', percent: '0', reason: 'x' })).toMatch(/1 to 100/); expect(validateAccommodation({ learnerId: 'u', type: 'BREAKS', percent: '', reason: ' ' })).toMatch(/Write the reason/); expect(validateAccommodation({ learnerId: 'u', type: 'BREAKS', percent: '', reason: 'doctor' })).toBeNull();
  });
});

describe('exam set-up desk', () => {
  it('lists exams, offers a new one to administrators only, and warns during a change freeze', async () => {
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/setup': () => res(200, { ...SETUP, changeFrozen: true }), 'GET /v1/exam-ops/exams': () => res(200, idx()) }); const { unmount } = mount('/staff/examsetup');
    expect(await screen.findByRole('link', { name: /Finance final/ })).toHaveAttribute('href', '/staff/examsetup/exams/e1'); expect(await screen.findByText(/Exam changes are frozen/)).toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'Define a new exam' })).toBeNull(); unmount();
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/exam-ops/setup': () => res(200, SETUP), 'GET /v1/exam-ops/exams': () => res(200, idx()) }); mount('/staff/examsetup'); await screen.findByRole('link', { name: /Finance final/ }); expect(screen.queryByRole('link', { name: 'Define a new exam' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Question bank' })).toBeNull();
  });
  it('sends a role with no access home before fetching', async () => {
    route(signIn(['LAB_COORDINATOR'])); mount('/staff/examsetup'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('exam'))).toBe(false);
  });
  it('shows the bank with what it holds and the answer key, adds a question with a tag, and retires one with a reason', async () => {
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/setup': () => res(200, SETUP), 'GET /v1/exam-ops/exams': () => res(200, []), 'GET /v1/exams/bank/p1/coverage': () => res(200, COV), 'GET /v1/exams/bank/p1/questions?limit=50': () => res(200, [{ id: 'q1', tag: 'ledgers', difficulty: 2, type: 'MCQ_SINGLE', text: 'Debits go on the…', options: ['left', 'right'], answer: 0, tolerance: 0, points: 1, status: 'ACTIVE', usedCount: 3, createdAt: '2030-01-01T00:00:00Z' }]), 'POST /v1/exams/bank/p1/questions': () => res(201, { added: 1 }), 'POST /v1/exams/bank/questions/q1/retire': () => res(201, {}) });
    mount('/staff/examsetup'); await userEvent.click(await screen.findByRole('button', { name: 'Question bank' })); expect(await screen.findByText('Debits go on the…')).toBeInTheDocument(); expect(screen.getByText('✓ left')).toBeInTheDocument(); expect(screen.getByText('answer key', { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add a question' })); await userEvent.click(screen.getByRole('button', { name: 'Add to the bank' })); expect(await screen.findByText(/topic tag/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText('Topic tag'), 'ledgers'); await userEvent.type(screen.getByLabelText('Question'), 'Credits go on the…'); const opts = screen.getAllByLabelText(/Option \d text/); await userEvent.type(opts[0], 'left'); await userEvent.type(opts[1], 'right'); await userEvent.click(screen.getAllByLabelText('Option 2 is correct')[0]); await userEvent.click(screen.getByRole('button', { name: 'Add to the bank' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/questions'))).toBe(true)); expect(calls.find((c) => c.url.endsWith('/p1/questions') && c.method === 'POST')!.body).toEqual({ questions: [{ type: 'MCQ_SINGLE', text: 'Credits go on the…', tag: 'ledgers', difficulty: 2, options: ['left', 'right'], answer: 1, tolerance: 0, points: 1 }] });
    await userEvent.click(screen.getByRole('button', { name: 'Retire this question…' })); await userEvent.click(screen.getByRole('button', { name: 'Retire' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); await userEvent.type(screen.getByLabelText(/Why it is being retired/), 'Ambiguous'); await userEvent.click(screen.getByRole('button', { name: 'Retire' })); await waitFor(() => expect(calls.some((c) => c.url.endsWith('/retire'))).toBe(true)); expect(calls.find((c) => c.url.endsWith('/retire'))!.body).toEqual({ reason: 'Ambiguous' });
  });
  it('grants an accommodation to a learner found by search, and withdraws one with a reason', async () => {
    const row = { id: 'a1', learnerId: 'l1', learnerName: 'Lena Learner', learnerEmail: 'lena@x.test', examId: null, type: 'EXTRA_TIME', extraTimePercent: 25, reason: 'Dyslexia', approvedByName: 'Eve', active: true, createdAt: '2030-01-01T00:00:00Z' };
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/setup': () => res(200, SETUP), 'GET /v1/exam-ops/exams': () => res(200, []), 'GET /v1/exams/accommodations?active=true': () => res(200, [row]), 'GET /v1/admin/users?role=LEARNER&q=lena&limit=10': () => res(200, [{ id: 'l2', name: 'Lena Other', email: 'lo@x.test' }]), 'POST /v1/exams/accommodations': () => res(201, {}), 'POST /v1/exams/accommodations/a1/deactivate': () => res(201, { ok: true }) });
    mount('/staff/examsetup'); await userEvent.click(await screen.findByRole('button', { name: 'Accommodations' })); expect(await screen.findByText('Lena Learner')).toBeInTheDocument(); expect(screen.getByText('Extra time (+25%)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Grant an accommodation' })); await userEvent.type(screen.getByLabelText(/Find the learner/), 'le'); await userEvent.click(screen.getByRole('button', { name: 'Find' })); expect(await screen.findByText('Type at least 3 letters.')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('admin/users'))).toBe(false);
    await userEvent.type(screen.getByLabelText(/Find the learner/), 'na'); await userEvent.click(screen.getByRole('button', { name: 'Find' })); await userEvent.click(await screen.findByRole('button', { name: 'Lena Other' })); await userEvent.selectOptions(screen.getByLabelText('Kind', { selector: '#ga-t' }), 'EXTRA_TIME'); await userEvent.click(screen.getByRole('button', { name: 'Grant' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Reason, for example/), 'Documented need'); await userEvent.click(screen.getByRole('button', { name: 'Grant' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/accommodations'))).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ learnerId: 'l2', type: 'EXTRA_TIME', extraTimePercent: 25, reason: 'Documented need' });
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw…' })); await userEvent.type(screen.getByLabelText('Why it is withdrawn'), 'Resolved'); await userEvent.click(screen.getByRole('button', { name: 'Withdraw' })); await waitFor(() => expect(calls.some((c) => c.url.endsWith('/deactivate'))).toBe(true));
  });
});

describe('defining an exam', () => {
  it('builds a draft from the form, checking the bank per section, and opens it', async () => {
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/setup': () => res(200, SETUP), 'GET /v1/exams/bank/p1/coverage': () => res(200, COV), 'POST /v1/exams': () => res(201, { id: 'e9' }), 'GET /v1/exam-ops/exams/e9': () => res(200, exam({ id: 'e9' })), 'GET /v1/exam-ops/exams': () => res(200, idx()) });
    mount('/staff/examsetup/new'); await screen.findByRole('heading', { name: 'Define an exam' }); await userEvent.click(screen.getByRole('button', { name: 'Save as a draft' })); expect(await screen.findByText(/exam code must be/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText('Exam code'), 'FIN-1'); await userEvent.selectOptions(await screen.findByLabelText(/Section 1: topic/), 'tax'); await userEvent.clear(screen.getByLabelText('Questions')); await userEvent.type(screen.getByLabelText('Questions'), '9'); expect(await screen.findByText('Not enough questions')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Save as a draft' })); expect(await screen.findByText(/needs 9 questions but the bank has 4/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Questions')); await userEvent.type(screen.getByLabelText('Questions'), '2'); expect(await screen.findByText('Enough questions')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Save as a draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ versionId: 'v1', code: 'FIN-1', durationMin: 90, blueprint: [{ tag: 'tax', count: 2 }], proctoring: { mode: 'REMOTE' }, eligibility: { requiredLabs: 'ALL_MANDATORY' } }); expect(await screen.findByRole('heading', { name: /Finance final/ })).toBeInTheDocument();
  });
  it('explains when nothing can be defined: frozen, or no published course; and keeps non-administrators out', async () => {
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/setup': () => res(200, { ...SETUP, changeFrozen: true }) }); const a = mount('/staff/examsetup/new'); expect(await screen.findByText(/frozen right now/)).toBeInTheDocument(); a.unmount();
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/setup': () => res(200, { changeFrozen: false, versions: [] }) }); const b = mount('/staff/examsetup/new'); expect(await screen.findByText(/none is published yet/)).toBeInTheDocument(); b.unmount(); calls = [];
    route({ ...signIn(['AUDITOR']), 'GET /v1/exam-ops/setup': () => res(200, SETUP), 'GET /v1/exam-ops/exams': () => res(200, []) }); mount('/staff/examsetup/new'); expect(await screen.findByRole('heading', { name: 'Exam set-up' })).toBeInTheDocument(); expect(screen.queryByRole('heading', { name: 'Define an exam' })).toBeNull(); expect(screen.queryByRole('link', { name: 'Define a new exam' })).toBeNull();
  });
});

describe('one exam', () => {
  const page = (e: ExamDetail, sessions: any[] = [], extra: Record<string, H> = {}) => ({ [`GET /v1/exam-ops/exams/${e.id}`]: () => res(200, e), 'GET /v1/exam-ops/exams': () => res(200, idx(sessions)), ...extra });
  it('lets a different administrator publish after confirming, and tells the creator they cannot', async () => {
    let e = exam(); route({ ...signIn(['EXAM_ADMIN'], 'other'), ...page(e), 'GET /v1/exam-ops/exams/e1': () => res(200, e), 'POST /v1/exams/e1/publish': () => { e = exam({ status: 'PUBLISHED', approvedByName: 'Olu' }); return res(201, {}); } }); const { unmount } = mount('/staff/examsetup/exams/e1');
    expect(await screen.findByText('The question bank covers every section.')).toBeInTheDocument(); window.confirm = vi.fn(() => false); await userEvent.click(screen.getByRole('button', { name: 'Publish' })); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    window.confirm = vi.fn(() => true); await userEvent.click(screen.getByRole('button', { name: 'Publish' })); expect(await screen.findByText(/Published\. You can now schedule/)).toBeInTheDocument(); expect(await screen.findByRole('button', { name: 'Schedule a sitting' })).toBeInTheDocument(); unmount();
    route({ ...signIn(['EXAM_ADMIN'], 'creator'), ...page(exam()) }); mount('/staff/examsetup/exams/e1'); expect(await screen.findByText(/You defined this exam/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });
  it("blocks publishing when the bank cannot fill a section and lists the server's issues if it refuses anyway", async () => {
    route({ ...signIn(['EXAM_ADMIN'], 'other'), ...page(exam({ blueprintCheck: { errors: ['Section "ledgers": needs 5 questions, bank has 2'], warnings: [] } })) }); const { unmount } = mount('/staff/examsetup/exams/e1'); expect(await screen.findByText(/needs 5 questions, bank has 2/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled(); unmount();
    route({ ...signIn(['EXAM_ADMIN'], 'other'), ...page(exam()), 'POST /v1/exams/e1/publish': () => res(400, { error: 'blueprint_not_satisfiable', issues: ['section "tax": needs 9 questions, bank has 4'] }) }); mount('/staff/examsetup/exams/e1'); await userEvent.click(await screen.findByRole('button', { name: 'Publish' })); expect(await screen.findByText(/section "tax": needs 9 questions/)).toBeInTheDocument();
  });
  it('schedules a sitting, checking the window against the exam length, and shows existing sittings', async () => {
    const e = exam({ status: 'PUBLISHED' }); route({ ...signIn(['EXAM_ADMIN']), ...page(e, [{ id: 's1', startsAt: '2031-01-01T09:00:00Z', endsAt: '2031-01-01T12:00:00Z', mode: 'REMOTE', centre: null, capacity: 50, status: 'SCHEDULED', attempts: { total: 12 } }]), 'POST /v1/exams/e1/sessions': () => res(201, {}) });
    mount('/staff/examsetup/exams/e1'); expect(await screen.findByText(/Remote, online/, { selector: 'td' })).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Schedule a sitting' })); await userEvent.click(screen.getByRole('button', { name: 'Schedule' })); expect(await screen.findByText(/Choose when the window opens/)).toBeInTheDocument();
    const s = screen.getByLabelText('Window opens'), en = screen.getByLabelText('Window closes'); await userEvent.type(s, '2031-06-01T09:00'); await userEvent.type(en, '2031-06-01T09:30'); await userEvent.click(screen.getByRole('button', { name: 'Schedule' })); expect(await screen.findByText(/at least as long as the exam \(60 minutes\)/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.clear(en); await userEvent.type(en, '2031-06-01T11:00'); await userEvent.click(screen.getByRole('button', { name: 'Schedule' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ mode: 'REMOTE', capacity: 100 });
  });
  it('lets a releaser grant an exception only with a learner and a reason; an exam admin cannot', async () => {
    const e = exam({ status: 'PUBLISHED' }); route({ ...signIn(['ACADEMIC_ADMIN']), ...page(e), 'GET /v1/exams/e1/eligibility-overrides': () => res(200, [{ id: 'o1', learnerName: 'Lena', learnerEmail: 'l@x.test', reason: 'Completed elsewhere', approvedByName: 'Ann', createdAt: '2030-01-01T00:00:00Z' }]), 'GET /v1/admin/users?role=LEARNER&q=lena&limit=10': () => res(200, [{ id: 'l2', name: 'Lena Two', email: 'l2@x.test' }]), 'POST /v1/exams/e1/eligibility-overrides': () => res(201, {}) });
    const { unmount } = mount('/staff/examsetup/exams/e1'); expect(await screen.findByText(/Completed elsewhere/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Schedule a sitting' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Grant the exception' })); expect(await screen.findByText('Choose the learner.')).toBeInTheDocument(); await userEvent.type(screen.getByLabelText(/Find the learner/), 'lena'); await userEvent.click(screen.getByRole('button', { name: 'Find' })); await userEvent.click(await screen.findByRole('button', { name: 'Lena Two' }));
    await userEvent.click(screen.getByRole('button', { name: 'Grant the exception' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); await userEvent.type(screen.getByLabelText(/Reason \(recorded/), 'Passed the partner exam'); await userEvent.click(screen.getByRole('button', { name: 'Grant the exception' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ learnerId: 'l2', reason: 'Passed the partner exam' }); unmount();
    route({ ...signIn(['EXAM_ADMIN']), ...page(e) }); mount('/staff/examsetup/exams/e1'); await screen.findByRole('button', { name: 'Schedule a sitting' }); expect(screen.queryByText('Exceptions to who may sit it')).toBeNull();
  });
});
