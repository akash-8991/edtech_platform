import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExamOps from '../staff/ExamOps';
import ExamReport from '../staff/ExamReport';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import { bandLabel, barHeights, percent, releaseMessage, skipReason } from '../lib/examops';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string }[] = [];
const route = (map: Record<string, () => Response>) => vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => { const k = `${init?.method ?? 'GET'} ${String(u)}`; calls.push({ method: init?.method ?? 'GET', url: String(u) }); const h = map[k]; return h ? h() : res(404, { message: `no route ${k}` }); }));
beforeEach(() => { calls = []; api.clear(); window.confirm = vi.fn(() => true); });
const signIn = (roles: string[]) => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id: 'u1', email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) }; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/examops" element={<ExamOps />} /><Route path="/staff/examops/exams/:examId/report" element={<ExamReport />} /></Routes></Gate></AuthProvider></MemoryRouter>);
const counts = (o: Partial<Record<string, number>> = {}) => ({ total: 10, inProgress: 0, submitted: 10, held: 1, ready: 3, released: 5, invalidated: 1, ...o });
const exams = (ready = 3) => [{ id: 'e1', code: 'FIN-1', title: 'Finance final', status: 'PUBLISHED', durationMin: 90, passPercent: 50, publishedAt: null, sessions: [{ id: 's1', startsAt: '2030-01-01T09:00:00Z', endsAt: '2030-01-01T11:00:00Z', mode: 'REMOTE', centre: null, capacity: 50, status: 'SCHEDULED', attempts: counts({ ready }) }] }];

describe('result helpers', () => {
  it('words the outcomes plainly', () => {
    expect(releaseMessage({ released: 0, skipped: [] })).toMatch(/Nothing was ready/); expect(releaseMessage({ released: 1, skipped: [] })).toBe('Released 1 result.'); expect(releaseMessage({ released: 2, skipped: [{}] })).toBe('Released 2 results; 1 could not be released.');
    expect(skipReason('not_ready_for_release')).toMatch(/no longer ready/); expect(skipReason('segregation of duties: you adjudicated')).toMatch(/someone else must release/); expect(skipReason('weird')).toBe('weird');
    expect(percent(0.456)).toBe('46%'); expect(percent(null)).toBe('n/a'); expect(barHeights([0, 5, 10])).toEqual([0, 50, 100]); expect(barHeights([0, 0])).toEqual([0, 0]); expect(bandLabel(0)).toBe('0-9'); expect(bandLabel(9)).toBe('90-100');
  });
});

describe('exams and results', () => {
  it('lists exams with session counts and releases the ready results after a confirmation, then shows what was skipped', async () => {
    let n = 0;
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/exam-ops/incidents?status=OPEN%2CNEEDS_INFO': () => res(200, []), 'GET /v1/exam-ops/exams': () => res(200, exams(n ? 1 : 3)), 'POST /v1/exam-ops/sessions/s1/release-ready': () => { n++; return res(201, { released: 2, skipped: [{ attemptId: 'abcdef1234', reason: 'segregation of duties: you adjudicated this attempt' }] }); } });
    mount('/staff/examops'); await userEvent.click(await screen.findByRole('button', { name: 'Exams and results' })); expect(await screen.findByText('Finance final')).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'Results report' })).toHaveAttribute('href', '/staff/examops/exams/e1/report');
    window.confirm = vi.fn(() => false); await userEvent.click(screen.getByRole('button', { name: 'Release 3 ready' })); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    window.confirm = vi.fn(() => true); await userEvent.click(screen.getByRole('button', { name: 'Release 3 ready' })); expect(await screen.findByText('Released 2 results; 1 could not be released.')).toBeInTheDocument(); expect(screen.getByText(/someone else must release it/)).toBeInTheDocument(); expect(await screen.findByRole('button', { name: 'Release 1 ready' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit overdue/ })).not.toBeNull(); // academic admins may run the sweep
  });
  it('offers no release button to a role that cannot release, and no sweep to one that cannot sweep', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/exam-ops/incidents?status=OPEN%2CNEEDS_INFO': () => res(200, []), 'GET /v1/exam-ops/exams': () => res(200, exams()) });
    mount('/staff/examops'); await userEvent.click(await screen.findByRole('button', { name: 'Exams and results' })); expect(await screen.findByText('Finance final')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Release/ })).toBeNull(); expect(screen.queryByRole('button', { name: /Submit overdue/ })).toBeNull();
  });
  it('keeps a refused release visible', async () => {
    route({ ...signIn(['ASSESSMENT_ADMIN']), 'GET /v1/exam-ops/incidents?status=OPEN%2CNEEDS_INFO': () => res(200, []), 'GET /v1/exam-ops/exams': () => res(200, exams()), 'POST /v1/exam-ops/sessions/s1/release-ready': () => res(403, { message: 'Forbidden' }) });
    mount('/staff/examops'); await userEvent.click(await screen.findByRole('button', { name: 'Exams and results' })); await userEvent.click(await screen.findByRole('button', { name: 'Release 3 ready' })); expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
  it('runs the sweep and says what it did', async () => {
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/incidents?status=OPEN%2CNEEDS_INFO': () => res(200, []), 'GET /v1/exam-ops/exams': () => res(200, exams(0)), 'POST /v1/exam-ops/sweep': () => res(201, { autoSubmitted: 2, reportsPolled: 1 }) });
    mount('/staff/examops'); await userEvent.click(await screen.findByRole('button', { name: 'Exams and results' })); await userEvent.click(await screen.findByRole('button', { name: /Submit overdue/ })); expect(await screen.findByText(/Submitted 2 overdue attempts and asked the proctoring provider for 1 missing report\./)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Release/ })).toBeNull();
  });
});

