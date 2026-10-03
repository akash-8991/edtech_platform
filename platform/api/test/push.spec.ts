import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, createPublicKey, createVerify, createECDH, generateKeyPairSync, randomBytes, hkdfSync, createDecipheriv } from 'crypto';
import { execFileSync } from 'child_process';
import { Agent, createServer, Server } from 'https';
import { mkdtempSync, readFileSync, readFileSync as read, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import webpush from 'web-push';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { PUSH_PROVIDERS, FcmProvider, LogPushProvider, PushMessage, PushProvider, PushResult, PushTarget, WebPushProvider, buildPushProviders, signServiceJwt } from '../src/push/providers';
import { pushMessage, pushUrl } from '../src/push/text';
import { PushService } from '../src/push/push';
import { productionConfigProblems } from '../src/platform/config-guard';

const prisma = new PrismaClient();

describe('push text', () => {
  it('speaks the learner\'s language, links to the right screen, and says nothing for a type nobody can read', () => {
    expect(pushMessage('exam.result_released', {}, 'en')).toMatchObject({ title: 'Learning Portal', body: 'Your exam result has been released.' }); expect(pushMessage('exam.result_released', {}, 'hi')!.body).toBe('आपका परीक्षा परिणाम जारी हो गया है।'); expect(pushMessage('exam.result_released', {}, 'fr')!.body).toMatch(/^Your exam/);
    expect(pushMessage('internal.thing', {}, 'en')).toBeNull(); expect(pushUrl('exam.result_released', { attemptId: 'a1' })).toBe('/exam-results/a1'); expect(pushUrl('exam.registered', { attemptId: 'a1' })).toBe('/notifications'); expect(pushUrl('assignment.graded', { submissionId: 's9' })).toBe('/grades/s9'); expect(pushUrl('lab.booked', {})).toBe('/labs');
  });
  it('matches the text the web app shows for the same notification (so a push and the in-app list agree)', () => {
    const web = readFileSync(join(__dirname, '../../web/src/lib/format.ts'), 'utf8'); const hi = JSON.parse(readFileSync(join(__dirname, '../../web/src/i18n/hi.json'), 'utf8'));
    const rows = [...web.matchAll(/'([a-z]+\.[a-z_]+)': mark\('((?:[^'\\]|\\.)*)'\)/g)]; expect(rows.length).toBeGreaterThan(12);
    for (const [, type, text] of rows) { const m = pushMessage(type, {}, 'en'); expect([type, m?.body]).toEqual([type, text]); expect([type, pushMessage(type, {}, 'hi')!.body]).toEqual([type, hi[text]]); }
  });
});

describe('FCM provider', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { project_id: 'proj-1', client_email: 'svc@proj-1.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  it('signs a service-account JWT Google would accept', () => {
    const jwt = signServiceJwt(sa, 1_800_000_000_000); const [h, c, s] = jwt.split('.'); expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
  const mk = (responses: { status: number; body?: any }[]) => { const calls: { url: string; body?: any; auth?: string }[] = []; let i = 0; let now = 1_000_000;
    const f = (async (url: any, init: any) => { calls.push({ url: String(url), body: init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: `tok${++i}`, expires_in: 3600 }), { status: 200 }); const r = responses.shift() ?? { status: 200 }; return new Response(JSON.stringify(r.body ?? { name: 'm' }), { status: r.status }); }) as typeof fetch;
    return { p: new FcmProvider(sa, f, () => now), calls, tick: (ms: number) => { now += ms; } }; };
  const t: PushTarget = { id: 'd', platform: 'ANDROID', token: 'device-token-1' }; const m: PushMessage = { title: 'T', body: 'B', url: '/labs', tag: 'lab.booked' };
  it('sends once per token exchange, with the right message shape, and reuses the access token until it nears expiry', async () => {
    const x = mk([{ status: 200 }, { status: 200 }, { status: 200 }]); expect(await x.p.send(t, m)).toBe('sent'); expect(await x.p.send(t, m)).toBe('sent');
    const sends = x.calls.filter((c) => c.url.includes('/messages:send')); expect(x.calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1); expect(sends[0].url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send'); expect(sends[0].auth).toBe('Bearer tok1');
    expect(sends[0].body.message).toMatchObject({ token: 'device-token-1', notification: { title: 'T', body: 'B' }, data: { url: '/labs', tag: 'lab.booked' } }); expect(x.calls[0].body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    x.tick(3_600_000); expect(await x.p.send(t, m)).toBe('sent'); expect(x.calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
  });
  it('tells a dead token from a passing problem', async () => {
    expect(await mk([{ status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } }]).p.send(t, m)).toBe('gone'); expect(await mk([{ status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } }]).p.send(t, m)).toBe('gone');
    expect(await mk([{ status: 503, body: {} }]).p.send(t, m)).toBe('retry'); const x = mk([{ status: 401, body: {} }, { status: 200 }]); expect(await x.p.send(t, m)).toBe('retry'); expect(await x.p.send(t, m)).toBe('sent'); expect(x.calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2); // a rejected token is refreshed
    expect(new FcmProvider(sa, (async () => { throw new Error('network'); }) as any).send(t, m)).resolves.toBe('retry'); expect(new FcmProvider(sa).supports('WEB')).toBe(false);
  });
});

describe('Web Push provider, over the real protocol', () => {
  let server: Server; let port = 0; const seen: { headers: any; body: Buffer }[] = []; let status = 201; const dir = mkdtempSync(join(tmpdir(), 'wp-'));
  // a browser's subscription: P-256 key pair + 16-byte auth secret
  const ua = createECDH('prime256v1'); ua.generateKeys(); const auth = randomBytes(16); const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const vapid = webpush.generateVAPIDKeys(); const provider = () => new WebPushProvider({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:ops@example.edu' }, 86400, new Agent({ rejectUnauthorized: false })); // the stand-in push service has a self-signed certificate
  beforeAll(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    server = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => { const c: Buffer[] = []; req.on('data', (x) => c.push(x)); req.on('end', () => { seen.push({ headers: req.headers, body: Buffer.concat(c) }); res.statusCode = status; res.end(); }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  /** RFC 8291 decryption as a browser does it: ECDH with the sender's key, HKDF with the auth secret, AES-128-GCM. */
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen); const secret = ua.computeSecret(asPub);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32)); const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)); const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(cipher.subarray(cipher.length - 16)); const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]); return plain.subarray(0, plain.lastIndexOf(2)).toString();
  };
  const target = (): PushTarget => ({ id: 'w1', platform: 'WEB', token: `https://localhost:${port}/push/abc`, keys });
  it('delivers an encrypted payload the subscriber can read, signed with VAPID', async () => {
    status = 201; seen.length = 0; const r = await provider().send(target(), { title: 'Learning Portal', body: 'Your lab session is booked.', url: '/labs', tag: 'lab.booked' }); expect(r).toBe('sent'); expect(seen).toHaveLength(1);
    const h = seen[0].headers; expect(h['content-encoding']).toBe('aes128gcm'); expect(h.ttl).toBe('86400'); expect(JSON.parse(decrypt(seen[0].body))).toEqual({ title: 'Learning Portal', body: 'Your lab session is booked.', url: '/labs', tag: 'lab.booked' });
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.authorization)!; expect(m[2]).toBe(vapid.publicKey); const [jh, jc, js] = m[1].split('.'); const claims = JSON.parse(Buffer.from(jc, 'base64url').toString()); expect(claims.aud).toBe(`https://localhost:${port}`); expect(claims.sub).toBe('mailto:ops@example.edu');
    const pub = Buffer.from(vapid.publicKey, 'base64url'); const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(createVerify('SHA256').update(`${jh}.${jc}`).verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(js, 'base64url'))).toBe(true);
  });
  it('maps push-service answers: gone for unsubscribed or malformed, retry for a server fault', async () => {
    for (const [s, want] of [[410, 'gone'], [404, 'gone'], [400, 'gone'], [500, 'retry'], [429, 'retry']] as const) { status = s; expect(await provider().send(target(), { title: 't', body: 'b' })).toBe(want); }
    expect(await provider().send({ ...target(), keys: null }, { title: 't', body: 'b' })).toBe('gone'); expect(provider().supports('WEB')).toBe(true); expect(provider().supports('IOS')).toBe(false);
  });
});

