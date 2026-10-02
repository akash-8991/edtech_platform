import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret'; process.env.ADMISSIONS_HMAC_SECRET = 'hmac-secret';
process.env.CORS_ORIGINS = 'https://app.example.org'; process.env.METRICS_TOKEN = 'metrics-token-1234567890abcd';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { configureApp } from '../src/platform/configure';
import { listRoutes } from '../src/platform/inventory';
import { base32Decode, stepOf, hotp, totp } from '../src/domain/totp';
import { SessionService } from '../src/security/sessions';

const prisma = new PrismaClient();
let app: INestApplication; let h: any;
const PW = 'Correct-Horse-Battery-9';
const ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'CONTENT_AUTHOR', 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', 'ASSESSMENT_ADMIN', 'EXAM_ADMIN', 'DOUBT_TEACHER', 'SUPPORT_OPERATOR', 'AUDITOR', 'LEARNER', 'LAB_COORDINATOR'];
const mk = async (email: string, role: string, o: any = {}) => prisma.user.create({ data: { email, name: email.split('@')[0], passwordHash: hashPassword(PW), roles: { create: { role: role as any } }, ...o } });
const login = (email: string, password = PW, ip?: string) => { const r = h.post('/v1/auth/login'); if (ip) r.set('X-Forwarded-For', ip); return r.send({ email, password }); };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const tokens: Record<string, string> = {};

// ---- local OIDC provider ------------------------------------------------------------------------------------------------------------
const idp = (() => {
  const state: any = { codes: new Map<string, any>(), url: '' }; let key: any, jwk: any;
  const srv = http.createServer((req, res) => {
    const json = (o: any, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/.well-known/openid-configuration') return json({ issuer: state.url, authorization_endpoint: `${state.url}/authorize`, token_endpoint: `${state.url}/token`, jwks_uri: `${state.url}/jwks` });
    if (req.url === '/jwks') return json({ keys: [jwk] });
    if (req.url === '/token' && req.method === 'POST') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
      const p = new URLSearchParams(b); const c = state.codes.get(p.get('code')!); state.codes.delete(p.get('code')!);
      if (!c || p.get('client_secret') !== 'idp-secret' || p.get('client_id') !== 'platform' || createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
      const jwt = await new SignJWT({ email: c.email, email_verified: c.verified ?? true, nonce: c.nonce, amr: c.amr, ...(c.extra ?? {}) }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(c.iss ?? state.url).setAudience(c.aud ?? 'platform').setSubject(c.sub).setIssuedAt().setExpirationTime('5m').sign(key);
      json({ id_token: jwt, access_token: 'x', token_type: 'Bearer' }); }); return; }
    res.writeHead(404); res.end();
  });
  return {
    async start() { const k = await generateKeyPair('RS256'); key = k.privateKey; jwk = { ...(await exportJWK(k.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }; await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); state.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; return state.url; },
    stop: () => new Promise((r) => srv.close(r)),
    /** the "browser": follow the platform's authorization URL, authenticate the user, return the code + state */
    authorize(authorizationUrl: string, user: { sub: string; email: string; amr?: string[]; verified?: boolean; iss?: string; aud?: string; nonce?: string }) {
      const u = new URL(authorizationUrl); const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.set(code, { nonce: user.nonce ?? u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), ...user }); return { code, state: u.searchParams.get('state')! };
    },
  };
})();

beforeAll(async () => {
  const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  const issuer = await idp.start(); Object.assign(process.env, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'platform', OIDC_CLIENT_SECRET: 'idp-secret', OIDC_REDIRECT_URI: 'https://app.example.org/cb' });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ rawBody: true } as any); configureApp(app); await app.init(); h = request(app.getHttpServer());
});
afterAll(async () => { await app.close(); await idp.stop(); await prisma.$disconnect(); });

