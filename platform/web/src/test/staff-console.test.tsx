import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from '../App';
import Admissions from '../staff/Admissions';
import LabDesk, { CheckinCode } from '../staff/LabDesk';
import Operations, { SettingRow } from '../staff/Operations';
import Login from '../pages/Login';
import { AuthProvider } from '../auth';
import { api } from '../api/client';
import { canSee, hasAny, isLearner, isStaff } from '../lib/roles';
import { configToText, localToIso, parseConfigInput, sameValue, validateSlot } from '../lib/staff';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let calls: { method: string; url: string; headers: any; body: any }[] = [];
type H = (c: { body: any; headers: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, headers: init?.headers ?? {}, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, headers: init?.headers ?? {}, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); });
const signIn = (roles: string[]) => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id: 'u1', email: 'staff@x.test', name: 'Sam Staff', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const within_ = (_roles: string[], ui: JSX.Element, path = '/staff/x') => render(<MemoryRouter initialEntries={[path]}><AuthProvider>{ui}</AuthProvider></MemoryRouter>);

describe('role helpers', () => {
  it('shows each area only to the roles that may use it', () => {
    expect(canSee(['LAB_COORDINATOR'], 'labs')).toBe(true); expect(canSee(['LAB_COORDINATOR'], 'admissions')).toBe(false); expect(canSee(['SUPPORT_OPERATOR'], 'admissions')).toBe(true); expect(canSee(['AUDITOR'], 'operations')).toBe(true); expect(canSee(['CONTENT_AUTHOR'], 'operations')).toBe(false);
    expect(isStaff(['LEARNER'])).toBe(false); expect(isStaff(['LEARNER', 'AUDITOR'])).toBe(true); expect(isLearner(['LEARNER'])).toBe(true); expect(hasAny(undefined, ['X'])).toBe(false);
  });
});
describe('staff helpers', () => {
  const ok = { batchCode: 'B1', startsAt: '2030-01-01T09:00', endsAt: '2030-01-01T11:00', capacity: '20', location: '' };
  it('validates a session before sending it', () => {
    expect(validateSlot(ok)).toBeNull(); expect(validateSlot({ ...ok, batchCode: ' ' })).toMatch(/batch/); expect(validateSlot({ ...ok, startsAt: '' })).toMatch(/start and an end/); expect(validateSlot({ ...ok, startsAt: '2000-01-01T09:00', endsAt: '2000-01-01T10:00' })).toMatch(/future/);
    expect(validateSlot({ ...ok, endsAt: '2030-01-01T08:00' })).toMatch(/after the start/); for (const c of ['0', '501', '2.5', 'x']) expect(validateSlot({ ...ok, capacity: c })).toMatch(/Capacity/); expect(localToIso('')).toBeNull(); expect(localToIso('2030-01-01T09:00')).toMatch(/^2030-01-01T/);
  });
  it('turns what an admin typed into the typed setting value the API expects', () => {
    expect(parseConfigInput('boolean', 'true')).toEqual({ ok: true, value: true }); expect(parseConfigInput('boolean', 'yes').ok).toBe(false); expect(parseConfigInput('number', ' 42.5 ')).toEqual({ ok: true, value: 42.5 }); expect(parseConfigInput('number', '').ok).toBe(false); expect(parseConfigInput('number', 'abc').ok).toBe(false);
    expect(parseConfigInput('string[]', 'a\n\n b \n')).toEqual({ ok: true, value: ['a', 'b'] }); expect(parseConfigInput('numbermap', '{"P1":60}')).toEqual({ ok: true, value: { P1: 60 } }); expect(parseConfigInput('map', '[1]').ok).toBe(false); expect(parseConfigInput('map', '{bad').ok).toBe(false);
    expect(configToText({ kind: 'string[]', value: ['a', 'b'] })).toBe('a\nb'); expect(configToText({ kind: 'boolean', value: false })).toBe('false'); expect(configToText({ kind: 'map', value: { a: 1 } })).toContain('"a": 1'); expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
  });
});

