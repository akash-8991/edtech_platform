import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PrivacyDesk from '../staff/PrivacyDesk';
import PrivacyRequest from '../staff/PrivacyRequest';
import UserDetail from '../staff/UserDetail';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { PrivacyCase, PrivacyCaseDetail } from '../api/types';
import { who, caseStatus, decideBlock, describeDetails, describeResult, erasureBlockers, retentionLabel, validateOnBehalf, waiting } from '../lib/privacyops';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); window.confirm = vi.fn(() => true); });
const signIn = (roles: string[], id = 'me') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/privacy" element={<PrivacyDesk />} /><Route path="/staff/privacy/requests/:requestId" element={<PrivacyRequest />} /><Route path="/staff/users/:userId" element={<UserDetail />} /></Routes></Gate></AuthProvider></MemoryRouter>);
const kase = (o: Partial<PrivacyCase> = {}): PrivacyCase => ({ id: 'r1', userId: 'u1', userName: 'Ada Learner', userEmail: 'ada@x.test', type: 'ERASURE', status: 'REQUESTED', requestedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), requestedById: 'sup', requestedByName: 'Sue Support', decidedById: null, decidedByName: null, decisionReason: null, completedAt: null, exportExpiresAt: null, details: { reason: 'leaving' }, result: null, onBehalf: true, ...o });
const detail = (o: Partial<PrivacyCaseDetail> = {}): PrivacyCaseDetail => ({ ...kase(), subject: { legalHold: false, erased: false, activeEntitlements: 0 }, history: [{ at: '2030-01-01T00:00:00Z', by: 'Sue Support', action: 'privacy.request_filed', reason: null }], ...o });
const Q = (s: string) => `GET /v1/privacy/requests?status=${encodeURIComponent(s)}`;

describe('privacy helpers', () => {
  it('words statuses, waiting time and details', () => {
    expect(caseStatus('REQUESTED').label).toBe('Needs a decision'); expect(caseStatus('BLOCKED').tone).toBe('warn'); expect(caseStatus('weird').label).toBe('weird'); const n = Date.now(); expect(waiting(new Date(n).toISOString(), n)).toBe('today'); expect(waiting(new Date(n - 86_400_000).toISOString(), n)).toBe('1 day'); expect(waiting(new Date(n - 5 * 86_400_000).toISOString(), n)).toBe('5 days');
    expect(describeDetails(kase())).toBe('Reason given: leaving'); expect(describeDetails(kase({ details: {} }))).toBe('No reason was given.'); expect(describeDetails(kase({ type: 'CORRECTION', details: { name: 'Priya', language: 'hi' } }))).toBe('Change the name to “Priya”, change the language to Hindi'); expect(describeDetails(kase({ type: 'CORRECTION', details: {} }))).toMatch(/No change/); expect(describeDetails(kase({ type: 'EXPORT' }))).toMatch(/copy of everything/);
  });
  it('names the person, or the short account id once their name is erased', () => { expect(who({ userName: 'Ada', userId: 'abcdef1234' })).toBe('Ada'); expect(who({ userName: 'Erased learner', userId: 'abcdef1234' })).toBe('Erased account abcdef12'); expect(who({ userName: null, userId: 'abcdef1234' })).toBe('Erased account abcdef12'); });
  it('explains what stops an erasure and who may not decide', () => {
    expect(erasureBlockers({ legalHold: true, erased: false, activeEntitlements: 2 })).toEqual([expect.stringMatching(/legal hold/), expect.stringMatching(/2 active courses/)]); expect(erasureBlockers({ legalHold: false, erased: true, activeEntitlements: 0 })[0]).toMatch(/already been erased/); expect(erasureBlockers({ legalHold: false, erased: false, activeEntitlements: 0 })).toEqual([]);
    expect(decideBlock(kase(), 'sup')).toMatch(/filed this request/); expect(decideBlock(kase(), 'u1')).toMatch(/about you/); expect(decideBlock(kase(), 'other')).toBeNull(); expect(decideBlock(kase({ status: 'APPROVED' }), 'other')).toMatch(/already been decided/);
  });
  it('describes results, including a vendor that needs a manual follow-up', () => {
    const r = describeResult({ type: 'ERASURE', result: { redacted: { tutorMessages: 3, notifications: 0, ticketMessages: 2 }, external: { proctoringProvider: 'FAILED: follow up manually with the vendor' }, retained: ['grades', 'audit trail'] } });
    expect(r[0]).toBe('Removed or redacted: 3 tutor messages, 2 ticket messages.'); expect(r[1]).toMatch(/Proctoring vendor: FAILED.*\(follow up by hand\)/); expect(r[2]).toBe('Kept: grades; audit trail.');
    expect(describeResult({ type: 'ERASURE', result: { reason: 'legal hold' } })).toEqual(['Stopped: legal hold.']); expect(describeResult({ type: 'EXPORT', result: { bytes: 2048 } })).toEqual(['The export is 2 KB.']); expect(describeResult({ type: 'CORRECTION', result: { applied: ['name'] } })).toEqual(['Changed: name.']); expect(describeResult({ type: 'EXPORT', result: { lastError: 'disk' } })[0]).toMatch(/tried again/); expect(describeResult({ type: 'EXPORT', result: null })).toEqual([]);
    expect(validateOnBehalf({ userId: '', type: 'EXPORT', name: '', language: '', reason: '' })).toMatch(/Choose the person/); expect(validateOnBehalf({ userId: 'u', type: '', name: '', language: '', reason: '' })).toMatch(/what they asked/); expect(validateOnBehalf({ userId: 'u', type: 'CORRECTION', name: ' ', language: '', reason: '' })).toMatch(/what to correct/); expect(validateOnBehalf({ userId: 'u', type: 'CORRECTION', name: '', language: 'hi', reason: '' })).toBeNull(); expect(retentionLabel('sessions')).toMatch(/expired sign-ins/); expect(retentionLabel('x')).toBe('x');
  });
});

