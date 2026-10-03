import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Privacy from '../pages/Privacy';
import Account from '../pages/Account';
import { PrefsProvider } from '../prefs';
import { api } from '../api/client';
import { applyPrefs, canDownload, describeRequest, friendlyDevice, hasOpen, loadPrefsLocal, savePrefsLocal } from '../lib/privacy';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; headers: any; body: any }[] = [];
type H = (c: { body: any; headers: any; n: number }) => Response;
const route = (map: Record<string, H>) => { const counts: Record<string, number> = {}; vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => {
  const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined; calls.push({ method, url, headers: init?.headers ?? {}, body });
  const k = `${method} ${url}`; counts[k] = (counts[k] ?? 0) + 1; const h = map[k]; return h ? h({ body, headers: init?.headers ?? {}, n: counts[k] }) : res(404, { message: `no route ${k}` }); })); };
beforeEach(() => { calls = []; api.clear(); api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); document.documentElement.removeAttribute('data-contrast'); });

const consent = (purpose: string, o: any = {}) => ({ purpose, granted: false, version: null, at: null, currentNoticeVersion: '2026-10', upToDate: false, ...o });
const CONSENTS = [consent('PLATFORM_PROCESSING', { granted: true, version: '2026-10', at: '2026-09-01T00:00:00Z', upToDate: true }), consent('AI_TUTOR'), consent('ANALYTICS', { granted: true, version: '2026-04', at: '2026-04-02T00:00:00Z', upToDate: false })];
const base = (reqs: any[] = [], extra: Record<string, H> = {}): Record<string, H> => ({ 'GET /v1/me/consents': () => res(200, CONSENTS), 'GET /v1/me/privacy/requests': () => res(200, reqs), 'GET /v1/me/preferences': () => res(200, {}), ...extra });
const page = () => render(<MemoryRouter><PrefsProvider><Privacy /></PrefsProvider></MemoryRouter>);
const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe('privacy helpers', () => {
  it('explains every request state and when a download is possible', () => {
    expect(describeRequest({ type: 'ERASURE', status: 'REQUESTED' }).label).toBe('Waiting for approval'); expect(describeRequest({ type: 'ERASURE', status: 'BLOCKED' }).blurb).toMatch(/active course or a legal hold/);
    expect(describeRequest({ type: 'EXPORT', status: 'COMPLETED', exportExpiresAt: future(3) }).label).toBe('Ready'); expect(describeRequest({ type: 'EXPORT', status: 'COMPLETED', exportExpiresAt: future(-1) }).label).toBe('Expired');
    expect(describeRequest({ type: 'CORRECTION', status: 'REJECTED', decisionReason: 'not verifiable' }).blurb).toContain('not verifiable');
    expect(canDownload({ type: 'EXPORT', status: 'COMPLETED', exportExpiresAt: future(1) })).toBe(true); expect(canDownload({ type: 'EXPORT', status: 'COMPLETED', exportExpiresAt: future(-1) })).toBe(false); expect(canDownload({ type: 'ERASURE', status: 'COMPLETED' })).toBe(false);
    expect(hasOpen([{ id: '1', type: 'EXPORT', status: 'PROCESSING', requestedAt: '' }], 'EXPORT')).toBe(true); expect(hasOpen([{ id: '1', type: 'EXPORT', status: 'COMPLETED', requestedAt: '' }], 'EXPORT')).toBe(false);
  });
  it('applies accessibility preferences to the document and remembers them locally', () => {
    applyPrefs({ highContrast: true, reducedMotion: true, largeTargets: true, textSpacing: 'wider', fontScale: 1.5, language: 'hi' }); const r = document.documentElement;
    expect(r.dataset).toMatchObject({ contrast: 'high', motion: 'reduced', targets: 'large', spacing: 'wider' }); expect(r.style.getPropertyValue('--font-scale')).toBe('1.5');
    applyPrefs({}); expect(r.dataset.contrast).toBe('normal'); expect(r.style.getPropertyValue('--font-scale')).toBe('1'); savePrefsLocal({ lowBandwidth: true, fontScale: 2 }); expect(loadPrefsLocal()).toEqual({ lowBandwidth: true, fontScale: 2 }); expect(localStorage.getItem('edtech.low')).toBe('1');
    localStorage.setItem('edtech.prefs', '{bad'); expect(loadPrefsLocal()).toEqual({});
  });
});