describe('push configuration', () => {
  it('builds only the providers that are configured, and the production guard rejects half-configured push', () => {
    expect(buildPushProviders({})).toEqual([]); expect(buildPushProviders({ PUSH_MODE: 'log' } as any)[0].name).toBe('log'); expect(buildPushProviders({ PUSH_MODE: 'live' } as any)).toEqual([]);
    const v = webpush.generateVAPIDKeys(); expect(buildPushProviders({ PUSH_MODE: 'live', VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey } as any).map((p) => p.name)).toEqual(['webpush']);
    expect(buildPushProviders({ PUSH_MODE: 'live', FCM_SERVICE_ACCOUNT: '{not json' } as any)).toEqual([]);
    const base = { NODE_ENV: 'production', PROCESS_ROLE: 'api' } as any; const has = (env: any, re: RegExp) => productionConfigProblems({ ...base, ...env }).some((p) => re.test(p));
    expect(has({ PUSH_MODE: 'log' }, /PUSH_MODE=log/)).toBe(true); expect(has({ PUSH_MODE: 'live' }, /needs VAPID/)).toBe(true); expect(has({ PUSH_MODE: 'live', VAPID_PUBLIC_KEY: 'x' }, /VAPID_PRIVATE_KEY/)).toBe(true); expect(has({ PUSH_MODE: 'live', FCM_SERVICE_ACCOUNT: '{}' }, /service-account JSON/)).toBe(true); expect(has({}, /PUSH|VAPID|FCM/)).toBe(false);
  });
});