describe('results report', () => {
  const report = { exam: { code: 'FIN-1', passPercent: 50 }, funnel: { registered: 20, checkedIn: 18, started: 17, submitted: 16, released: 10, held: 3, invalidated: 1, autoSubmitted: 2 }, results: { n: 15, mean: 62.5, passRate: 0.8, distribution: [0, 0, 1, 2, 3, 4, 3, 1, 1, 0] }, sections: { Ledgers: 70 }, itemAnalysis: [{ questionId: 'q1234567890', attempts: 15, pValue: 0.2 }],
    integrity: { incidents: 4, byType: { second_person: 3 }, bySeverity: { HIGH: 3 }, byStatus: { DISMISSED: 1, CONFIRMED_MAJOR: 2 }, confirmedRate: 0.125, sessionTakeovers: 1 }, appeals: { filed: 2, overturned: 1, open: 1 } };
  it('shows the funnel, scores, hardest questions, integrity and appeals', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/reports/exams?examId=e1': () => res(200, report) }); mount('/staff/examops/exams/e1/report');
    expect(await screen.findByText('Results report: FIN-1')).toBeInTheDocument(); expect(screen.getByText(/62.5%/)).toBeInTheDocument(); expect(screen.getByText('80%', { selector: 'strong' })).toBeInTheDocument(); expect(screen.getByRole('img', { name: /50-59: 4/ })).toBeInTheDocument();
    expect(screen.getByText('q1234567')).toBeInTheDocument(); expect(screen.getByText('20%')).toBeInTheDocument(); expect(screen.getByText(/Confirmed \(major\)/)).toBeInTheDocument(); expect(screen.getByText(/2 filed|2 filed, 1 overturned/)).toBeInTheDocument();
  });
  it('says plainly when there is nothing scored, and shows a missing exam as an error', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/reports/exams?examId=e1': () => res(200, { ...report, results: { n: 0, mean: null, passRate: null, distribution: new Array(10).fill(0) }, itemAnalysis: [], sections: {} }), 'GET /v1/reports/exams?examId=gone': () => res(404, { message: 'Not found' }) });
    const { unmount } = mount('/staff/examops/exams/e1/report'); expect(await screen.findByText('No scored attempts yet.')).toBeInTheDocument(); expect(screen.queryByRole('img')).toBeNull(); unmount();
    mount('/staff/examops/exams/gone/report'); expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
  it('sends a role without access home without fetching', async () => {
    route(signIn(['LAB_COORDINATOR'])); mount('/staff/examops/exams/e1/report'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('reports'))).toBe(false);
  });
});