describe('platform hardening: headers, CORS, correlation, health, metrics', () => {
  it('API responses carry hardened headers and are never cacheable; no server fingerprint', async () => {
    const r = await h.get('/health').expect(200);
    expect(r.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-site' });
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/); expect(r.headers['permissions-policy']).toMatch(/camera=\(\)/); expect(r.headers['x-powered-by']).toBeUndefined();
  });
  it('correlation id: a well-formed one is echoed, a malformed (log-injection) one is replaced', async () => {
    expect((await h.get('/health').set('X-Correlation-Id', 'req-12345678').expect(200)).headers['x-correlation-id']).toBe('req-12345678');
    const bad = (await h.get('/health').set('X-Correlation-Id', 'bad id; with spaces and "quotes"').expect(200)).headers['x-correlation-id']; expect(bad).toMatch(/^[0-9a-f]{16}$/); // not echoed into logs/headers
  });
  it('CORS: exact allow-listed origin only; unknown origins get no CORS headers; preflight is answered without reaching handlers', async () => {
    const ok = await h.get('/health').set('Origin', 'https://app.example.org'); expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.org'); expect(ok.headers.vary).toMatch(/Origin/);
    const no = await h.get('/health').set('Origin', 'https://evil.example'); expect(no.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await h.options('/v1/auth/login').set('Origin', 'https://app.example.org').set('Access-Control-Request-Method', 'POST').expect(204); expect(pre.headers['access-control-allow-headers']).toMatch(/Authorization/);
    await h.options('/v1/auth/login').set('Origin', 'https://evil.example').expect(403);
  });
  it('liveness, readiness (database), and an authenticated metrics endpoint with bounded label cardinality', async () => {
    await h.get('/health/ready').expect(200).expect((r: any) => expect(r.body.status).toBe('ready'));
    await h.get('/metrics').expect(401); await h.get('/metrics').set('Authorization', 'Bearer nope').expect(401);
    await h.get('/v1/auth/me').expect(401); await h.get('/v1/topics/00000000-0000-0000-0000-000000000001').expect(401);
    const m = (await h.get('/metrics').set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`).expect(200)).text;
    expect(m).toMatch(/http_requests_total\{method="GET",route="\/health",status="200"\} \d+/); expect(m).toMatch(/route="\/v1\/topics\/:id"/); expect(m).not.toMatch(/00000000-0000-0000-0000-000000000001/); // route template, never the raw URL
    expect(m).toMatch(/http_request_duration_seconds_bucket/); expect(m).toMatch(/nodejs_eventloop_lag_p99_seconds/); expect(m).toMatch(/jobs_queue_depth|grading_pending_submissions/);
    delete process.env.METRICS_TOKEN; await h.get('/metrics').set('Authorization', 'Bearer x').expect(404); process.env.METRICS_TOKEN = 'metrics-token-1234567890abcd';
  });
  it('body size limit, malformed JSON, and injection-looking input are handled safely', async () => {
    await mk('inj@x.test', 'LEARNER'); const t = (await login('inj@x.test').expect(201)).body.accessToken;
    await h.post('/v1/auth/login').set('Content-Type', 'application/json').send('{"email": ').expect(400);
    await h.post('/v1/auth/login').send({ email: 'a@b.c', password: 'x'.repeat(3 * 1024 * 1024) }).expect(413);
    await h.get("/v1/me/notifications?x=' OR 1=1; DROP TABLE \"User\";--").set(auth(t)).expect(200); expect(await prisma.user.count()).toBeGreaterThan(0);
    await h.post('/v1/auth/login').send({ email: { $ne: null }, password: { $ne: null } }).expect(400); // type confusion rejected, not coerced
  });
  it('raw-body signature verification still works after the body parser is configured (admissions HMAC)', async () => {
    const raw = JSON.stringify({ applications: [] }), ts = Date.now();
    await h.post('/v1/admissions/applications').set({ 'x-timestamp': String(ts), 'x-signature': createHmac('sha256', 'hmac-secret').update(`${ts}.${raw}`).digest('hex'), 'content-type': 'application/json' }).send(raw).expect(201);
    await h.post('/v1/admissions/applications').set({ 'x-timestamp': String(ts), 'x-signature': 'ab'.repeat(32), 'content-type': 'application/json' }).send(raw).expect(401);
  });
});

describe('rate limiting', () => {
  // the test client always connects from 127.0.0.1; trusting one proxy hop lets X-Forwarded-For stand in for distinct client IPs
  beforeAll(() => (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1)); afterAll(() => (app.getHttpAdapter().getInstance() as any).set('trust proxy', 0));
  afterEach(() => { process.env.RATE_LIMIT_DISABLED = '1'; delete process.env.RL_ACTOR_PER_MIN; delete process.env.RL_IP_PER_MIN; delete process.env.RL_LOGIN_PER_MIN; });
  it('per-actor limit returns 429 with Retry-After and does not affect other users', async () => {
    await mk('rl1@x.test', 'LEARNER'); await mk('rl2@x.test', 'LEARNER'); const a = (await login('rl1@x.test')).body.accessToken, b = (await login('rl2@x.test')).body.accessToken;
    process.env.RATE_LIMIT_DISABLED = '0'; process.env.RL_ACTOR_PER_MIN = '5'; process.env.RL_IP_PER_MIN = '100000';
    const rs = []; for (let i = 0; i < 8; i++) rs.push((await h.get('/v1/auth/me').set(auth(a))).status); expect(rs.filter((s) => s === 200)).toHaveLength(5); expect(rs.filter((s) => s === 429)).toHaveLength(3);
    const r = await h.get('/v1/auth/me').set(auth(a)).expect(429); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0); expect(r.body.error).toBe('rate_limited'); await h.get('/v1/auth/me').set(auth(b)).expect(200);
  });
  it('per-IP limit covers unauthenticated floods and invalid-token spam', async () => {
    process.env.RATE_LIMIT_DISABLED = '0'; process.env.RL_IP_PER_MIN = '6'; process.env.RL_ACTOR_PER_MIN = '100000';
    const st = []; for (let i = 0; i < 9; i++) st.push((await h.get('/v1/auth/me').set('X-Forwarded-For', '9.9.9.9').set('Authorization', 'Bearer junk')).status); expect(st.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    await h.get('/health').expect(200); // probes are exempt
  });
  it('sign-in attempts are throttled per IP and per account', async () => {
    await mk('rl3@x.test', 'LEARNER'); process.env.RATE_LIMIT_DISABLED = '0'; process.env.RL_LOGIN_PER_MIN = '4'; process.env.RL_IP_PER_MIN = '100000'; process.env.RL_ACTOR_PER_MIN = '100000';
    const st = []; for (let i = 0; i < 7; i++) st.push((await login('nobody@x.test', 'wrong-password-1', '7.7.7.7')).status); expect(st.slice(0, 4).every((s) => s === 401)).toBe(true); expect(st.slice(4).every((s) => s === 429)).toBe(true);
    expect((await login('rl3@x.test', PW, '8.8.8.8')).status).toBe(201); // other IPs unaffected
  });
});

describe('sessions, refresh tokens, lockout, passwords', () => {
  it('login issues an access token bound to a live session plus a refresh token; revoking the session cuts access immediately', async () => {
    await mk('s1@x.test', 'LEARNER'); const r = (await login('s1@x.test').expect(201)).body; expect(r).toMatchObject({ expiresIn: 900, roles: ['LEARNER'] }); expect(r.refreshToken.length).toBeGreaterThan(30);
    await h.get('/v1/auth/me').set(auth(r.accessToken)).expect(200); const list = (await h.get('/v1/me/sessions').set(auth(r.accessToken)).expect(200)).body; expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ current: true, method: 'PASSWORD', mfa: false });
    await h.post('/v1/auth/logout').set(auth(r.accessToken)).expect(201); await h.get('/v1/auth/me').set(auth(r.accessToken)).expect(401); await h.post('/v1/auth/refresh').send({ refreshToken: r.refreshToken }).expect(401); // logout kills refresh too
  });
  it('refresh tokens rotate; presenting a used one is treated as theft and revokes the session', async () => {
    await mk('s2@x.test', 'LEARNER'); const a = (await login('s2@x.test')).body;
    const b = (await h.post('/v1/auth/refresh').send({ refreshToken: a.refreshToken }).expect(201)).body; expect(b.refreshToken).not.toBe(a.refreshToken); await h.get('/v1/auth/me').set(auth(b.accessToken)).expect(200);
    await h.post('/v1/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401); // replay of the old token
    await h.get('/v1/auth/me').set(auth(b.accessToken)).expect(401); await h.post('/v1/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401); // the whole session is dead, including the legitimate chain
    expect((await prisma.auditEvent.findMany({ where: { action: 'auth.refresh_reuse' } })).length).toBe(1); await h.post('/v1/auth/refresh').send({ refreshToken: 'garbage' }).expect(401);
  });
  it('a demotion takes effect at the next refresh; deactivated users lose their sessions', async () => {
    const u = await mk('s3@x.test', 'CONTENT_AUTHOR'); const a = (await login('s3@x.test')).body; await h.get('/v1/authoring/versions/00000000-0000-0000-0000-000000000000').set(auth(a.accessToken)).expect(404);
    await prisma.userRole.deleteMany({ where: { userId: u.id } }); await prisma.userRole.create({ data: { userId: u.id, role: 'LEARNER' } });
    const b = (await h.post('/v1/auth/refresh').send({ refreshToken: a.refreshToken }).expect(201)).body; expect(b.roles).toEqual(['LEARNER']); await h.get('/v1/authoring/versions/00000000-0000-0000-0000-000000000000').set(auth(b.accessToken)).expect(403);
    await prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } }); await h.get('/v1/auth/me').set(auth(b.accessToken)).expect(401); await login('s3@x.test').expect(401);
  });
  it('users can list and revoke their own sessions; the session cap evicts the oldest; others cannot see them', async () => {
    const u = await mk('s4@x.test', 'LEARNER'); const toks: any[] = []; for (let i = 0; i < 6; i++) toks.push((await login('s4@x.test')).body);
    await h.get('/v1/auth/me').set(auth(toks[0].accessToken)).expect(401); await h.get('/v1/auth/me').set(auth(toks[5].accessToken)).expect(200); // 6th login pushed out the 1st (cap 5)
    const list = (await h.get('/v1/me/sessions').set(auth(toks[5].accessToken))).body; expect(list).toHaveLength(5);
    const other = (await login('s1@x.test')).body; await h.delete(`/v1/me/sessions/${list[1].id}`).set(auth(other.accessToken)).expect(404);
    await h.delete(`/v1/me/sessions/${list.find((s: any) => !s.current).id}`).set(auth(toks[5].accessToken)).expect(200); expect((await h.get('/v1/me/sessions').set(auth(toks[5].accessToken))).body).toHaveLength(4); void u;
  });
  it('staff can revoke a compromised account\'s sessions (reasoned, audited); learners cannot', async () => {
    await mk('s5@x.test', 'LEARNER'); const v = await prisma.user.findUniqueOrThrow({ where: { email: 's5@x.test' } }); const vt = (await login('s5@x.test')).body.accessToken;
    await mk('sup@x.test', 'SUPPORT_OPERATOR'); const st = (await login('sup@x.test')).body.accessToken;
    await h.post(`/v1/admin/users/${v.id}/revoke-sessions`).set(auth(vt)).send({ reason: 'x' }).expect(403); await h.post(`/v1/admin/users/${v.id}/revoke-sessions`).set(auth(st)).send({}).expect(400);
    expect((await h.post(`/v1/admin/users/${v.id}/revoke-sessions`).set(auth(st)).send({ reason: 'Lost phone reported' }).expect(201)).body.revoked).toBe(1); await h.get('/v1/auth/me').set(auth(vt)).expect(401);
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { action: 'auth.sessions_revoked_by_admin' } })).reason).toBe('Lost phone reported');
  });
  it('repeated failures lock the account (generic error, correct password refused while locked); unknown users get the same response', async () => {
    const u = await mk('lock@x.test', 'LEARNER'); let last: any;
    for (let i = 0; i < 5; i++) last = await login('lock@x.test', 'Wrong-Password-1'); expect(last.status).toBe(401);
    const locked = await login('lock@x.test', PW); expect(locked.status).toBe(401); expect(locked.body).toEqual((await login('ghost@x.test', 'Wrong-Password-1')).body); // indistinguishable from unknown user / bad password
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await prisma.auditEvent.findMany({ where: { action: 'auth.account_locked', objectId: u.id } })).length).toBe(1);
    await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } }); await login('lock@x.test', PW).expect(201);
    expect((await prisma.auditEvent.count({ where: { objectId: u.id, action: { startsWith: 'auth.' } } }))).toBeLessThanOrEqual(3); // failed-login floods cannot flood the audit chain
  });
  it('password change enforces policy, needs the current password, and signs every other device out', async () => {
    await mk('pw@x.test', 'LEARNER'); const a = (await login('pw@x.test')).body, b = (await login('pw@x.test')).body;
    await h.post('/v1/auth/password').set(auth(a.accessToken)).send({ current: 'wrong', next: 'Another-Strong-Pass-7' }).expect(401);
    const weak = await h.post('/v1/auth/password').set(auth(a.accessToken)).send({ current: PW, next: 'pw12345' }).expect(400); expect(weak.body.issues.length).toBeGreaterThan(0);
    expect((await h.post('/v1/auth/password').set(auth(a.accessToken)).send({ current: PW, next: 'Another-Strong-Pass-7' }).expect(201)).body.otherSessionsRevoked).toBe(1);
    await h.get('/v1/auth/me').set(auth(b.accessToken)).expect(401); await h.get('/v1/auth/me').set(auth(a.accessToken)).expect(200); await login('pw@x.test', PW).expect(401); await login('pw@x.test', 'Another-Strong-Pass-7').expect(201);
  });
});

describe('multi-factor authentication for privileged roles (IAM-006)', () => {
  beforeAll(() => { process.env.MFA_ENFORCE = '1'; }); afterAll(() => { delete process.env.MFA_ENFORCE; });
  let enrollTok: string; let secret: Buffer; let backup: string[]; let userId: string;
  it('learners are unaffected; a privileged account without MFA must enrol before it gets a session', async () => {
    await mk('lm@x.test', 'LEARNER'); await login('lm@x.test').expect(201).expect((r: any) => expect(r.body.accessToken).toBeTruthy());
    userId = (await mk('adm@x.test', 'ACADEMIC_ADMIN')).id; const r = (await login('adm@x.test').expect(201)).body; expect(r).toMatchObject({ mfaEnrollmentRequired: true }); expect(r.accessToken).toBeUndefined(); enrollTok = r.enrollmentToken;
    await h.get('/v1/auth/me').set(auth(enrollTok)).expect(401); // an enrolment token is not an access token
  });
  it('enrolment: QR/secret, code confirmation, one-time backup codes, secret encrypted at rest', async () => {
    await h.post('/v1/auth/mfa/enroll/start').expect(400); await h.post('/v1/auth/mfa/enroll/start').set(auth('junk')).expect(401);
    const s = (await h.post('/v1/auth/mfa/enroll/start').set(auth(enrollTok)).expect(201)).body; expect(s.otpauthUri).toMatch(/^otpauth:\/\/totp\//); secret = base32Decode(s.secret);
    const stored = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mfaSecretEnc!; expect(stored).not.toContain(s.secret); expect(Buffer.from(stored, 'base64').toString('latin1')).not.toContain(s.secret);
    await h.post('/v1/auth/mfa/enroll/confirm').set(auth(enrollTok)).send({ code: '000000' }).expect(400);
    const c = (await h.post('/v1/auth/mfa/enroll/confirm').set(auth(enrollTok)).send({ code: totp(secret) }).expect(201)).body; expect(c.enabled).toBe(true); expect(c.backupCodes).toHaveLength(8); expect(c.accessToken).toBeTruthy(); backup = c.backupCodes;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mfaBackupHashes).toHaveLength(8); expect(JSON.stringify(await prisma.user.findUniqueOrThrow({ where: { id: userId } }))).not.toContain(backup[0]); // only hashes stored
    expect((await h.get('/v1/auth/me').set(auth(c.accessToken)).expect(200)).body.mfaEnabled).toBe(true); await h.post('/v1/auth/mfa/enroll/start').set(auth(c.accessToken)).expect(409);
  });
  it('sign-in needs password then TOTP; codes cannot be replayed; the MFA step token is single-purpose', async () => {
    await prisma.user.update({ where: { id: userId }, data: { mfaLastStep: 0 } });
    const r = (await login('adm@x.test').expect(201)).body; expect(r).toMatchObject({ mfaRequired: true }); expect(r.accessToken).toBeUndefined(); await h.get('/v1/auth/me').set(auth(r.mfaToken)).expect(401);
    await h.post('/v1/auth/mfa/verify').send({ mfaToken: r.mfaToken, code: '123456' }).expect(401);
    const code = hotp(secret, stepOf(Date.now()) + 1); const ok = (await h.post('/v1/auth/mfa/verify').send({ mfaToken: r.mfaToken, code }).expect(201)).body; expect(ok.accessToken).toBeTruthy();
    expect((await h.get('/v1/me/sessions').set(auth(ok.accessToken))).body[0].mfa).toBe(true);
    const r2 = (await login('adm@x.test')).body; await h.post('/v1/auth/mfa/verify').send({ mfaToken: r2.mfaToken, code }).expect(401); // same code again: replay refused
    await h.post('/v1/auth/mfa/verify').send({ mfaToken: 'junk', code }).expect(401); await h.post('/v1/auth/mfa/verify').send({ mfaToken: r2.enrollmentToken ?? enrollTok, code }).expect(401); // wrong token purpose
  });
  it('backup codes work exactly once; repeated wrong codes lock the account', async () => {
    const r = (await login('adm@x.test')).body; await h.post('/v1/auth/mfa/verify').send({ mfaToken: r.mfaToken, code: backup[0] }).expect(201);
    const r2 = (await login('adm@x.test')).body; await h.post('/v1/auth/mfa/verify').send({ mfaToken: r2.mfaToken, code: backup[0] }).expect(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mfaBackupHashes).toHaveLength(7);
    for (let i = 0; i < 5; i++) { const t = (await login('adm@x.test')); if (!t.body.mfaToken) break; await h.post('/v1/auth/mfa/verify').send({ mfaToken: t.body.mfaToken, code: '000000' }).expect(401); }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).lockedUntil).not.toBeNull(); await login('adm@x.test').expect(401);
  });
  it('MFA reset is a reasoned, audited platform-admin action that also signs the user out; admins cannot reset themselves', async () => {
    await prisma.user.update({ where: { id: userId }, data: { lockedUntil: null } });
    const p = await mk('plat@x.test', 'PLATFORM_ADMIN');
    // enrol the platform admin properly to obtain a session
    const fresh = (await login('plat@x.test')).body; const st = (await h.post('/v1/auth/mfa/enroll/start').set(auth(fresh.enrollmentToken)).expect(201)).body; const sec = base32Decode(st.secret);
    const sess = (await h.post('/v1/auth/mfa/enroll/confirm').set(auth(fresh.enrollmentToken)).send({ code: totp(sec) }).expect(201)).body;
    await h.post(`/v1/admin/users/${p.id}/mfa-reset`).set(auth(sess.accessToken)).send({ reason: 'self' }).expect(403); await h.post(`/v1/admin/users/${userId}/mfa-reset`).set(auth(sess.accessToken)).send({}).expect(400);
    await h.post(`/v1/admin/users/${userId}/mfa-reset`).set(auth(sess.accessToken)).send({ reason: 'Phone lost, identity verified in person' }).expect(201);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ mfaEnabled: false, mfaSecretEnc: null, mfaBackupHashes: [] }); expect((await login('adm@x.test')).body.mfaEnrollmentRequired).toBe(true);
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { action: 'auth.mfa_reset' } })).reason).toMatch(/identity verified/);
  });
});

describe('OIDC single sign-on', () => {
  const run = async (user: any, mutate?: (q: { code: string; state: string }) => any) => {
    const { authorizationUrl } = (await h.get('/v1/auth/sso/start').expect(200)).body; const q = idp.authorize(authorizationUrl, user); const m = mutate ? mutate(q) : q;
    return h.get(`/v1/auth/sso/callback?code=${m.code}&state=${m.state}`);
  };
  it('start builds an authorization-code + PKCE (S256) request with state and nonce', async () => {
    const u = new URL((await h.get('/v1/auth/sso/start').expect(200)).body.authorizationUrl); expect(u.searchParams.get('code_challenge_method')).toBe('S256'); expect(u.searchParams.get('response_type')).toBe('code'); expect(u.searchParams.get('state')!.length).toBeGreaterThan(20); expect(u.searchParams.get('nonce')!.length).toBeGreaterThan(20);
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.org/cb'); expect(await prisma.oidcLogin.count()).toBeGreaterThan(0);
  });
  it('a verified identity maps to an existing account, binds the IdP subject, and gets a session; no auto-provisioning', async () => {
    const u = await mk('sso1@x.test', 'LEARNER'); const r = await run({ sub: 'idp-111', email: 'SSO1@x.test', amr: ['pwd'] }); expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy(); expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).externalId).toBe('idp-111'); expect((await h.get('/v1/me/sessions').set(auth(r.body.accessToken))).body[0].method).toBe('OIDC');
    expect((await run({ sub: 'idp-111', email: 'someone-else@x.test' })).status).toBe(200); // bound by subject, email may change at the IdP
    expect((await run({ sub: 'idp-new', email: 'nobody@x.test' })).status).toBe(403); expect(await prisma.user.count({ where: { email: 'nobody@x.test' } })).toBe(0);
    await mk('sso2@x.test', 'LEARNER', { externalId: 'idp-other' }); expect((await run({ sub: 'idp-222', email: 'sso2@x.test' })).status).toBe(403); // account already bound to a different identity
    expect((await prisma.auditEvent.findMany({ where: { action: 'auth.login_sso' } })).length).toBeGreaterThanOrEqual(2);
  });
  it('rejects forged or replayed flows: wrong nonce, issuer, audience; unverified email; replayed or unknown state; wrong PKCE', async () => {
    await mk('sso3@x.test', 'LEARNER');
    expect((await run({ sub: 'i3', email: 'sso3@x.test', nonce: 'attacker-nonce' })).status).toBe(401);
    expect((await run({ sub: 'i3', email: 'sso3@x.test', iss: 'https://evil.example' })).status).toBe(401);
    expect((await run({ sub: 'i3', email: 'sso3@x.test', aud: 'other-client' })).status).toBe(401);
    expect((await run({ sub: 'i3', email: 'sso3@x.test', verified: false })).status).toBe(403);
    const { authorizationUrl } = (await h.get('/v1/auth/sso/start')).body; const q = idp.authorize(authorizationUrl, { sub: 'i3', email: 'sso3@x.test' });
    await h.get(`/v1/auth/sso/callback?code=${q.code}&state=${q.state}`).expect(200); const q2 = idp.authorize(authorizationUrl, { sub: 'i3', email: 'sso3@x.test' }); await h.get(`/v1/auth/sso/callback?code=${q2.code}&state=${q.state}`).expect(401); // state is single-use
    expect((await run({ sub: 'i3', email: 'sso3@x.test' }, (x) => ({ ...x, state: 'forged-state' }))).status).toBe(401); await h.get('/v1/auth/sso/callback').expect(400);
    const wrongPkce = (await h.get('/v1/auth/sso/start')).body.authorizationUrl; const u = new URL(wrongPkce); u.searchParams.set('code_challenge', 'tampered'); const x = idp.authorize(u.toString(), { sub: 'i3', email: 'sso3@x.test' }); await h.get(`/v1/auth/sso/callback?code=${x.code}&state=${u.searchParams.get('state')}`).expect(401);
  });
  it('privileged accounts must authenticate with MFA at the identity provider when MFA is enforced', async () => {
    process.env.MFA_ENFORCE = '1'; try {
      await mk('ssoadm@x.test', 'ACADEMIC_ADMIN');
      expect((await run({ sub: 'adm-1', email: 'ssoadm@x.test', amr: ['pwd'] })).status).toBe(403);
      const ok = await run({ sub: 'adm-1', email: 'ssoadm@x.test', amr: ['pwd', 'mfa'] }); expect(ok.status).toBe(200); expect((await h.get('/v1/me/sessions').set(auth(ok.body.accessToken))).body[0].mfa).toBe(true);
      await mk('ssolearn@x.test', 'LEARNER'); expect((await run({ sub: 'l-1', email: 'ssolearn@x.test', amr: ['pwd'] })).status).toBe(200);
    } finally { delete process.env.MFA_ENFORCE; }
  });
});

describe('authorization audit: every route is protected as declared (default-deny)', () => {
  const UUID = '00000000-0000-4000-8000-000000000001';
  const PUBLIC_OK = new Set(['GET /health', 'GET /health/ready', 'GET /metrics', 'POST /v1/admissions/applications', 'POST /v1/auth/login', 'POST /v1/auth/mfa/enroll/confirm', 'POST /v1/auth/mfa/enroll/start', 'POST /v1/auth/mfa/verify', 'POST /v1/auth/refresh', 'GET /v1/auth/sso/callback', 'GET /v1/auth/sso/start', 'GET /v1/media/stream/:token', 'POST /v1/proctoring/webhook']);
  const SELF_SCOPED = new Set(['POST /v1/auth/logout', 'GET /v1/auth/me', 'POST /v1/auth/password', 'GET /v1/catalogue/versions/:id', 'GET /v1/catalogue', 'POST /v1/me/notifications/:id/read', 'GET /v1/me/notifications', 'DELETE /v1/me/sessions/:id', 'GET /v1/me/sessions',
    'GET /v1/me/consents', 'PUT /v1/me/consents', 'GET /v1/me/preferences', 'PUT /v1/me/preferences', 'GET /v1/me/privacy/requests/:id/download', 'GET /v1/me/privacy/requests', 'POST /v1/me/privacy/requests']);
  const call = (m: string, p: string, t?: string) => { const r = (h as any)[m.toLowerCase()](p.replace(/:\w+/g, UUID)); if (t) r.set(auth(t)); return m === 'GET' || m === 'DELETE' ? r : r.send({}); };
  let routes: ReturnType<typeof listRoutes>;
  beforeAll(async () => { routes = listRoutes(app); for (const r of ROLES) { await mk(`role-${r.toLowerCase()}@x.test`, r); tokens[r] = (await login(`role-${r.toLowerCase()}@x.test`)).body.accessToken; } });
  it('public routes are exactly the reviewed allow-list; authenticated-only routes are exactly the reviewed self-scoped list', () => {
    expect(new Set(routes.filter((r) => r.public).map((r) => `${r.method} ${r.path}`))).toEqual(PUBLIC_OK);
    expect(new Set(routes.filter((r) => !r.public && !r.roles).map((r) => `${r.method} ${r.path}`))).toEqual(SELF_SCOPED);
  });
  it('every non-public route rejects anonymous callers with 401', async () => {
    const bad: string[] = []; for (const r of routes.filter((x) => !x.public)) { const s = (await call(r.method, r.path)).status; if (s !== 401) bad.push(`${r.method} ${r.path} -> ${s}`); } expect(bad).toEqual([]);
  });
  it('every role-restricted route returns 403 to an authenticated user holding none of the allowed roles', async () => {
    const bad: string[] = []; let checked = 0;
    for (const r of routes.filter((x) => !x.public && x.roles)) { const wrong = ROLES.find((x) => !r.roles!.includes(x)); if (!wrong) continue; checked++; const s = (await call(r.method, r.path, tokens[wrong])).status; if (s !== 403) bad.push(`${r.method} ${r.path} as ${wrong} -> ${s}`); }
    expect(bad).toEqual([]); expect(checked).toBeGreaterThan(150);
  });
  it('the committed API/access-control inventory matches the code (regenerate with `npm run inventory` after intentional changes)', () => {
    const committed = JSON.parse(readFileSync(join(__dirname, '../../docs/api-inventory.json'), 'utf8')).routes;
    const now = routes.map(({ controller, handler, ...r }) => r);
    const key = (r: any) => `${r.method} ${r.path}`; const a = new Map<string, string>(committed.map((r: any): [string, string] => [key(r), JSON.stringify(r)])), b = new Map<string, string>(now.map((r: any): [string, string] => [key(r), JSON.stringify(r)]));
    const removed = [...a.keys()].filter((k) => !b.has(k)), added = [...b.keys()].filter((k) => !a.has(k)), changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
    expect({ removed, added, changed }).toEqual({ removed: [], added: [], changed: [] });
  });
  it('session cache: revocation is bounded by the cache TTL (documented), and immediate when TTL is 0', async () => {
    const svc = app.get(SessionService) as any; expect(SessionService.TTL_MS).toBe(0); expect(typeof svc.forget).toBe('function');
  });
});
