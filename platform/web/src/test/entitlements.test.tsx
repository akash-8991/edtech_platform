import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Entitlements from '../staff/Entitlements';
import EntitlementDetail from '../staff/EntitlementDetail';
import Reports from '../staff/Reports';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { EntitlementDetailData, EntitlementRow } from '../api/types';
import { daysLeft, extendProblem, historyLabel, overrideProblem, statusLabel } from '../lib/entitlements';
import { canSee } from '../lib/roles';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); });
const signIn = (roles: string[]) => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id: 'me', email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) }; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/entitlements" element={<Entitlements />} /><Route path="/staff/entitlements/:entitlementId" element={<EntitlementDetail />} /><Route path="/staff/reports" element={<Reports />} /></Routes></Gate></AuthProvider></MemoryRouter>);
const row = (o: Partial<EntitlementRow> = {}): EntitlementRow => ({ id: 'e1', versionId: 'v1', status: 'ACTIVE', effectiveStatus: 'ACTIVE', learningAccess: true, startAt: '2030-01-01T00:00:00Z', endAt: '2031-01-01T00:00:00Z', cohort: 'C1', duration: 'M12', pauseCount: 0, pausedDays: 0, pausedAt: null, learner: { id: 'l1', name: 'Lena Learner', email: 'lena@x.test' }, programme: { code: 'AI-101', title: 'AI Basics' }, versionNumber: 2, ...o });
const det = (o: Partial<EntitlementDetailData> = {}): EntitlementDetailData => ({ ...row(), pauses: [], exceptions: [], overrides: [], history: [{ seq: 1, action: 'entitlement.paused', actorId: 'a', actorRole: 'SUPPORT_OPERATOR', reason: 'exam leave', createdAt: '2030-02-01T00:00:00Z' }], ...o });
const OUTLINE = { id: 'v1', modules: [{ id: 'm1', title: 'Module 1', position: 1, topics: [{ id: 't1', title: 'Sensors', position: 1, mandatory: true }] }] };

describe('entitlement helpers', () => {
  it('validates the forms and words the history', () => {
    expect(extendProblem('0', 'x')).toMatch(/1 to 365/); expect(extendProblem('400', 'x')).toMatch(/1 to 365/); expect(extendProblem('2.5', 'x')).toMatch(/whole number/); expect(extendProblem('30', ' ')).toMatch(/reason/); expect(extendProblem('30', 'illness')).toBeNull();
    expect(overrideProblem('UNLOCK_TOPIC', '', '1', 'r')).toMatch(/topic/); expect(overrideProblem('EXTRA_QUIZ_ATTEMPTS', 't', '9', 'r')).toMatch(/1 to 5/); expect(overrideProblem('DEADLINE_EXTENSION', 't', '721', 'r')).toMatch(/1 to 720/); expect(overrideProblem('UNLOCK_TOPIC', 't', '', 'r')).toBeNull();
    expect(statusLabel('PAUSED')).toBe('Paused'); expect(historyLabel('entitlement.revoked')).toBe('Revoked'); expect(historyLabel('progression.override.extra_quiz_attempts')).toBe('Progression: Extra quiz attempts'); expect(historyLabel('x.y_z')).toBe('x y z');
    expect(daysLeft('2030-01-11T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'))).toBe(10);
  });
  it('shows the area to the roles the server allows', () => { expect(canSee(['SUPPORT_OPERATOR'], 'entitlements')).toBe(true); expect(canSee(['CONTENT_AUTHOR'], 'entitlements')).toBe(false); expect(canSee(['EXAM_ADMIN'], 'reports')).toBe(true); expect(canSee(['LEARNER'], 'reports')).toBe(false); });
});