/** A provider that records and can be told how each device answers. */
class FakeProvider implements PushProvider { readonly name = 'fake'; sent: { token: string; m: PushMessage }[] = []; answers = new Map<string, PushResult>(); supports() { return true; } async send(t: PushTarget, m: PushMessage) { this.sent.push({ token: t.token, m }); return this.answers.get(t.token) ?? 'sent'; } }
describe('registration and delivery', () => {
  let app: INestApplication; let http: any; const tok: Record<string, string> = {}; const uid: Record<string, string> = {}; const fake = new FakeProvider(); let svc: PushService;
  const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
  const web = (n: number) => ({ platform: 'WEB', token: `https://push.example.test/send/${n}`, keys: { p256dh: 'BPk' + n, auth: 'au' + n }, language: 'en' });
  const note = (userId: string, type: string, ago = 0, payload: any = {}) => prisma.notification.create({ data: { userId, type, payload, createdAt: new Date(Date.now() - ago) } });
  beforeAll(async () => {
    const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PUSH_PROVIDERS).useValue([fake]).compile()).createNestApplication(); await app.init(); http = request(app.getHttpServer()); svc = app.get(PushService);
    for (const [k, lang] of [['asha', 'en'], ['ravi', 'hi'], ['mute', 'en']] as const) { const u = await prisma.user.create({ data: { email: `${k}@x.test`, name: k, language: lang, passwordHash: hashPassword('pw'), roles: { create: { role: 'LEARNER' as any } } } }); uid[k] = u.id; tok[k] = (await http.post('/v1/auth/login').send({ email: `${k}@x.test`, password: 'pw' })).body.accessToken; }
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  beforeEach(() => { fake.sent = []; fake.answers.clear(); });

  it('tells a client what it can subscribe to', async () => {
    expect((await http.get('/v1/push/config').set(as('asha')).expect(200)).body).toMatchObject({ enabled: true }); await http.get('/v1/push/config').expect(401);
  });
  it('registers a browser or phone, validating the subscription, and lists and removes only the caller\'s own', async () => {
    const r = (await http.post('/v1/me/push/devices').set(as('asha')).send(web(1)).expect(201)).body; expect(r).toMatchObject({ platform: 'WEB' }); expect(JSON.stringify(r)).not.toMatch(/push\.example\.test|BPk/); // the endpoint and keys never come back
    for (const bad of [{ ...web(2), token: 'http://insecure.test/x' }, { ...web(2), keys: undefined }, { ...web(2), keys: { p256dh: 'x' } }, { platform: 'FAX', token: 'x' }, { platform: 'ANDROID' }, { platform: 'ANDROID', token: 'x'.repeat(5000) }]) await http.post('/v1/me/push/devices').set(as('asha')).send(bad as any).expect(400);
    await http.post('/v1/me/push/devices').set(as('asha')).send({ platform: 'ANDROID', token: 'fcm-token-A' }).expect(201); expect((await http.get('/v1/me/push/devices').set(as('asha')).expect(200)).body).toHaveLength(2); expect((await http.get('/v1/me/push/devices').set(as('ravi')).expect(200)).body).toHaveLength(0);
    await http.delete(`/v1/me/push/devices/${r.id}`).set(as('ravi')).expect(404); await http.delete(`/v1/me/push/devices/${r.id}`).set(as('asha')).expect(200); expect((await http.get('/v1/me/push/devices').set(as('asha'))).body).toHaveLength(1);
  });
  it('the same device follows the latest sign-in, and a person keeps at most 10 active devices', async () => {
    await http.post('/v1/me/push/devices').set(as('ravi')).send({ platform: 'ANDROID', token: 'fcm-token-A' }).expect(201); expect((await http.get('/v1/me/push/devices').set(as('asha'))).body).toHaveLength(0); expect((await http.get('/v1/me/push/devices').set(as('ravi'))).body).toHaveLength(1);
    for (let i = 0; i < 12; i++) await http.post('/v1/me/push/devices').set(as('mute')).send({ platform: 'ANDROID', token: `many-${i}` }).expect(201); expect((await http.get('/v1/me/push/devices').set(as('mute'))).body).toHaveLength(10);
    await prisma.pushDevice.deleteMany({ where: { userId: uid.mute } });
  });
  it('sends each notification once, in the person\'s language, to every device, with the right link', async () => {
    await http.post('/v1/me/push/devices').set(as('asha')).send(web(10)).expect(201); await http.post('/v1/me/push/devices').set(as('asha')).send({ platform: 'IOS', token: 'fcm-ios-1' }).expect(201); await prisma.notification.updateMany({ data: { pushedAt: new Date() } });
    await note(uid.asha, 'assignment.graded', 0, { submissionId: 'sub1' }); await note(uid.ravi, 'lab.booked');
    expect(await svc.sweep()).toBe(3); const to = (t: string) => fake.sent.filter((s) => s.token === t); expect(to('https://push.example.test/send/10')[0].m).toMatchObject({ body: 'Your assignment has been graded.', url: '/grades/sub1' }); expect(to('fcm-ios-1')).toHaveLength(1);
    expect(to('fcm-token-A')[0].m).toMatchObject({ title: 'लर्निंग पोर्टल', body: 'आपका लैब सत्र बुक हो गया है।', url: '/labs' }); expect(await svc.sweep()).toBe(0); expect(fake.sent).toHaveLength(3); // nothing is sent twice
  });
  it('two workers sweeping together still send each notification exactly once', async () => {
    fake.sent = []; await note(uid.ravi, 'topic.completed'); await note(uid.ravi, 'topic.unlocked'); const [a, b] = await Promise.all([svc.sweep(), svc.sweep()]); expect(a + b).toBe(2); expect(fake.sent).toHaveLength(2);
  });
  it('respects the person\'s push preference, an inactive account, unknown types and stale notifications', async () => {
    await http.put('/v1/me/preferences').set(as('ravi')).send({ push: false }).expect(200); await note(uid.ravi, 'lab.booked'); expect(await svc.sweep()).toBe(0); await http.put('/v1/me/preferences').set(as('ravi')).send({ push: true }).expect(200);
    await note(uid.ravi, 'internal.audit_thing'); await note(uid.ravi, 'lab.completed', 25 * 3600_000); expect(await svc.sweep()).toBe(0); expect(await prisma.notification.count({ where: { pushedAt: null } })).toBe(0); // all marked done, none sent
    await prisma.user.update({ where: { id: uid.ravi }, data: { status: 'SUSPENDED' } }); await note(uid.ravi, 'lab.booked'); expect(await svc.sweep()).toBe(0); await prisma.user.update({ where: { id: uid.ravi }, data: { status: 'ACTIVE' } });
    await http.put('/v1/me/preferences').set(as('ravi')).send({ push: 'yes' }).expect(400);
  });
  it('stops sending to a device the push service says is gone, and after repeated failures', async () => {
    const dead = (await http.post('/v1/me/push/devices').set(as('ravi')).send({ platform: 'ANDROID', token: 'fcm-dead' }).expect(201)).body; fake.answers.set('fcm-dead', 'gone'); await note(uid.ravi, 'lab.booked'); await svc.sweep();
    expect(await prisma.pushDevice.findUnique({ where: { id: dead.id } })).toMatchObject({ disabledAt: expect.any(Date) }); fake.sent = []; await note(uid.ravi, 'lab.booked'); await svc.sweep(); expect(fake.sent.some((s) => s.token === 'fcm-dead')).toBe(false);
    const flaky = (await http.post('/v1/me/push/devices').set(as('ravi')).send({ platform: 'ANDROID', token: 'fcm-flaky' }).expect(201)).body; fake.answers.set('fcm-flaky', 'retry'); for (let i = 0; i < 5; i++) { await note(uid.ravi, 'lab.booked'); await svc.sweep(); }
    expect((await prisma.pushDevice.findUnique({ where: { id: flaky.id } }))!.disabledAt).not.toBeNull(); fake.answers.set('fcm-flaky', 'sent'); await http.post('/v1/me/push/devices').set(as('ravi')).send({ platform: 'ANDROID', token: 'fcm-flaky' }).expect(201); expect((await prisma.pushDevice.findUnique({ where: { id: flaky.id } }))).toMatchObject({ disabledAt: null, failures: 0 }); // re-registering revives it
  });
  it('sends a test notification to the caller\'s own devices only, rate limited', async () => {
    fake.sent = []; const r = (await http.post('/v1/me/push/test').set(as('ravi')).expect(201)).body; expect(r.sent).toBe(r.devices); expect(fake.sent.every((s) => s.m.body === 'यह एक परीक्षण सूचना है।')).toBe(true); expect((await http.post('/v1/me/push/test').set(as('mute')).expect(201)).body).toEqual({ devices: 0, sent: 0 });
  });
  it('erasing a person removes their devices', async () => {
    await http.post('/v1/me/push/devices').set(as('mute')).send({ platform: 'ANDROID', token: 'to-erase' }).expect(201); expect(await prisma.pushDevice.count({ where: { userId: uid.mute } })).toBe(1);
    const log = new LogPushProvider(); expect(await new PushService(prisma as any, [log]).deliver({ userId: uid.mute, type: 'lab.booked', payload: {} })).toBe(1); expect(log.sent[0].message.body).toBe('Your lab session is booked.');
  });
});