describe('staff sign-in', () => {
  const login = () => render(<MemoryRouter initialEntries={['/login']}><AuthProvider><Routes><Route path="/login" element={<Login />} /><Route path="/staff" element={<p>STAFF HOME</p>} /><Route path="/" element={<p>LEARNER HOME</p>} /></Routes></AuthProvider></MemoryRouter>);
  it('password, then a code from the authenticator app, then lands in the staff console', async () => {
    route({ 'POST /v1/auth/login': () => res(201, { mfaRequired: true, mfaToken: 'MT' }), 'POST /v1/auth/mfa/verify': ({ body }) => (body.code === '123456' ? res(201, { accessToken: 'A', refreshToken: 'R', expiresIn: 900, roles: ['AUDITOR'] }) : res(400, { message: 'code did not match: check your authenticator clock and try again' })), ...signIn(['AUDITOR']) });
    const u = userEvent.setup(); api.clear(); login(); await u.type(await screen.findByLabelText('Email'), 'a@x.test'); await u.type(screen.getByLabelText('Password'), 'pw'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText('Code'); const verify = screen.getByRole('button', { name: 'Verify' }); expect(verify).toBeDisabled(); await u.type(code, '000000'); await u.click(verify); expect(await screen.findByRole('alert')).toHaveTextContent(/did not match/);
    await u.clear(code); await u.type(code, '123456'); await u.click(verify); expect(await screen.findByText('STAFF HOME')).toBeInTheDocument();
  });
  it('first sign-in: sets up the authenticator, confirms a code, shows backup codes once, and only then continues', async () => {
    route({ 'POST /v1/auth/login': () => res(201, { mfaEnrollmentRequired: true, enrollmentToken: 'ET' }), 'POST /v1/auth/mfa/enroll/start': () => res(201, { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Portal:a@x.test?secret=JBSWY3DPEHPK3PXP' }),
      'POST /v1/auth/mfa/enroll/confirm': () => res(201, { enabled: true, backupCodes: ['1111-aaaa', '2222-bbbb'], accessToken: 'A', refreshToken: 'R', expiresIn: 900, roles: ['PLATFORM_ADMIN'] }), ...signIn(['PLATFORM_ADMIN']) });
    const u = userEvent.setup(); api.clear(); login(); await u.type(await screen.findByLabelText('Email'), 'a@x.test'); await u.type(screen.getByLabelText('Password'), 'pw'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await u.click(await screen.findByRole('button', { name: 'Begin setup' })); expect(await screen.findByLabelText('Setup key')).toHaveTextContent('JBSWY3DPEHPK3PXP'); expect(calls.find((c) => c.url.endsWith('/enroll/start'))!.headers.Authorization).toBe('Bearer ET');
    await u.type(screen.getByLabelText('Code'), '654321'); await u.click(screen.getByRole('button', { name: 'Confirm and finish' })); expect(await screen.findByText('1111-aaaa')).toBeInTheDocument(); expect(screen.getByRole('alert')).toHaveTextContent(/only once/);
    const go = screen.getByRole('button', { name: 'Continue' }); expect(go).toBeDisabled(); await u.click(screen.getByLabelText(/I have saved these codes/)); await u.click(go); expect(await screen.findByText('STAFF HOME')).toBeInTheDocument();
  });
});

describe('shells keep people where they belong', () => {
  const app = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
  const withSession = (roles: string[], extra: Record<string, H> = {}) => { sessionStorage.setItem('edtech.rt', 'RT'); route({ 'POST /v1/auth/refresh': () => res(201, { accessToken: 'AT', refreshToken: 'RT2', expiresIn: 900, roles }), 'GET /v1/auth/me': () => res(200, { id: 'u', email: 's@x.test', name: 'Sam Staff', language: 'en', roles, mfaEnabled: true }), ...extra }); };
  it('sends a staff-only account to the console and shows only the areas their role allows', async () => {
    withSession(['LAB_COORDINATOR']); app('/'); expect(await screen.findByRole('heading', { name: /Welcome, Sam Staff/ })).toBeInTheDocument(); const nav = screen.getByRole('navigation', { name: 'Staff' }); expect(within(nav).getByRole('link', { name: 'Lab desk' })).toBeInTheDocument(); expect(within(nav).queryByRole('link', { name: 'Admissions' })).toBeNull(); expect(screen.getByLabelText('Your roles')).toHaveTextContent('Lab Coordinator');
  });
  it('sends a learner away from the console, and a page the role may not open back to the console home', async () => {
    withSession(['LEARNER'], { 'GET /v1/me/entitlements': () => res(200, []), 'GET /v1/catalogue': () => res(200, []) }); app('/staff/admissions'); expect(await screen.findByText(/not enrolled in a course yet/)).toBeInTheDocument(); expect(screen.getByRole('heading', { level: 1, name: 'My courses' })).toBeInTheDocument();
  });
  it('a role without admissions access is redirected from /staff/admissions', async () => {
    withSession(['LAB_COORDINATOR']); app('/staff/admissions'); expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('/v1/applications'))).toBe(false);
  });
});

const app1 = (id: string, o: Partial<Record<string, string>> = {}) => ({ id, externalRef: `EXT-${id}`, email: `${id}@x.test`, name: `Applicant ${id}`, programmeCode: 'DEMO', duration: 'M12', cohort: '2026-A', status: 'RECEIVED', createdAt: '2026-10-01T10:00:00Z', ...o });
describe('Admissions', () => {
  const page = (roles: string[]) => within_(roles, <Admissions />, '/staff/admissions');
  it('lists the queue by status, loads more with the cursor, and approves with one click', async () => {
    let list = [app1('a1'), app1('a2')];
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/applications?status=RECEIVED&limit=25': () => res(200, list, { 'X-Next-Cursor': 'CUR1' }), 'GET /v1/applications?status=RECEIVED&limit=25&cursor=CUR1': () => res(200, [app1('a3')]), 'POST /v1/applications/a1/decision': () => res(201, { entitlementId: 'E1' }) });
    const u = userEvent.setup(); page(['ACADEMIC_ADMIN']); expect(await screen.findByText('Applicant a1')).toBeInTheDocument(); await u.click(screen.getByRole('button', { name: 'Load more' })); expect(await screen.findByText('Applicant a3')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    await u.click(screen.getAllByRole('button', { name: 'Approve' })[0]); const f = screen.getByRole('form', { name: 'Decision for Applicant a1' }); await u.click(within(f).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(screen.queryByText('Applicant a1')).toBeNull()); const d = calls.find((c) => c.url.endsWith('/a1/decision'))!; expect(d.body).toEqual({ decision: 'APPROVE' }); expect(d.headers['Idempotency-Key']).toBeTruthy(); void list;
  });
  it('a rejection or return needs a reason; a server refusal is shown and the row stays', async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/applications?status=RECEIVED&limit=25': () => res(200, [app1('a1')]), 'POST /v1/applications/a1/decision': () => res(409, { message: 'no published course version for programme' }) });
    const u = userEvent.setup(); page(['ACADEMIC_ADMIN']); await u.click(await screen.findByRole('button', { name: 'Reject' })); const f = screen.getByRole('form', { name: 'Decision for Applicant a1' }); const confirm = within(f).getByRole('button', { name: 'Confirm rejection' }); expect(confirm).toBeDisabled();
    await u.type(within(f).getByLabelText(/Reason/), 'Does not meet entry criteria'); await u.click(confirm); expect(await within(f).findByRole('alert')).toHaveTextContent('no published course version'); expect(screen.getByText('Applicant a1')).toBeInTheDocument(); expect(calls.find((c) => c.url.endsWith('/decision'))!.body).toEqual({ decision: 'REJECT', reason: 'Does not meet entry criteria' });
  });
  it('support staff can read the queue but not decide or import', async () => {
    route({ ...signIn(['SUPPORT_OPERATOR']), 'GET /v1/applications?status=RECEIVED&limit=25': () => res(200, [app1('a1')]) }); page(['SUPPORT_OPERATOR']); expect(await screen.findByText('Applicant a1')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull(); expect(screen.queryByText(/Import applications/)).toBeNull();
  });
  it('switching tabs reloads for that status; an empty tab says so', async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/applications?status=RECEIVED&limit=25': () => res(200, [app1('a1')]), 'GET /v1/applications?status=APPROVED&limit=25': () => res(200, []) });
    const u = userEvent.setup(); page(['ACADEMIC_ADMIN']); await screen.findByText('Applicant a1'); await u.click(screen.getByRole('button', { name: 'Approved' })); expect(await screen.findByText('No applications here.')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Approved' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('imports a CSV and reports created, duplicate and invalid rows with the reasons', async () => {
    route({ ...signIn(['ACADEMIC_ADMIN']), 'GET /v1/applications?status=RECEIVED&limit=25': () => res(200, []), 'POST /v1/applications/import': () => res(201, { summary: { created: 1, duplicate: 1, invalid: 1 }, results: [{ externalRef: 'A', result: 'created', id: '1' }, { externalRef: 'B', result: 'duplicate', id: '2' }, { externalRef: 'C', result: 'invalid', errors: ['email invalid'] }] }) });
    const u = userEvent.setup(); page(['ACADEMIC_ADMIN']); const text = await screen.findByLabelText(/paste it here/); await u.click(text); await u.paste('externalRef,email,name,programmeCode,duration,cohort\nA,a@x.test,A,DEMO,M12,C1\nB,b@x.test,B,DEMO,M12,C1\nC,bad,C,DEMO,M12,C1'); const btn = screen.getByRole('button', { name: /Import 3 rows/ }); await u.click(btn);
    expect(await screen.findByRole('status')).toHaveTextContent('1 created'); expect(screen.getByText('email invalid')).toBeInTheDocument(); expect(calls.find((c) => c.url.endsWith('/import'))!.body.csv).toContain('externalRef,email'); expect(calls.find((c) => c.url.endsWith('/import'))!.headers['Idempotency-Key']).toBeTruthy();
  });
});

describe('Lab desk', () => {
  const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const setup = (extra: Record<string, H> = {}) => route({ ...signIn(['LAB_COORDINATOR']), 'GET /v1/catalogue': () => res(200, [{ versionId: 'V1', code: 'DEMO', title: 'Demo programme' }]), 'GET /v1/authoring/versions/V1/labs': () => res(200, [{ id: 'L1', code: 'LAB1', title: 'Soldering', location: 'Workshop 2', versionId: 'V1', requireEvidence: true, mandatory: true }]),
    'GET /v1/labs/slots?activityId=L1&scope=all': () => res(200, [{ id: 'S1', batchCode: 'B1', startsAt: iso(-10), endsAt: iso(50), location: 'W2', capacity: 10, seatsLeft: 7, status: 'OPEN' }, { id: 'S0', batchCode: 'OLD', startsAt: iso(-3000), endsAt: iso(-2900), capacity: 5, seatsLeft: 5, status: 'CANCELLED' }]),
    'GET /v1/labs/slots/S1/qr': ({ n }) => res(200, { token: `TOKEN-${n}`, validSeconds: 90 }), 'GET /v1/labs/slots/S1/roster': () => res(200, [{ bookingId: 'BK1', learnerId: 'u1', name: 'Asha', status: 'BOOKED', evidenceFiles: 0, completed: false }, { bookingId: 'BK2', learnerId: 'u2', name: 'Ravi', status: 'ATTENDED', attendanceMethod: 'QR', evidenceFiles: 2, completed: false }]), ...extra });
  const open = () => within_(['LAB_COORDINATOR'], <LabDesk />, '/staff/labs');
  it('shows sessions including cancelled ones, and creates a new session after local checks', async () => {
    setup({ 'POST /v1/labs/slots': () => res(201, { id: 'S9' }) }); const u = userEvent.setup(); open(); expect(await screen.findByText('Cancelled')).toBeInTheDocument(); expect(screen.getByText(/3\/10 booked/)).toBeInTheDocument();
    const f = await screen.findByRole('form', { name: 'New session' }); await u.click(within(f).getByRole('button', { name: 'Create session' })); expect(within(f).getByRole('alert')).toHaveTextContent(/batch/); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await u.type(within(f).getByLabelText('Batch or cohort'), '2026-A'); await u.type(within(f).getByLabelText('Starts'), '2030-05-01T09:00'); await u.type(within(f).getByLabelText('Ends'), '2030-05-01T11:00'); await u.click(within(f).getByRole('button', { name: 'Create session' }));
    expect(await within(f).findByText(/Session created/)).toBeInTheDocument(); const p = calls.find((c) => c.method === 'POST')!.body; expect(p).toMatchObject({ activityId: 'L1', batchCode: '2026-A', capacity: 20, location: 'Workshop 2' }); expect(p.startsAt).toMatch(/^2030-05-01T|^2030-04-30T/);
  });
  it('runs a session: shows a refreshing check-in code and the roster, marks attendance, and needs a reason to complete', async () => {
    let attended = false; setup({ 'POST /v1/labs/slots/S1/attendance': () => { attended = true; return res(201, {}); }, 'POST /v1/labs/bookings/BK2/complete': () => res(201, {}),
      'GET /v1/labs/slots/S1/roster': () => res(200, [{ bookingId: 'BK1', learnerId: 'u1', name: 'Asha', status: attended ? 'ATTENDED' : 'BOOKED', evidenceFiles: 0, completed: false }, { bookingId: 'BK2', learnerId: 'u2', name: 'Ravi', status: 'ATTENDED', attendanceMethod: 'QR', evidenceFiles: 2, completed: false }]) });
    const u = userEvent.setup(); open(); await u.click(await screen.findByRole('button', { name: 'Run this session' })); expect(await screen.findByText('Asha')).toBeInTheDocument(); expect(screen.getByText('2 files')).toBeInTheDocument(); expect(screen.getByLabelText('Check-in code')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Present' })); await waitFor(() => expect(calls.find((c) => c.url.endsWith('/attendance'))?.body).toEqual({ learnerId: 'u1', status: 'ATTENDED' }));
    const completeButtons = await screen.findAllByRole('button', { name: 'Mark complete…' }); await u.click(completeButtons[completeButtons.length - 1]); const f = screen.getByRole('form', { name: 'Complete lab' }); expect(within(f).getByRole('button', { name: 'Confirm completion' })).toBeDisabled(); expect(f).toHaveTextContent(/audit trail/);
    await u.type(within(f).getByLabelText('Reason'), 'Evidence checked in person'); await u.click(within(f).getByRole('button', { name: 'Confirm completion' })); await waitFor(() => expect(calls.find((c) => c.url.endsWith('/BK2/complete'))?.body).toEqual({ reason: 'Evidence checked in person' }));
  });
  it('cancelling a session warns that learners are notified and needs a reason', async () => {
    setup({ 'POST /v1/labs/slots/S1/cancel': () => res(201, { cancelledBookings: 3 }) }); const u = userEvent.setup(); open(); await u.click(await screen.findByRole('button', { name: 'Run this session' })); await u.click(await screen.findByRole('button', { name: 'Cancel this session…' }));
    const f = screen.getByRole('form', { name: 'Cancel session' }); expect(within(f).getByRole('alert')).toHaveTextContent(/notified/); const go = within(f).getByRole('button', { name: /Cancel session and notify/ }); expect(go).toBeDisabled(); await u.type(within(f).getByLabelText(/Reason/), 'Equipment fault'); await u.click(go);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/S1/cancel'))?.body).toEqual({ reason: 'Equipment fault' }));
  });
  it('the check-in code is re-fetched before it expires so a stale photo of it is useless', async () => {
    setup(); render(<MemoryRouter><CheckinCode slotId="S1" refreshMs={40} /></MemoryRouter>); await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/qr')).length).toBeGreaterThanOrEqual(3)); expect(screen.getByLabelText('Check-in code')).toBeInTheDocument();
    const u = userEvent.setup(); await u.click(screen.getByRole('button', { name: 'Hide code' })); expect(screen.getByRole('button', { name: 'Show code' })).toBeInTheDocument();
  });
});

describe('Operations', () => {
  const ops = (roles: string[], extra: Record<string, H> = {}) => { route({ ...signIn(roles), ...extra }); within_(roles, <Operations />, '/staff/operations'); };
  const report = (o: any = {}) => ({ ok: true, checkedAt: '2026-10-02T10:00:00Z', audit: { events: 1200, intact: true, firstBroken: null }, examLogs: { attempts: 40, broken: [] }, counts: { users: 5 }, orphans: { a: 0, b: 0 }, ...o });
  it('runs the integrity check and reports a pass', async () => {
    ops(['AUDITOR'], { 'GET /v1/ops/integrity': () => res(200, report()) }); const u = userEvent.setup(); await u.click(await screen.findByRole('button', { name: 'Run full check now' })); expect(await screen.findByText('All checks passed')).toBeInTheDocument(); expect(screen.getByText(/1,200 events, chain intact/)).toBeInTheDocument(); expect(screen.queryByText(/security incident/)).toBeNull();
  });
  it('a failed check is unmistakable and says what to do (and what not to do)', async () => {
    ops(['PLATFORM_ADMIN'], { 'GET /v1/ops/integrity': () => res(200, report({ ok: false, audit: { events: 10, intact: false, firstBroken: 4 }, examLogs: { attempts: 2, broken: ['A1'] }, orphans: { submissionsWithoutGradeState: 3 } })), 'GET /v1/admin/config': () => res(200, []), 'GET /v1/exam-ops/status': () => res(200, { inProgress: 0, staleAutosave: 0, expiringWithin5Min: 0, highSessionSwitches: 0, openIncidents: {}, heldResults: 0, awaitingRelease: 0, remoteAwaitingProctorReport: 0, openAppeals: 0 }) });
    const u = userEvent.setup(); await u.click(await screen.findByRole('button', { name: 'Run full check now' })); expect(await screen.findByText('PROBLEM FOUND')).toBeInTheDocument(); expect(screen.getByText(/BROKEN at event 4/)).toBeInTheDocument(); expect(screen.getByText(/1 with a broken chain/)).toBeInTheDocument(); expect(screen.getByText(/submissionsWithoutGradeState: 3/)).toBeInTheDocument(); expect(screen.getByRole('alert')).toHaveTextContent(/security incident.*not try to repair/s);
  });
  it('shows live exam numbers only to roles that may see them', async () => {
    ops(['EXAM_ADMIN'], { 'GET /v1/exam-ops/status': () => res(200, { inProgress: 120, staleAutosave: 3, expiringWithin5Min: 10, highSessionSwitches: 1, openIncidents: { HIGH: 2, LOW: 1 }, heldResults: 4, awaitingRelease: 6, remoteAwaitingProctorReport: 2, openAppeals: 0 }) });
    expect(await screen.findByText('120')).toBeInTheDocument(); expect(screen.getByText('Open incidents').nextSibling).toHaveTextContent('3'); expect(screen.queryByRole('button', { name: 'Run full check now' })).toBeNull();
  });
  it('edits settings by type, puts emergency controls first and asks before changing them', async () => {
    let kill = false; const cfg = () => [{ key: 'ai.kill_switch', doc: 'Stops every model call immediately', kind: 'boolean', value: kill }, { key: 'ai.daily_budget_usd', doc: 'Hard daily spend cap', kind: 'number', value: 100 }, { key: 'doubt.sla_minutes', doc: 'SLA', kind: 'numbermap', value: { P1: 60 } }];
    ops(['PLATFORM_ADMIN'], { 'GET /v1/ops/integrity': () => res(200, report()), 'GET /v1/admin/config': () => res(200, cfg()), 'GET /v1/exam-ops/status': () => res(200, { inProgress: 0, staleAutosave: 0, expiringWithin5Min: 0, highSessionSwitches: 0, openIncidents: {}, heldResults: 0, awaitingRelease: 0, remoteAwaitingProctorReport: 0, openAppeals: 0 }), 'PUT /v1/admin/config/ai.kill_switch': ({ body }) => { kill = body.value; return res(200, {}); }, 'PUT /v1/admin/config/ai.daily_budget_usd': () => res(403, { message: 'insufficient role' }) });
    const u = userEvent.setup(); const emergency = await screen.findByRole('region', { name: 'Emergency controls' }); const row = within(emergency).getByRole('group', { name: 'ai.kill_switch' }); expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled();
    await u.selectOptions(within(row).getByRole('combobox'), 'true'); await u.click(within(row).getByRole('button', { name: 'Save' })); const dlg = within(row).getByRole('alertdialog'); expect(dlg).toHaveTextContent(/affects the whole platform/); expect(calls.some((c) => c.method === 'PUT')).toBe(false); await u.click(within(dlg).getByRole('button', { name: 'Yes, change it' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/ai.kill_switch'))?.body).toEqual({ value: true })); expect(await within(row).findByText('Saved')).toBeInTheDocument();
    await u.click(screen.getByText('ai', { selector: 'strong' })); const budget = screen.getByRole('group', { name: 'ai.daily_budget_usd' }); await u.clear(within(budget).getByRole('spinbutton')); await u.type(within(budget).getByRole('spinbutton'), '50'); await u.click(within(budget).getByRole('button', { name: 'Save' })); expect(await within(budget).findByRole('alert')).toHaveTextContent('insufficient role');
  });
  it('rejects a malformed value before sending it', async () => {
    const onSaved = vi.fn(); route({}); const u = userEvent.setup(); render(<SettingRow item={{ key: 'doubt.sla_minutes', doc: 'SLA', kind: 'numbermap', value: { P1: 60 } }} onSaved={onSaved} />);
    const box = screen.getByRole('textbox'); await u.clear(box); await u.type(box, 'not json'); expect(screen.getByRole('alert')).toHaveTextContent(/valid JSON/); expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled(); expect(calls.length).toBe(0);
  });
});