describe('friendlyDevice', () => {
  it('turns user-agent strings into something a person can recognise', () => {
    expect(friendlyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')).toBe('Chrome on Mac');
    expect(friendlyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120')).toBe('Edge on Windows'); expect(friendlyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Mobile Safari/604')).toBe('Safari on iPhone/iPad');
    expect(friendlyDevice('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('Firefox on Linux'); expect(friendlyDevice('curl/8.12.1')).toBe('Command-line tool'); expect(friendlyDevice('')).toBe('Unknown device'); expect(friendlyDevice('x'.repeat(60))).toBe(`${'x'.repeat(40)}…`);
  });
});

describe('Consents', () => {
  it('shows each purpose, flags a changed notice, and records a choice against the CURRENT notice version', async () => {
    route(base([], { 'PUT /v1/me/consents': ({ body }) => res(200, CONSENTS.map((c) => (c.purpose === body.purpose ? { ...c, granted: body.granted, upToDate: true, version: body.version, at: new Date().toISOString() } : c))) }));
    const u = userEvent.setup(); page(); expect(await screen.findByText('Running your course')).toBeInTheDocument(); expect(screen.getByText(/notice has changed \(now version 2026-10\)/)).toBeInTheDocument(); expect(screen.getByText(/may stop parts of the platform/)).toBeInTheDocument();
    const tutor = screen.getByRole('switch', { name: 'AI tutor consent' }); expect(tutor).not.toBeChecked(); await u.click(tutor);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'AI tutor consent' })).toBeChecked()); expect(calls.find((c) => c.method === 'PUT' && c.url === '/v1/me/consents')!.body).toEqual({ purpose: 'AI_TUTOR', granted: true, version: '2026-10' });
    expect(screen.getByRole('switch', { name: 'Learning analytics consent' })).not.toBeChecked(); // granted under an older notice does not count until re-confirmed
  });
  it('lets a learner withdraw consent', async () => {
    route(base([], { 'PUT /v1/me/consents': ({ body }) => res(200, CONSENTS.map((c) => (c.purpose === body.purpose ? { ...c, granted: false } : c))) }));
    const u = userEvent.setup(); page(); await u.click(await screen.findByRole('switch', { name: 'Running your course consent' })); await waitFor(() => expect(screen.getByRole('switch', { name: 'Running your course consent' })).not.toBeChecked()); expect(calls.find((c) => c.method === 'PUT')!.body.granted).toBe(false);
  });
});