describe('privacy desk', () => {
  it('lists what needs a decision, longest-waiting first as the server sends it, and links to the request', async () => {
    route({ ...signIn(['PLATFORM_ADMIN']), [Q('REQUESTED')]: () => res(200, [kase()]) }); mount('/staff/privacy');
    expect(await screen.findByRole('link', { name: 'Erasure: Ada Learner' })).toHaveAttribute('href', '/staff/privacy/requests/r1'); expect(screen.getByText(/filed for them by Sue Support · waiting 3 days/)).toBeInTheDocument(); expect(screen.getByText('Reason given: leaving')).toBeInTheDocument();
  });
  it('gives an auditor the lists only, and sends a role with no access home before fetching', async () => {
    route({ ...signIn(['AUDITOR']), [Q('REQUESTED')]: () => res(200, []) }); const { unmount } = mount('/staff/privacy'); expect(await screen.findByText('Nothing is waiting for a decision.')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Retention' })).toBeNull(); expect(screen.queryByRole('button', { name: 'File for someone' })).toBeNull(); unmount(); calls = [];
    route(signIn(['DOUBT_TEACHER'])); mount('/staff/privacy'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('privacy'))).toBe(false);
  });
  it('carries out approved requests on demand and says what happened', async () => {
    route({ ...signIn(['PLATFORM_ADMIN']), [Q('REQUESTED')]: () => res(200, []), [Q('APPROVED,PROCESSING')]: () => res(200, [kase({ status: 'APPROVED' })]), 'POST /v1/privacy/process': () => res(201, { exports: 1, corrections: 0, erasures: 2, blocked: 1, failed: 0 }) });
    mount('/staff/privacy'); await userEvent.click(await screen.findByRole('button', { name: 'In progress' })); await userEvent.click(await screen.findByRole('button', { name: 'Carry out approved requests now' })); expect(await screen.findByText('Carried out 1 export, 0 corrections and 2 erasures; 1 could not be completed; 0 failed and will be retried.')).toBeInTheDocument();
  });
  it('files a request for someone found by search, validating first', async () => {
    route({ ...signIn(['SUPPORT_OPERATOR']), [Q('REQUESTED')]: () => res(200, []), 'GET /v1/admin/users?q=ada&limit=10': () => res(200, [{ id: 'u1', name: 'Ada Learner', email: 'ada@x.test' }]), 'POST /v1/privacy/requests/on-behalf': () => res(201, { id: 'r9' }) });
    mount('/staff/privacy'); await userEvent.click(await screen.findByRole('button', { name: 'File for someone' })); await userEvent.type(screen.getByLabelText('Find the person'), 'ada'); await userEvent.click(screen.getByRole('button', { name: 'Find' })); await userEvent.click(await screen.findByRole('button', { name: 'Ada Learner' }));
    await userEvent.click(screen.getByRole('button', { name: 'File the request' })); expect(await screen.findByText(/what they asked for/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText('They asked for'), 'CORRECTION'); await userEvent.type(screen.getByLabelText('Correct name'), 'Ada Lovelace'); await userEvent.click(screen.getByRole('button', { name: 'File the request' })); expect(await screen.findByText(/Filed for Ada Learner/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ userId: 'u1', type: 'CORRECTION', details: { name: 'Ada Lovelace' } });
  });
  it('previews retention without removing anything, and removes only after a confirmation', async () => {
    route({ ...signIn(['SUPER_ADMIN']), [Q('REQUESTED')]: () => res(200, []), 'POST /v1/privacy/retention/run?dryRun=true': () => res(201, { dryRun: true, wouldRemove: { notifications: 4, sessions: 2 } }), 'POST /v1/privacy/retention/run': () => res(201, { dryRun: false, removed: { notifications: 4, sessions: 2 } }) });
    mount('/staff/privacy'); await userEvent.click(await screen.findByRole('button', { name: 'Retention' })); await userEvent.click(screen.getByRole('button', { name: 'See what would be removed' })); expect(await screen.findByText('4 old notifications')).toBeInTheDocument(); expect(screen.getByText(/Nothing was removed/)).toBeInTheDocument(); expect(calls.filter((c) => c.method === 'POST').every((c) => c.url.endsWith('dryRun=true'))).toBe(true);
    window.confirm = vi.fn(() => false); await userEvent.click(screen.getByRole('button', { name: 'Remove it now' })); expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    window.confirm = vi.fn(() => true); await userEvent.click(screen.getByRole('button', { name: 'Remove it now' })); expect(await screen.findByText('Removed:')).toBeInTheDocument();
  });
});

describe('one request', () => {
  const page = (d: PrivacyCaseDetail, extra: Record<string, H> = {}) => ({ [`GET /v1/privacy/requests/${d.id}`]: () => res(200, d), ...extra });
  it('shows an erasure with what is kept and what stops it, and decides it only with a reason and a confirmation', async () => {
    let d = detail({ subject: { legalHold: true, erased: false, activeEntitlements: 1 } });
    route({ ...signIn(['PLATFORM_ADMIN']), ...page(d), 'GET /v1/privacy/requests/r1': () => res(200, d), 'POST /v1/privacy/requests/r1/decide': () => { d = detail({ status: 'APPROVED', decidedByName: 'Sam', decisionReason: 'Verified' }); return res(201, {}); } });
    mount('/staff/privacy/requests/r1'); expect(await screen.findByText(/grades, submissions, exam results/)).toBeInTheDocument(); expect(screen.getByText(/A legal hold applies/)).toBeInTheDocument(); expect(screen.getByText(/1 active course/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText(/Reason \(recorded/), 'Verified by phone'); window.confirm = vi.fn(() => false); await userEvent.click(screen.getByRole('button', { name: 'Approve' })); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    window.confirm = vi.fn(() => true); await userEvent.click(screen.getByRole('button', { name: 'Approve' })); expect(await screen.findByText(/Approved\. It will be carried out/)).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'APPROVE', reason: 'Verified by phone' }); expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });
  it('warns when the decider filed the request, and keeps the server refusal on screen', async () => {
    route({ ...signIn(['PLATFORM_ADMIN'], 'sup'), ...page(detail({ type: 'CORRECTION', details: { name: 'New Name' } })), 'POST /v1/privacy/requests/r1/decide': () => res(409, { message: 'segregation of duties: someone else must decide this request' }) });
    mount('/staff/privacy/requests/r1'); expect(await screen.findByText(/You filed this request/)).toBeInTheDocument(); await userEvent.type(screen.getByLabelText(/Reason \(recorded/), 'ok'); await userEvent.click(screen.getByRole('button', { name: 'Decline' })); expect(await screen.findByRole('alert')).toHaveTextContent(/segregation of duties/); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'REJECT', reason: 'ok' });
  });
  it('shows what happened after a finished erasure, and gives support and auditors no decision', async () => {
    const d = detail({ status: 'COMPLETED', decidedByName: 'Pat', result: { redacted: { tutorMessages: 2 }, external: { proctoringProvider: 'erasure requested' }, retained: ['grades'] }, history: [{ at: '2030-01-01T00:00:00Z', by: 'Sue Support', action: 'privacy.request_filed', reason: null }, { at: '2030-01-02T00:00:00Z', by: 'Pat', action: 'privacy.request_approved', reason: 'ok' }, { at: '2030-01-03T00:00:00Z', by: 'The system', action: 'privacy.erasure_completed', reason: null }] });
    route({ ...signIn(['SUPPORT_OPERATOR']), ...page(d) }); mount('/staff/privacy/requests/r1'); expect(await screen.findByText('Removed or redacted: 2 tutor messages.')).toBeInTheDocument(); expect(screen.getByText('Erasure carried out')).toBeInTheDocument(); expect(screen.queryByText('Before you decide')).toBeNull(); expect(screen.getByText('The system')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('tells support who may decide when a request is waiting', async () => {
    route({ ...signIn(['AUDITOR']), ...page(detail()) }); mount('/staff/privacy/requests/r1'); expect(await screen.findByText(/can read requests but not decide/)).toBeInTheDocument();
  });
});

describe('legal hold from a person record', () => {
  const person = (o: any = {}) => ({ id: 'u1', name: 'Ada', email: 'ada@x.test', language: 'en', status: 'ACTIVE', createdAt: '2030-01-01T00:00:00Z', lastLoginAt: null, locked: false, mfaEnabled: false, legalHold: false, roles: ['LEARNER'], scopedRoles: [], activeSessions: 0, teacherProfile: false, history: [], ...o });
  it('places a hold with a reason and offers it only to those who decide privacy requests', async () => {
    route({ ...signIn(['PLATFORM_ADMIN']), 'GET /v1/admin/users/u1': () => res(200, person()), 'PUT /v1/privacy/users/u1/legal-hold': () => res(200, { ok: true }) }); const { unmount } = mount('/staff/users/u1');
    await userEvent.click(await screen.findByRole('button', { name: 'Place a legal hold…' })); await userEvent.click(screen.getByRole('button', { name: 'Place a legal hold' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); await userEvent.type(screen.getByLabelText('Reason'), 'Inquiry 2026/9'); await userEvent.click(screen.getByRole('button', { name: 'Place a legal hold' })); await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true)); expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ hold: true, reason: 'Inquiry 2026/9' }); unmount();
    route({ ...signIn(['SUPPORT_OPERATOR']), 'GET /v1/admin/users/u1': () => res(200, person()) }); mount('/staff/users/u1'); await screen.findByRole('heading', { name: 'Ada' }); expect(screen.queryByRole('button', { name: /legal hold/i })).toBeNull();
  });
});
