import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, messageFor } from '../api/client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mk = (impl: (url: string, init: RequestInit) => Response | Promise<Response>) => { const f = vi.fn(async (u: any, i: any) => impl(String(u), i ?? {})); return { c: new ApiClient('', f as any), f }; };

describe('ApiClient', () => {
  it('sends the bearer token and parses JSON', async () => {
    const { c, f } = mk(() => json(200, { ok: true })); c.setTokens({ accessToken: 'AT', refreshToken: 'RT' });
    expect(await c.get('/v1/x')).toEqual({ ok: true }); expect((f.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer AT');
  });
  it('refreshes once on 401, retries, and keeps the rotated refresh token', async () => {
    let n = 0; const { c, f } = mk((u) => { if (u.endsWith('/auth/refresh')) return json(201, { accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 900, roles: [] }); return n++ === 0 ? json(401, {}) : json(200, { data: 1 }); });
    c.setTokens({ accessToken: 'AT', refreshToken: 'RT' });
    expect(await c.get('/v1/x')).toEqual({ data: 1 }); expect(sessionStorage.getItem('edtech.rt')).toBe('RT2');
    expect(f.mock.calls.map((x) => x[0])).toEqual(['/v1/x', '/v1/auth/refresh', '/v1/x']);
  });
  it('shares one refresh between concurrent 401s (refresh tokens are single-use)', async () => {
    const seen = new Set<string>(); const { c, f } = mk((u, i) => { if (u.endsWith('/auth/refresh')) return json(201, { accessToken: 'NEW', refreshToken: 'RT2', expiresIn: 900, roles: [] }); const t = (i.headers as any).Authorization; seen.add(t); return t === 'Bearer NEW' ? json(200, { ok: 1 }) : json(401, {}); });
    c.setTokens({ accessToken: 'OLD', refreshToken: 'RT' });
    await Promise.all([c.get('/v1/a'), c.get('/v1/b'), c.get('/v1/c')]);
    expect(f.mock.calls.filter((x) => String(x[0]).endsWith('/auth/refresh')).length).toBe(1);
  });
  it('signs the user out when refresh fails', async () => {
    const { c } = mk((u) => (u.endsWith('/auth/refresh') ? json(401, {}) : json(401, {}))); c.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); const out = vi.fn(); c.subscribeLogout(out);
    await expect(c.get('/v1/x')).rejects.toMatchObject({ status: 401 }); expect(out).toHaveBeenCalled(); expect(c.signedIn).toBe(false); expect(sessionStorage.getItem('edtech.rt')).toBeNull();
  });
  it('restore() uses the stored refresh token after a reload', async () => {
    sessionStorage.setItem('edtech.rt', 'RT'); const { c } = mk(() => json(201, { accessToken: 'AT', refreshToken: 'RT2', expiresIn: 900, roles: [] }));
    expect(await c.restore()).toBe(true); expect(c.signedIn).toBe(true);
    const none = mk(() => json(500, {})); sessionStorage.clear(); expect(await none.c.restore()).toBe(false);
  });
  it('adds Idempotency-Key only when asked, and a JSON content type only with a body', async () => {
    const { c, f } = mk(() => json(201, {})); c.setTokens({ accessToken: 'A', refreshToken: 'R' });
    await c.post('/v1/w', { a: 1 }, 'key-12345678'); await c.get('/v1/r');
    const h1 = (f.mock.calls[0][1] as any).headers, h2 = (f.mock.calls[1][1] as any).headers; expect(h1['Idempotency-Key']).toBe('key-12345678'); expect(h1['Content-Type']).toBe('application/json'); expect(h2['Idempotency-Key']).toBeUndefined(); expect(h2['Content-Type']).toBeUndefined();
  });
  it('uploads raw bytes as octet-stream', async () => {
    const { c, f } = mk(() => json(200, { key: 'k' })); c.setTokens({ accessToken: 'A', refreshToken: 'R' }); const blob = new Blob(['x']);
    await c.upload('/v1/u', blob); const init = f.mock.calls[0][1] as any; expect(init.headers['Content-Type']).toBe('application/octet-stream'); expect(init.body).toBe(blob);
  });
  it('login stores tokens when no second factor is needed, and otherwise returns the next step without signing in', async () => {
    const a = mk(() => json(201, { accessToken: 'A', refreshToken: 'R', expiresIn: 900, roles: ['LEARNER'] })); expect(await a.c.login('a@b.c', 'pw')).toEqual({ status: 'ok', roles: ['LEARNER'] }); expect(a.c.signedIn).toBe(true);
    const b = mk(() => json(201, { mfaRequired: true, mfaToken: 't' })); expect(await b.c.login('a@b.c', 'pw')).toEqual({ status: 'mfa', mfaToken: 't' }); expect(b.c.signedIn).toBe(false);
    const d = mk(() => json(201, { mfaEnrollmentRequired: true, enrollmentToken: 'e1' })); expect(await d.c.login('a@b.c', 'pw')).toEqual({ status: 'enroll', enrollmentToken: 'e1' });
  });
  it('completes the second factor and enrolment with the right credentials in the right places', async () => {
    const m = mk((u) => (u.endsWith('/mfa/verify') ? json(201, { accessToken: 'A2', refreshToken: 'R2', expiresIn: 900, roles: ['AUDITOR'] }) : json(201, {}))); await m.c.verifyMfa('mfa-token', ' 123456 ');
    expect(JSON.parse((m.f.mock.calls[0][1] as any).body)).toEqual({ mfaToken: 'mfa-token', code: '123456' }); expect((m.f.mock.calls[0][1] as any).headers.Authorization).toBeUndefined(); expect(m.c.signedIn).toBe(true);
    const e = mk((u) => (u.endsWith('/enroll/start') ? json(201, { secret: 'SECRET', otpauthUri: 'otpauth://totp/x' }) : json(201, { enabled: true, backupCodes: ['aaaa-bbbb'], accessToken: 'A3', refreshToken: 'R3' })));
    expect(await e.c.enrollStart('enroll-token')).toMatchObject({ secret: 'SECRET' }); expect((e.f.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer enroll-token'); // the enrolment token, not an access token
    const r = await e.c.enrollConfirm('enroll-token', '654321'); expect(r.backupCodes).toEqual(['aaaa-bbbb']); expect(e.c.signedIn).toBe(true); expect(sessionStorage.getItem('edtech.rt')).toBe('R3');
  });
  it('reads a paginated list: the body plus the next-cursor header', async () => {
    const m = mk(() => new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { 'X-Next-Cursor': 'c2' } })); m.c.setTokens({ accessToken: 'A', refreshToken: 'R' }); expect(await m.c.page('/v1/x')).toEqual({ items: [{ id: 1 }], next: 'c2' });
    const last = mk(() => json(200, [])); last.c.setTokens({ accessToken: 'A', refreshToken: 'R' }); expect(await last.c.page('/v1/x')).toEqual({ items: [], next: null });
  });
  it('wrong credentials surface as ApiError without a refresh loop', async () => {
    const { c, f } = mk(() => json(401, { message: 'Unauthorized' })); await expect(c.login('a@b.c', 'bad')).rejects.toBeInstanceOf(ApiError); expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('messageFor', () => {
  it('is friendly and never leaks server internals for 5xx', () => {
    expect(messageFor(new ApiError(500, { message: 'stack trace at db.ts:1' }))).not.toContain('stack'); expect(messageFor(new ApiError(429, {}))).toMatch(/wait/);
    expect(messageFor(new ApiError(403, { message: 'topic locked' }))).toBe('topic locked'); expect(messageFor(new ApiError(400, { message: ['a', 'b'] }))).toBe('a, b');
    expect(messageFor(new ApiError(403, { error: 'consent_required' }))).toMatch(/notice/); expect(messageFor(new TypeError('Failed to fetch'))).toMatch(/connection/);
  });
});