describe('Data requests', () => {
  it('requires the password for a download request, sends it once with a retry-safe key, and refreshes the list', async () => {
    let filed = false;
    route(base([], { 'GET /v1/me/privacy/requests': () => res(200, filed ? [{ id: 'R1', type: 'EXPORT', status: 'APPROVED', requestedAt: new Date().toISOString() }] : []), 'POST /v1/me/privacy/requests': () => { filed = true; return res(201, { id: 'R1' }); } }));
    const u = userEvent.setup(); page(); await u.click(await screen.findByRole('button', { name: 'Download my data' })); const form = screen.getByRole('form', { name: 'Data download' }); const send = within(form).getByRole('button', { name: 'Send request' }); expect(send).toBeDisabled();
    await u.type(within(form).getByLabelText('Confirm your password'), 'Learner-Dev-Pass1'); await u.click(send);
    expect(await screen.findByText('Approved, in the queue')).toBeInTheDocument(); const post = calls.find((c) => c.method === 'POST')!; expect(post.body).toEqual({ type: 'EXPORT', password: 'Learner-Dev-Pass1' }); expect(post.headers['Idempotency-Key']).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download my data' })).toBeDisabled(); // one open request at a time, as the server enforces
  });
  it('shows a wrong password as the server says it, and keeps the form open', async () => {
    route(base([], { 'POST /v1/me/privacy/requests': () => res(403, { error: 'reauthentication_required', message: 'Confirm your password to continue' }) }));
    const u = userEvent.setup(); page(); await u.click(await screen.findByRole('button', { name: 'Download my data' })); await u.type(screen.getByLabelText('Confirm your password'), 'wrong'); await u.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm your password to continue'); expect(screen.getByRole('form', { name: 'Data download' })).toBeInTheDocument();
  });
  it('erasure needs the password AND typing ERASE, warns it is permanent, and sends the reason', async () => {
    route(base([], { 'POST /v1/me/privacy/requests': () => res(201, { id: 'R2' }) }));
    const u = userEvent.setup(); page(); await u.click(await screen.findByRole('button', { name: 'Erase my data' })); const f = screen.getByRole('form', { name: 'Erasure' }); expect(within(f).getByRole('alert')).toHaveTextContent(/cannot be undone/); const send = within(f).getByRole('button', { name: 'Send request' });
    await u.type(within(f).getByLabelText('Confirm your password'), 'pw-pw-pw-pw-1'); expect(send).toBeDisabled(); await u.type(within(f).getByLabelText(/Type/), 'erase'); expect(send).toBeDisabled(); await u.clear(within(f).getByLabelText(/Type/)); await u.type(within(f).getByLabelText(/Type/), 'ERASE');
    await u.type(within(f).getByLabelText(/Why are you asking/), 'Leaving the programme'); expect(send).toBeEnabled(); await u.click(send); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ type: 'ERASURE', details: { reason: 'Leaving the programme' }, password: 'pw-pw-pw-pw-1' });
  });
  it('a correction needs no password but does need a change, and offers language choices', async () => {
    route(base([], { 'POST /v1/me/privacy/requests': () => res(201, { id: 'R3' }) }));
    const u = userEvent.setup(); page(); await u.click(await screen.findByRole('button', { name: 'Correct my details' })); const f = screen.getByRole('form', { name: 'Correction' }); expect(within(f).queryByLabelText('Confirm your password')).toBeNull(); const send = within(f).getByRole('button', { name: 'Send request' }); expect(send).toBeDisabled();
    await u.type(within(f).getByLabelText('Name'), 'Asha R. Rao'); await u.selectOptions(within(f).getByLabelText('Language'), 'hi'); await u.click(send); await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true)); expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ type: 'CORRECTION', details: { name: 'Asha R. Rao', language: 'hi' } });
  });
  it('downloads a ready export through an authenticated request and hides expired ones', async () => {
    const created = vi.fn(() => 'blob:x'); const revoked = vi.fn(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked })); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    route(base([{ id: 'R1', type: 'EXPORT', status: 'COMPLETED', requestedAt: new Date().toISOString(), exportExpiresAt: future(5) }, { id: 'R0', type: 'EXPORT', status: 'COMPLETED', requestedAt: '2026-01-01T00:00:00Z', exportExpiresAt: future(-2) }, { id: 'R9', type: 'ERASURE', status: 'BLOCKED', requestedAt: '2026-01-01T00:00:00Z' }],
      { 'GET /v1/me/privacy/requests/R1/download': () => new Response('{"profile":{}}', { status: 200, headers: { 'content-type': 'application/json' } }) }));
    const u = userEvent.setup(); page(); const buttons = await screen.findAllByRole('button', { name: 'Download' }); expect(buttons).toHaveLength(1); expect(screen.getByText('Expired')).toBeInTheDocument(); expect(screen.getByText(/active course or a legal hold/)).toBeInTheDocument();
    await u.click(buttons[0]); await waitFor(() => expect(click).toHaveBeenCalled()); expect(created).toHaveBeenCalled(); expect(calls.find((c) => c.url.endsWith('/download'))!.headers.Authorization).toBe('Bearer AT'); click.mockRestore();
  });
});

