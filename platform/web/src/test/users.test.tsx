import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Users from '../staff/Users';
import UserDetail from '../staff/UserDetail';
import { AuthProvider, useAuth } from '../auth';
import { api } from '../api/client';
import type { UserDetailData, UserRow } from '../api/types';
import { actionLabel, changeProblem, mayGrant, mayManage, roleChange, validateNewUser } from '../lib/users';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let calls: { method: string; url: string; body: any }[] = [];
type H = (c: { body: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body; calls.push({ method, url, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); });
const signIn = (roles: string[], id = 'me') => { api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); return { 'GET /v1/auth/me': () => res(200, { id, email: 's@x.test', name: 'Sam', language: 'en', roles, mfaEnabled: true }) } as Record<string, H>; };
const Gate = ({ children }: { children: JSX.Element }) => (useAuth().loading ? <p>loading</p> : children);
const mount = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><Gate><Routes><Route path="/staff" element={<p>home</p>} /><Route path="/staff/users" element={<Users />} /><Route path="/staff/users/:userId" element={<UserDetail />} /></Routes></Gate></AuthProvider></MemoryRouter>);
const urow = (o: Partial<UserRow> = {}): UserRow => ({ id: 'u1', name: 'Ada Author', email: 'ada@x.test', language: 'en', status: 'ACTIVE', createdAt: '2030-01-01T00:00:00Z', lastLoginAt: null, locked: false, mfaEnabled: true, legalHold: false, roles: ['CONTENT_AUTHOR'], scopedRoles: [], ...o });
const udet = (o: Partial<UserDetailData> = {}): UserDetailData => ({ ...urow(), activeSessions: 2, teacherProfile: false, history: [{ seq: 1, at: '2030-01-02T00:00:00Z', by: 'Pat Platform', action: 'user.roles_changed', reason: 'Joined', detail: {} }], ...o });

describe('people helpers', () => {
  it('knows who may touch whom', () => {
    expect(mayGrant(['PLATFORM_ADMIN'], 'AUDITOR')).toBe(true); expect(mayGrant(['PLATFORM_ADMIN'], 'SUPER_ADMIN')).toBe(false); expect(mayGrant(['PLATFORM_ADMIN'], 'PLATFORM_ADMIN')).toBe(false); expect(mayGrant(['SUPER_ADMIN'], 'PLATFORM_ADMIN')).toBe(true);
    expect(mayManage(['PLATFORM_ADMIN'], ['CONTENT_AUTHOR'])).toBe(true); expect(mayManage(['PLATFORM_ADMIN'], ['PLATFORM_ADMIN'])).toBe(false); expect(mayManage(['SUPER_ADMIN'], ['SUPER_ADMIN'])).toBe(true);
  });
  it('works out and validates a role change', () => {
    expect(roleChange(['A', 'B'], ['B', 'C'])).toEqual({ add: ['C'], remove: ['A'] }); expect(changeProblem(['A'], ['A'], 'x')).toMatch(/Nothing has changed/); expect(changeProblem(['A'], [], 'x')).toMatch(/at least one role/); expect(changeProblem(['A'], ['A', 'B'], ' ')).toMatch(/reason/); expect(changeProblem(['A'], ['A', 'B'], 'why')).toBeNull();
    expect(validateNewUser({ email: 'bad', name: 'N', roles: ['LEARNER'] })).toMatch(/valid email/); expect(validateNewUser({ email: 'a@b.co', name: ' ', roles: ['LEARNER'] })).toMatch(/name/); expect(validateNewUser({ email: 'a@b.co', name: 'N', roles: [] })).toMatch(/at least one role/); expect(validateNewUser({ email: 'a@b.co', name: 'N', roles: ['LEARNER'] })).toBeNull();
    expect(actionLabel('user.suspended')).toBe('Suspended'); expect(actionLabel('some.new_action')).toBe('some new action');
  });
});

