import 'reflect-metadata';
import { INestApplication, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import net from 'net';
import { createHmac } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret'; process.env.ADMISSIONS_HMAC_SECRET = 'hmac-secret';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { limiter } from '../src/platform/ratelimit';
import { closeRedis, redis } from '../src/platform/redis';
import { SessionService } from '../src/security/sessions';
import { ClamdScanner, LocalStore, S3Store, SCANNER } from '../src/storage';
import { JobWorker } from '../src/ai/generation';
import { ApplicationsService } from '../src/applications';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const prisma = new PrismaClient();
let app: INestApplication; let http: any; let tok = ''; const as = () => ({ Authorization: `Bearer ${tok}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rec = (ref: string, extra: any = {}) => ({ externalRef: ref, email: `${ref}@x.test`, name: 'N', programmeCode: 'P-HARD', duration: 'M12', cohort: 'C1', ...extra });
let scannerVerdict: 'CLEAN' | 'INFECTED' | 'DOWN' = 'CLEAN';

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "AuditEvent","ApprovalRecord","ReviewComment","EntitlementPause","EntitlementException","Entitlement","Topic","Module","ProgrammeVersion","Programme","LearnerApplication","UserRole","User" RESTART IDENTITY CASCADE');
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SCANNER).useValue({ scan: async () => { if (scannerVerdict === 'DOWN') throw new ServiceUnavailableException('malware scanner unavailable: test'); return scannerVerdict; } }).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  for (const [k, role] of [['admin', 'ACADEMIC_ADMIN'], ['author', 'CONTENT_AUTHOR']]) await prisma.user.create({ data: { email: `${k}@x.test`, name: k, passwordHash: hashPassword('pw'), roles: { create: { role: role as any } } } });
  tok = (await http.post('/v1/auth/login').send({ email: 'admin@x.test', password: 'pw' })).body.accessToken;
});
afterAll(async () => { await app.close(); await closeRedis(); await prisma.$disconnect(); });

describe('application intake is idempotent under concurrency', () => {
  it('N concurrent deliveries of one externalRef yield exactly one created, the rest duplicate, never a 500', async () => {
    const svc = app.get(ApplicationsService);
    const rs = await Promise.all(Array.from({ length: 25 }, () => svc.intake([rec('RACE-1')], null)));
    const all = rs.flatMap((r) => r.results.map((x) => x.result));
    expect(all.filter((x) => x === 'created')).toHaveLength(1);
    expect(all.filter((x) => x === 'duplicate')).toHaveLength(24);
    expect(await prisma.learnerApplication.count({ where: { externalRef: 'RACE-1' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'application.received' } })).toBe(1); // the losers' audit rows rolled back with them
  });
  it('the same holds through the signed HTTP webhook', async () => {
    const send = () => { const ts = Date.now(), raw = JSON.stringify({ applications: [rec('RACE-2')] }); return http.post('/v1/admissions/applications').set({ 'x-timestamp': String(ts), 'x-signature': createHmac('sha256', 'hmac-secret').update(`${ts}.${raw}`).digest('hex'), 'content-type': 'application/json' }).send(raw); };
    const rs = await Promise.all(Array.from({ length: 12 }, send));
    expect(rs.map((r: any) => r.status).every((s: number) => s === 201)).toBe(true);
    expect(rs.flatMap((r: any) => r.body.results.map((x: any) => x.result)).filter((x: string) => x === 'created')).toHaveLength(1);
  });
  it('rejects oversize batches and over-long fields instead of storing them', async () => {
    process.env.INTAKE_MAX_BATCH = '3';
    try { await http.post('/v1/applications/import').set(as()).send({ applications: [rec('B1'), rec('B2'), rec('B3'), rec('B4')] }).expect(400); } finally { delete process.env.INTAKE_MAX_BATCH; }
    const r = await http.post('/v1/applications/import').set(as()).send({ applications: [rec('LONG-1', { name: 'x'.repeat(501) })] }).expect(201);
    expect(r.body.results[0]).toMatchObject({ result: 'invalid', errors: ['name too long'] });
    await http.post('/v1/applications/import').set(as()).send({ applications: new Array(5001).fill({}) }).expect(400); // DTO array cap
  });
  it('a final decision is never silently overwritten; a returned one can be decided again', async () => {
    const id = (await http.post('/v1/applications/import').set(as()).send({ applications: [rec('DEC-1')] })).body.results[0].id;
    await http.post(`/v1/applications/${id}/decision`).set(as()).send({ decision: 'RETURN', reason: 'missing docs' }).expect(201);
    await http.post(`/v1/applications/${id}/decision`).set(as()).send({ decision: 'REJECT', reason: 'ineligible' }).expect(201);
    await http.post(`/v1/applications/${id}/decision`).set(as()).send({ decision: 'REJECT', reason: 'again' }).expect(409);
    await http.post(`/v1/applications/${id}/decision`).set(as()).send({ decision: 'APPROVE' }).expect(409);
  });
  it('approval refuses a second entitlement for the same learner and version (409, not a unique-violation 500)', async () => {
    const prog = await prisma.programme.create({ data: { code: 'P-HARD', title: 't', discipline: 'd' } });
    const author = (await prisma.user.findUnique({ where: { email: 'author@x.test' } }))!;
    await prisma.programmeVersion.create({ data: { programmeId: prog.id, version: 1, state: 'PUBLISHED', authorId: author.id, hours: 10 } });
    const a1 = (await http.post('/v1/applications/import').set(as()).send({ applications: [rec('ENT-1', { email: 'same@x.test' })] })).body.results[0].id;
    const a2 = (await http.post('/v1/applications/import').set(as()).send({ applications: [rec('ENT-2', { email: 'same@x.test' })] })).body.results[0].id;
    await http.post(`/v1/applications/${a1}/decision`).set(as()).send({ decision: 'APPROVE' }).expect(201);
    await http.post(`/v1/applications/${a2}/decision`).set(as()).send({ decision: 'APPROVE' }).expect(409);
    expect(await prisma.learnerApplication.findUnique({ where: { id: a2 } }).then((a) => a?.status)).toBe('RECEIVED'); // rolled back whole
  });
});

describe('request validation', () => {
  it('bounds nesting, rejects prototype-pollution keys and unknown DTO fields', async () => {
    let deep: any = { v: 1 }; for (let i = 0; i < 30; i++) deep = { n: deep };
    await http.post('/v1/authoring/programmes').set(as()).send(deep).expect(400);
    await http.post('/v1/authoring/programmes').set(as()).set('content-type', 'application/json').send('{"code":"X","title":"t","discipline":"d","__proto__":{"admin":true}}').expect(400);
    const r = await http.post('/v1/auth/login').send({ email: 'admin@x.test', password: 'pw', isAdmin: true }).expect(400);
    expect(r.body).toMatchObject({ error: 'validation_failed', fields: ['isAdmin'] });
    await http.post('/v1/auth/login').send({ email: 'x'.repeat(300), password: 'pw' }).expect(400);
    await http.post('/v1/auth/login').send({ email: 'admin@x.test', password: 'pw' }).expect(201); // legitimate shape unaffected
    await http.post('/v1/applications/xx/decision').set(as()).send({ decision: 'MAYBE' }).expect(400);
  });
});

describe('shared rate limiting (Redis)', () => {
  const key = `t:${Date.now()}`;
  it('one counter across instances; window expires; the count is visible to a second client', async () => {
    const other = new Redis(process.env.REDIS_URL!);
    try {
      const r = [] as boolean[]; for (let i = 0; i < 5; i++) r.push((await limiter.take(key, 3, 400)).allowed);
      expect(r).toEqual([true, true, true, false, false]);
      expect(Number(await other.get(`rl:${key}`))).toBe(5); // another instance sees (and would increment) the same counter
      await sleep(450);
      expect((await limiter.take(key, 3, 400)).allowed).toBe(true);
    } finally { other.disconnect(); }
  });
  it('is atomic under concurrency', async () => {
    const res = await Promise.all(Array.from({ length: 50 }, () => limiter.take(`${key}:c`, 10, 5000)));
    expect(res.filter((x) => x.allowed)).toHaveLength(10);
  });
  it('degrades to the local limiter when Redis is unreachable instead of failing requests', async () => {
    await closeRedis(); const saved = process.env.REDIS_URL; process.env.REDIS_URL = 'redis://127.0.0.1:1';
    try { const t = await limiter.take(`${key}:down`, 2, 1000); expect(t.allowed).toBe(true); expect((await limiter.take(`${key}:down`, 1, 1000)).allowed).toBe(false); }
    finally { await closeRedis(); process.env.REDIS_URL = saved; }
  });
});

describe('session revocation fans out across instances', () => {
  it('instance B drops its cached "active" verdict as soon as instance A revokes', async () => {
    const u = await prisma.user.findUnique({ where: { email: 'author@x.test' } });
    const mkSvc = () => new SessionService(prisma as any, { get: async () => 24 } as any);
    const a = mkSvc(), b = mkSvc(); a.onModuleInit(); b.onModuleInit(); await sleep(150);
    const prev = SessionService.TTL_MS; SessionService.TTL_MS = 60_000; // B would trust its cache for a minute
    try {
      const s = await prisma.userSession.create({ data: { userId: u!.id, authMethod: 'PASSWORD', mfa: false, expiresAt: new Date(Date.now() + 3_600_000) } });
      expect(await b.isActive(s.id, u!.id)).toBe(true);
      await a.revoke(s.id, 'test');
      let ok = true; for (let i = 0; i < 30 && ok; i++) { await sleep(50); ok = await b.isActive(s.id, u!.id); }
      expect(ok).toBe(false);
    } finally { SessionService.TTL_MS = prev; a.onModuleDestroy(); b.onModuleDestroy(); }
  });
});

describe('object storage drivers', () => {
  const fakeS3 = () => {
    const objs = new Map<string, Buffer>(); const calls: any[] = [];
    return { objs, calls, async send(cmd: any) {
      const n = cmd.constructor.name, i = cmd.input; calls.push({ n, i });
      if (n === 'PutObjectCommand') { objs.set(i.Key, Buffer.from(i.Body)); return {}; }
      if (n === 'GetObjectCommand') { const b = objs.get(i.Key); if (!b) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); const m = /bytes=(\d+)-(\d+)/.exec(i.Range ?? ''); const d = m ? b.subarray(+m[1], +m[2] + 1) : b; return { Body: Object.assign(require('stream').Readable.from([d]), { transformToByteArray: async () => new Uint8Array(d) }) }; }
      if (n === 'HeadObjectCommand') { const b = objs.get(i.Key); if (!b) throw new Error('NotFound'); return { ContentLength: b.length }; }
      if (n === 'ListObjectsV2Command') return { Contents: [...objs.keys()].filter((k) => k.startsWith(i.Prefix)).map((Key) => ({ Key })), IsTruncated: false };
      if (n === 'DeleteObjectsCommand') { for (const o of i.Delete.Objects) objs.delete(o.Key); return {}; }
      throw new Error(`unexpected ${n}`);
    } };
  };
  const drain = async (s: any) => { const c: Buffer[] = []; for await (const x of s) c.push(Buffer.from(x)); return Buffer.concat(c); };
  it('S3 driver round-trips, ranges, removes a prefix, and sends SSE-KMS only when configured', async () => {
    const c = fakeS3(); const st = new S3Store(c, 'bkt', 'kms-key-1', 'pfx/');
    await st.put('doubts/u1/a.txt', Buffer.from('0123456789')); await st.put('doubts/u1/b.txt', Buffer.from('bb')); await st.put('doubts/u2/c.txt', Buffer.from('cc'));
    expect(c.calls.find((x) => x.n === 'PutObjectCommand').i).toMatchObject({ Bucket: 'bkt', Key: 'pfx/doubts/u1/a.txt', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'kms-key-1' });
    expect((await st.get('doubts/u1/a.txt')).toString()).toBe('0123456789'); expect((await st.stat('doubts/u1/a.txt')).size).toBe(10);
    expect((await drain(await st.stream('doubts/u1/a.txt', { start: 2, end: 4 }))).toString()).toBe('234');
    await st.remove('doubts/u1'); expect([...c.objs.keys()]).toEqual(['pfx/doubts/u2/c.txt']); // prefix removal is scoped, neighbours untouched
    await st.remove('doubts/missing'); // idempotent
    const c2 = fakeS3(); await new S3Store(c2, 'bkt').put('k', Buffer.from('x')); expect(c2.calls[0].i.ServerSideEncryption).toBeUndefined();
    await expect(st.put('../escape', Buffer.from('x'))).rejects.toThrow('bad key');
    expect(new PutObjectCommand({ Bucket: 'b', Key: 'k' })).toBeTruthy();
  });
  it('local driver keeps the same contract and rejects traversal', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'store-')); const st = new LocalStore(dir);
    await st.put('a/b.txt', Buffer.from('hello')); expect((await st.stat('a/b.txt')).size).toBe(5);
    expect((await drain(await st.stream('a/b.txt', { start: 1, end: 3 }))).toString()).toBe('ell');
    await st.remove('a'); await expect(st.get('a/b.txt')).rejects.toThrow(); await expect(st.get('../../etc/passwd')).rejects.toThrow('bad key');
    await fs.rm(dir, { recursive: true });
  });
});

describe('malware scanning fails closed', () => {
  const clamd = (reply: string | null, cap?: { got?: Buffer }) => new Promise<{ port: number; close: () => void }>((res) => {
    const srv = net.createServer((s) => {
      const chunks: Buffer[] = [];
      s.on('data', (d: Buffer) => { chunks.push(d); const all = Buffer.concat(chunks); if (all.subarray(all.length - 4).equals(Buffer.alloc(4)) && all.includes('zINSTREAM\0')) { if (cap) cap.got = all; if (reply === null) return s.destroy(); s.end(reply + '\0'); } });
    }).listen(0, '127.0.0.1', () => res({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
  it('speaks INSTREAM correctly and maps replies', async () => {
    const data = Buffer.alloc(150_000, 7); const cap: any = {};
    let s = await clamd('stream: OK', cap); expect(await new ClamdScanner('127.0.0.1', s.port).scan(data, 'f')).toBe('CLEAN'); s.close();
    const got: Buffer = cap.got; expect(got.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    let off = 10, total = 0, chunks = 0; for (;;) { const n = got.readUInt32BE(off); off += 4; if (!n) break; total += n; chunks++; off += n; } expect(total).toBe(150_000); expect(chunks).toBe(3); // 64k framing, terminated
    s = await clamd('stream: Eicar-Test-Signature FOUND'); expect(await new ClamdScanner('127.0.0.1', s.port).scan(data, 'f')).toBe('INFECTED'); s.close();
  });
  it('an unreachable, silent or confused scanner is an error, never CLEAN', async () => {
    await expect(new ClamdScanner('127.0.0.1', 1).scan(Buffer.from('x'), 'f')).rejects.toBeInstanceOf(ServiceUnavailableException);
    let s = await clamd('stream: INSTREAM size limit exceeded. ERROR'); await expect(new ClamdScanner('127.0.0.1', s.port).scan(Buffer.from('x'), 'f')).rejects.toBeInstanceOf(ServiceUnavailableException); s.close();
    s = await clamd(null); await expect(new ClamdScanner('127.0.0.1', s.port).scan(Buffer.from('x'), 'f')).rejects.toBeInstanceOf(ServiceUnavailableException); s.close();
    await expect(new ClamdScanner('127.0.0.1', 1, 1000, 10).scan(Buffer.alloc(11), 'f')).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
  it('upload endpoints reject infected files and refuse (not accept) when the scanner is down', async () => {
    const author = (await http.post('/v1/auth/login').send({ email: 'author@x.test', password: 'pw' })).body.accessToken;
    const A = { Authorization: `Bearer ${author}` };
    await http.post('/v1/authoring/programmes').set(A).send({ code: 'UP-1', title: 't', discipline: 'd' }).expect(201);
    const ver = await http.post('/v1/authoring/programmes/UP-1/versions').set(A).send({ hours: 1, languages: ['en'], modules: [{ title: 'M', topics: [{ title: 'T', hours: 1 }] }] }).expect(201);
    const top = await prisma.topic.findFirstOrThrow({ where: { module: { versionId: ver.body.id } } });
    const asset = await http.post(`/v1/authoring/topics/${top.id}/assets`).set(A).send({ language: 'en', durationSec: 10, provenance: { model: 'm', source: 'video_engine' } }).expect(201);
    const put = () => http.put(`/v1/authoring/assets/${asset.body.id}/files/transcript`).set({ Authorization: `Bearer ${author}`, 'content-type': 'application/octet-stream' }).send(Buffer.from('hello'));
    scannerVerdict = 'INFECTED'; await put().expect(400);
    scannerVerdict = 'DOWN'; await put().expect(503);
    scannerVerdict = 'CLEAN'; await put().expect(200);
    expect(JSON.stringify((await prisma.auditEvent.findFirst({ where: { action: 'asset.file_uploaded' } }))?.after)).toContain('"scan":"clean"');
  });
});

describe('web/worker separation', () => {
  it('PROCESS_ROLE=api never starts the queue loop; worker and all do', () => {
    const run = (role: string) => { const w: any = new JobWorker(null as any, null as any); const n = process.env.NODE_ENV; process.env.NODE_ENV = 'development'; process.env.PROCESS_ROLE = role; try { w.onModuleInit(); return !!w.timer; } finally { w.onModuleDestroy(); process.env.NODE_ENV = n; delete process.env.PROCESS_ROLE; } };
    expect(run('api')).toBe(false); expect(run('worker')).toBe(true); expect(run('all')).toBe(true);
  });
});