describe('Preferences', () => {
  it('applies a setting immediately, saves only what changed, and rolls back if saving fails', async () => {
    let fail = false; route(base([], { 'PUT /v1/me/preferences': () => (fail ? res(500, {}) : res(200, {})) }));
    const u = userEvent.setup(); page(); const hc = await screen.findByRole('switch', { name: 'High contrast' }); await u.click(hc); expect(document.documentElement.dataset.contrast).toBe('high'); await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/v1/me/preferences')).toBe(true)); expect(calls.find((c) => c.method === 'PUT' && c.url === '/v1/me/preferences')!.body).toEqual({ highContrast: true });
    fail = true; await u.click(screen.getByRole('switch', { name: 'Reduce motion' })); expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(screen.getByRole('switch', { name: 'Reduce motion' })).not.toBeChecked(); expect(document.documentElement.dataset.motion).toBe('normal');
  });
  it('loads saved preferences for the learner and changes selects (text spacing, speed, language)', async () => {
    route(base([], { 'GET /v1/me/preferences': () => res(200, { reducedMotion: true, playbackSpeed: 1.5, language: 'hi' }), 'PUT /v1/me/preferences': () => res(200, {}) }));
    const u = userEvent.setup(); page(); expect(await screen.findByRole('switch', { name: 'Reduce motion' })).toBeInTheDocument(); expect(screen.getByLabelText('Video speed')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Text spacing'), 'wide'); await waitFor(() => expect(document.documentElement.dataset.spacing).toBe('wide')); expect(calls.some((c) => c.method === 'PUT' && JSON.stringify(c.body) === '{"textSpacing":"wide"}')).toBe(true);
  });
});

describe('Account and security', () => {
  const sessions = [{ id: 'S1', current: true, method: 'PASSWORD', mfa: false, device: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537', createdAt: '2026-10-02T10:00:00Z', lastSeenAt: '2026-10-02T11:00:00Z', expiresAt: '2026-11-01T00:00:00Z' }, { id: 'S2', current: false, method: 'PASSWORD', mfa: false, device: 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537', createdAt: '2026-10-01T10:00:00Z', expiresAt: '2026-11-01T00:00:00Z' }];
  const acct = () => render(<MemoryRouter><Account /></MemoryRouter>);
  it('lists sessions, marks this device, and signs another one out', async () => {
    let revoked = false; route({ 'GET /v1/me/sessions': () => res(200, revoked ? [sessions[0]] : sessions), 'DELETE /v1/me/sessions/S2': () => { revoked = true; return res(200, { ok: true }); } });
    const u = userEvent.setup(); acct(); expect(await screen.findByText('This device')).toBeInTheDocument(); expect(screen.getByText('Chrome on Android')).toBeInTheDocument(); expect(screen.getAllByRole('button', { name: 'Sign out this device' })).toHaveLength(1); await u.click(screen.getByRole('button', { name: 'Sign out this device' })); await waitFor(() => expect(screen.queryByText('Chrome on Android')).toBeNull());
  });
  it('changes the password only when the new one is confirmed, and says how many other devices were signed out', async () => {
    route({ 'GET /v1/me/sessions': () => res(200, sessions), 'POST /v1/auth/password': () => res(201, { ok: true, otherSessionsRevoked: 2 }) });
    const u = userEvent.setup(); acct(); const btn = await screen.findByRole('button', { name: 'Change password' }); await u.type(screen.getByLabelText('Current password'), 'Old-Pass-123456'); await u.type(screen.getByLabelText('New password'), 'New-Strong-Pass-7'); await u.type(screen.getByLabelText('Repeat the new password'), 'New-Strong-Pass-8');
    expect(screen.getByText(/do not match/)).toBeInTheDocument(); expect(btn).toBeDisabled(); await u.clear(screen.getByLabelText('Repeat the new password')); await u.type(screen.getByLabelText('Repeat the new password'), 'New-Strong-Pass-7'); await u.click(btn);
    expect(await screen.findByText(/2 other devices were signed out/)).toBeInTheDocument(); expect(calls.find((c) => c.url === '/v1/auth/password')!.body).toEqual({ current: 'Old-Pass-123456', next: 'New-Strong-Pass-7' }); expect(screen.getByLabelText('New password')).toHaveValue('');
  });
  it('lists exactly why a password was rejected', async () => {
    route({ 'GET /v1/me/sessions': () => res(200, sessions), 'POST /v1/auth/password': () => res(400, { error: 'weak_password', issues: ['at least 12 characters', 'too common'] }) });
    const u = userEvent.setup(); acct(); await u.type(await screen.findByLabelText('Current password'), 'x'); await u.type(screen.getByLabelText('New password'), 'password'); await u.type(screen.getByLabelText('Repeat the new password'), 'password'); await u.click(screen.getByRole('button', { name: 'Change password' }));
    const a = await screen.findByRole('alert'); expect(a).toHaveTextContent('at least 12 characters'); expect(a).toHaveTextContent('too common');
  });
});