describe('people directory', () => {
  const base = (rows: UserRow[], extra: Record<string, H> = {}) => ({ 'GET /v1/admin/users?limit=50': () => res(200, rows), ...extra });
  it('lists people, searches, and sends a role with no access home before fetching', async () => {
    route({ ...signIn(['AUDITOR']), ...base([urow()]), 'GET /v1/admin/users?limit=50&q=ada&role=AUDITOR&status=ACTIVE': () => res(200, []) }); const { unmount } = mount('/staff/users');
    expect(await screen.findByRole('link', { name: 'Ada Author' })).toHaveAttribute('href', '/staff/users/u1'); expect(screen.queryByRole('button', { name: 'Add a person' })).toBeNull(); // an auditor reads only
    await userEvent.type(screen.getByLabelText('Search by name or email'), 'ada'); await userEvent.selectOptions(screen.getByLabelText('Role'), 'AUDITOR'); await userEvent.selectOptions(screen.getByLabelText('Status'), 'ACTIVE'); await userEvent.click(screen.getByRole('button', { name: 'Search' })); expect(await screen.findByText('No one matches.')).toBeInTheDocument(); unmount(); calls = [];
    route(signIn(['LAB_COORDINATOR'])); mount('/staff/users'); expect(await screen.findByText('home')).toBeInTheDocument(); expect(calls.some((c) => c.url.includes('admin/users'))).toBe(false);
  });
  it('shows more when there is another page', async () => {
    route({ ...signIn(['PLATFORM_ADMIN']), 'GET /v1/admin/users?limit=50': () => res(200, [urow()], { 'X-Next-Cursor': 'c1' }), 'GET /v1/admin/users?limit=50&cursor=c1': () => res(200, [urow({ id: 'u2', name: 'Bo Reviewer', roles: ['FACULTY_REVIEWER'] })]) });
    mount('/staff/users'); await userEvent.click(await screen.findByRole('button', { name: 'Show more' })); expect(await screen.findByRole('link', { name: 'Bo Reviewer' })).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'Ada Author' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
  it('creates an account, shows the one-time password once, and hides it when dismissed; a platform admin cannot pick administrator roles', async () => {
    route({ ...signIn(['PLATFORM_ADMIN']), ...base([]), 'POST /v1/admin/users': () => res(201, { id: 'n1', email: 'new@x.test', roles: ['CONTENT_AUTHOR'], temporaryPassword: 'Abcd-Efgh-1234-56' }) });
    mount('/staff/users'); await userEvent.click(await screen.findByRole('button', { name: 'Add a person' })); expect(screen.getByRole('checkbox', { name: /Super Admin/ })).toBeDisabled(); expect(screen.getByRole('checkbox', { name: /Platform Admin/ })).toBeDisabled(); expect(screen.getByRole('checkbox', { name: /Content Author/ })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' })); expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText('Name'), 'New Person'); await userEvent.type(screen.getByLabelText('Email'), 'new@x.test'); await userEvent.click(screen.getByRole('checkbox', { name: /Content Author/ })); await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByLabelText('One-time password')).toHaveTextContent('Abcd-Efgh-1234-56'); expect(screen.getByText(/will not be shown again/)).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ email: 'new@x.test', name: 'New Person', language: 'en', roles: ['CONTENT_AUTHOR'], ssoOnly: false });
    await userEvent.click(screen.getByRole('button', { name: 'I have passed it on' })); expect(screen.queryByLabelText('One-time password')).toBeNull(); expect(document.body.textContent).not.toContain('Abcd-Efgh-1234-56');
  });
  it('lets a super admin choose administrator roles and shows a duplicate-email refusal', async () => {
    route({ ...signIn(['SUPER_ADMIN']), ...base([]), 'POST /v1/admin/users': () => res(409, { message: 'someone with this email already exists' }) });
    mount('/staff/users'); await userEvent.click(await screen.findByRole('button', { name: 'Add a person' })); expect(screen.getByRole('checkbox', { name: /Platform Admin/ })).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Name'), 'Dup'); await userEvent.type(screen.getByLabelText('Email'), 'dup@x.test'); await userEvent.click(screen.getByRole('checkbox', { name: /Learner/ })); await userEvent.click(screen.getByLabelText(/only through single sign-on/)); await userEvent.click(screen.getByRole('button', { name: 'Create account' })); expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/); expect(calls.find((c) => c.method === 'POST')!.body.ssoOnly).toBe(true);
  });
});

describe('one person', () => {
  const page = (d: UserDetailData, extra: Record<string, H> = {}) => ({ [`GET /v1/admin/users/${d.id}`]: () => res(200, d), ...extra });
  it('changes roles only with a reason, sending exactly what was added and removed', async () => {
    let d = udet(); route({ ...signIn(['PLATFORM_ADMIN']), ...page(d), 'GET /v1/admin/users/u1': () => res(200, d), 'POST /v1/admin/users/u1/roles': () => { d = udet({ roles: ['CONTENT_AUTHOR', 'DOUBT_TEACHER'] }); return res(201, { roles: d.roles, sessionsRevoked: 2 }); } });
    mount('/staff/users/u1'); await screen.findByRole('heading', { name: 'Ada Author' }); expect(screen.getByRole('checkbox', { name: /Super Admin/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' })); expect(await screen.findByText(/Nothing has changed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /Doubt Teacher/ })); await userEvent.click(screen.getByRole('button', { name: 'Save roles' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText(/Reason for the change/), 'Joins the doubt desk'); await userEvent.click(screen.getByRole('button', { name: 'Save roles' })); expect(await screen.findByText(/They have been signed out/)).toBeInTheDocument(); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ add: ['DOUBT_TEACHER'], remove: [], reason: 'Joins the doubt desk' });
    expect(await screen.findByText(/not registered at the doubt desk yet/)).toBeInTheDocument();
  });
  it('will not let someone change their own record, nor a platform admin change an administrator', async () => {
    route({ ...signIn(['PLATFORM_ADMIN'], 'u1'), ...page(udet()) }); const { unmount } = mount('/staff/users/u1'); expect(await screen.findByText(/This is you/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Save roles' })).toBeNull(); expect(screen.queryByRole('button', { name: /Suspend/ })).toBeNull(); unmount();
    route({ ...signIn(['PLATFORM_ADMIN'], 'me'), ...page(udet({ roles: ['SUPER_ADMIN'] })) }); mount('/staff/users/u1'); expect(await screen.findByText(/only a super admin can change them/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Save roles' })).toBeNull();
  });
  it('suspends with a reason and keeps a refusal visible', async () => {
    route({ ...signIn(['PLATFORM_ADMIN']), ...page(udet()), 'POST /v1/admin/users/u1/status': () => res(409, { message: 'this is the last active super admin' }) }); mount('/staff/users/u1');
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend…' })); await userEvent.click(screen.getByRole('button', { name: 'Suspend' })); expect(await screen.findByText(/Write the reason/)).toBeInTheDocument(); await userEvent.type(screen.getByLabelText('Reason'), 'Left'); await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/last active super admin/); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ status: 'SUSPENDED', reason: 'Left' });
  });
  it('resets a password, shows it once, and unlocks a locked account', async () => {
    let d = udet({ locked: true }); route({ ...signIn(['PLATFORM_ADMIN']), 'GET /v1/admin/users/u1': () => res(200, d), 'POST /v1/admin/users/u1/reset-password': () => res(201, { temporaryPassword: 'Zz-Temp-9999-abcd', sessionsRevoked: 1 }), 'POST /v1/admin/users/u1/unlock': () => { d = udet(); return res(201, { ok: true }); } });
    mount('/staff/users/u1'); await userEvent.click(await screen.findByRole('button', { name: 'Unlock now' })); expect(await screen.findByText('Unlocked.')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Unlock now' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reset password…' })); await userEvent.type(screen.getByLabelText('Reason'), 'Forgot it'); await userEvent.click(screen.getByRole('button', { name: 'Reset password' })); expect(await screen.findByLabelText('One-time password')).toHaveTextContent('Zz-Temp-9999-abcd');
    await userEvent.click(screen.getByRole('button', { name: 'I have passed it on' })); expect(document.body.textContent).not.toContain('Zz-Temp-9999-abcd');
  });
  it('lets support sign someone out everywhere but offers nothing else, and the auditor only reads', async () => {
    route({ ...signIn(['SUPPORT_OPERATOR']), ...page(udet()), 'POST /v1/admin/users/u1/revoke-sessions': () => res(201, { revoked: 2 }) }); const { unmount } = mount('/staff/users/u1');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere…' })); await userEvent.type(screen.getByLabelText('Reason'), 'Lost phone'); await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' })); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reason: 'Lost phone' });
    expect(screen.queryByRole('button', { name: 'Save roles' })).toBeNull(); expect(screen.queryByRole('button', { name: /Reset password/ })).toBeNull(); expect(screen.queryByRole('button', { name: /two-step/i })).toBeNull(); unmount();
    route({ ...signIn(['AUDITOR']), ...page(udet()) }); mount('/staff/users/u1'); expect(await screen.findByText('Pat Platform')).toBeInTheDocument(); expect(screen.getByText('Roles changed')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Sign out everywhere/ })).toBeNull(); expect(screen.queryByRole('button', { name: 'Save roles' })).toBeNull();
  });
  it('resets two-step verification only when it is on', async () => {
    route({ ...signIn(['SUPER_ADMIN']), ...page(udet({ mfaEnabled: false })) }); const { unmount } = mount('/staff/users/u1'); expect(await screen.findByText(/Two-step verification is not set up/)).toBeInTheDocument(); unmount();
    route({ ...signIn(['SUPER_ADMIN']), ...page(udet()), 'POST /v1/admin/users/u1/mfa-reset': () => res(201, { ok: true }) }); mount('/staff/users/u1'); await userEvent.click(await screen.findByRole('button', { name: 'Reset two-step verification…' })); await userEvent.type(screen.getByLabelText('Reason'), 'Lost device'); await userEvent.click(screen.getByRole('button', { name: 'Reset two-step verification' })); expect(await screen.findByText('Two-step verification reset.')).toBeInTheDocument();
  });
});