describe('entitlement search', () => {
  it('lists, searches and sends a role with no access home before fetching', async () => {
    route({ ...signIn(['SUPPORT_OPERATOR']), 'GET /v1/catalogue': () => res(200, [{ versionId: 'v1', code: 'AI-101', title: 'AI Basics' }]), 'GET /v1/admin/entitlements?limit=50': () => res(200, [row()], { 'X-Next-Cursor': 'e1' }),
      'GET /v1/admin/entitlements?limit=50&cursor=e1': () => res(200, [row({ id: 'e2', learner: { id: 'l2', name: 'Omar Other', email: 'omar@x.test' } })]), 'GET /v1/admin/entitlements?limit=50&q=lena&status=PAUSED&programme=AI-101': () => res(200, []) });
    const { unmount } = mount('/staff/entitlements'); await screen.findByText('Lena Learner'); expect(screen.getByRole('link', { name: 'Lena Learner' })).toHaveAttribute('href', '/staff/entitlements/e1');
    await userEvent.click(screen.getByRole('button', { name: 'Show more' })); await screen.findByText('Omar Other');
    await userEvent.type(screen.getByLabelText('Search by learner name or email'), 'lena'); await userEvent.selectOptions(screen.getByLabelText('Programme'), 'AI-101'); await userEvent.selectOptions(screen.getByLabelText('Status'), 'PAUSED'); await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('No entitlements match.'); unmount();
    calls = []; route({ ...signIn(['CONTENT_AUTHOR']) }); mount('/staff/entitlements'); await screen.findByText('home'); expect(calls.some((c) => c.url.includes('/admin/entitlements'))).toBe(false);
  });
});

describe('entitlement page', () => {
  const base = (d: EntitlementDetailData, extra: Record<string, H> = {}) => ({ 'GET /v1/admin/entitlements/e1': () => res(200, d), 'GET /v1/catalogue/versions/v1': () => res(200, OUTLINE), ...extra });
  it('a support operator can pause and see history, but is not offered extend, revoke or unlock', async () => {
    let paused = false; route({ ...signIn(['SUPPORT_OPERATOR']), ...base(det(), { 'POST /v1/entitlements/e1/pause': ({ body }) => { paused = true; expect(body).toEqual({ reason: 'exam leave' }); return res(201, {}); } }) });
    mount('/staff/entitlements/e1'); await screen.findByRole('heading', { name: 'Lena Learner' }); expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Revoke' })).toBeNull(); expect(screen.queryByRole('heading', { name: 'Extend the end date' })).toBeNull(); expect(screen.queryByRole('heading', { name: 'Unlock or extend a topic' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'exam leave'); await userEvent.click(screen.getByRole('button', { name: 'Pause' })); await waitFor(() => expect(paused).toBe(true)); await screen.findByText('Paused.');
  });
  it('an academic admin extends with a reason, unlocks a topic, and revokes; each refuses an empty reason', async () => {
    const posts: Record<string, any> = {}; const post = (k: string): H => ({ body }) => { posts[k] = body; return res(201, {}); };
    route({ ...signIn(['ACADEMIC_ADMIN']), ...base(det(), { 'POST /v1/entitlements/e1/exceptions': post('ext'), 'POST /v1/entitlements/e1/progression-overrides': post('ov'), 'POST /v1/entitlements/e1/revoke': post('rev') }) });
    mount('/staff/entitlements/e1'); await screen.findByRole('heading', { name: 'Extend the end date' });
    await userEvent.click(screen.getByRole('button', { name: 'Extend' })); await screen.findByText(/Write the reason/); expect(posts.ext).toBeUndefined();
    await userEvent.clear(screen.getByLabelText('Days to add')); await userEvent.type(screen.getByLabelText('Days to add'), '45'); await userEvent.type(screen.getByLabelText('Reason', { selector: '#ex-r' }), 'illness'); await userEvent.click(screen.getByRole('button', { name: 'Extend' }));
    await waitFor(() => expect(posts.ext).toEqual({ extendDays: 45, reason: 'illness' }));
    await screen.findByRole('option', { name: 'Sensors' }); await userEvent.selectOptions(screen.getByLabelText('Topic'), 't1'); await userEvent.selectOptions(screen.getByLabelText('What do you want to do'), 'EXTRA_QUIZ_ATTEMPTS'); await userEvent.type(screen.getByLabelText(/Extra attempts/), '2'.replace(/^/, '')); // value starts at 1, so this makes 12
    await userEvent.clear(screen.getByLabelText(/Extra attempts/)); await userEvent.type(screen.getByLabelText(/Extra attempts/), '2'); await userEvent.type(screen.getByLabelText('Reason', { selector: '#ov-r' }), 'medical'); await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts.ov).toEqual({ topicId: 't1', type: 'EXTRA_QUIZ_ATTEMPTS', value: 2, reason: 'medical' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke access' })); expect((await screen.findAllByText(/Write the reason/)).length).toBeGreaterThan(0); expect(posts.rev).toBeUndefined();
    await userEvent.type(screen.getByLabelText('Reason', { selector: '#r-revoke' }), 'withdrawn'); await userEvent.click(screen.getByRole('button', { name: 'Revoke access' })); await waitFor(() => expect(posts.rev).toEqual({ reason: 'withdrawn' }));
  });
  it('shows a refusal from the server and offers no actions on a revoked entitlement', async () => {
    route({ ...signIn(['PLATFORM_ADMIN']), ...base(det({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' }), { 'POST /v1/entitlements/e1/pause': () => res(409, { message: 'Pause limit reached' }) }) });
    const { unmount } = mount('/staff/entitlements/e1'); await userEvent.click(await screen.findByRole('button', { name: 'Pause' })); expect(await screen.findByRole('alert')).toHaveTextContent('Pause limit reached'); unmount();
    route({ ...signIn(['PLATFORM_ADMIN']), ...base(det({ status: 'REVOKED', effectiveStatus: 'REVOKED', learningAccess: false })) }); mount('/staff/entitlements/e1');
    await screen.findByText('No access'); expect(screen.queryByRole('button', { name: 'Revoke access' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
});

describe('reports hub', () => {
  const progress = { summary: { learners: 2, avgPercent: 50, atRisk: 1, scope: 'page' }, nextCursor: null, rows: [
    { learner: 'Lena Learner', email: 'lena@x.test', cohort: 'C1', status: 'ACTIVE', completedTopics: 1, totalTopics: 4, percent: 25, quizAttempts: 2, lastActivity: '2030-01-01T00:00:00Z', daysIdle: 20, atRisk: true },
    { learner: 'Omar Other', email: 'omar@x.test', cohort: 'C1', status: 'ACTIVE', completedTopics: 3, totalTopics: 4, percent: 75, quizAttempts: 1, lastActivity: '2030-01-20T00:00:00Z', daysIdle: 1, atRisk: false }] };
  it('shows only the reports a role may read, and filters learners at risk', async () => {
    route({ ...signIn(['AUDITOR']), 'GET /v1/catalogue': () => res(200, [{ versionId: 'v1', code: 'AI-101', title: 'AI Basics' }]), 'GET /v1/reports/progress?versionId=v1&limit=200': () => res(200, progress) });
    mount('/staff/reports'); await screen.findByText('Lena Learner'); expect(screen.getByText('Omar Other')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Learner progress' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'AI tutor' })).not.toBeNull(); expect(screen.getByRole('button', { name: 'Grading' })).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Show only learners at risk')); expect(screen.queryByText('Omar Other')).toBeNull(); expect(screen.getByText('At risk', { selector: '.badge' })).toBeInTheDocument();
  });
  it('an exam admin sees exam results only; the tutor report renders its numbers', async () => {
    route({ ...signIn(['EXAM_ADMIN']), 'GET /v1/exam-ops/exams': () => res(200, []) }); const { unmount } = mount('/staff/reports');
    await screen.findByRole('button', { name: 'Exam results' }); expect(screen.queryByRole('button', { name: 'Learner progress' })).toBeNull(); expect(calls.some((c) => c.url.includes('/reports/progress'))).toBe(false); unmount();
    route({ ...signIn(['SUPPORT_OPERATOR']), 'GET /v1/catalogue': () => res(200, []), 'GET /v1/reports/tutor?days=30': () => res(200, { since: '2030-01-01T00:00:00Z', questions: 40, byStatus: { ANSWERED: 30, REFUSED: 10 }, groundedAnswerRate: 0.9, refusalRate: 0.25, helpfulRate: 80, escalatedTickets: 3, topUnresolvedTerms: [{ term: 'pid loop', count: 4 }], topUnresolvedTopics: [] }) });
    mount('/staff/reports'); await userEvent.click(await screen.findByRole('button', { name: 'AI tutor' })); await screen.findByText('pid loop'); expect(screen.getByText('90%')).toBeInTheDocument(); expect(screen.getByText('25%')).toBeInTheDocument(); expect(screen.getByText('80%')).toBeInTheDocument();
  });
});
