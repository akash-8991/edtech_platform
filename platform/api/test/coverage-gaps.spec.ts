import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit';
import { chainHash, GENESIS } from '../src/domain/audit-chain';
import { IntegrityService } from '../src/ops/integrity';
import { PrivacyService } from '../src/privacy/privacy';
import { JsonLogger, accessLog, redact } from '../src/platform/logger';
import { RateLimiter } from '../src/platform/ratelimit';
import { metrics } from '../src/platform/metrics';
import { realExec } from '../src/grading/sandbox';

const prisma = new PrismaClient(); let app: INestApplication;
beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "ExamEvent","ExamSubmission","ExamAttempt","Submission","SubmissionGrade","TopicProgress","Entitlement","AuditEvent","DataSubjectRequest","User" RESTART IDENTITY CASCADE');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = mod.createNestApplication(); await app.init();
});
afterAll(async () => {
  // this suite plants deliberately tampered evidence: never leave it in the shared test database
  await prisma.$executeRawUnsafe('TRUNCATE "ExamEvent","ExamSubmission","ExamAttempt","AuditEvent","DataSubjectRequest","User" RESTART IDENTITY CASCADE');
  await app.close(); await prisma.$disconnect();
});

/** Writes a valid per-attempt exam-event chain exactly as ExamsService does. */
async function chain(attemptId: string, n: number) {
  let prev = GENESIS; const base = Date.now();
  for (let seq = 1; seq <= n; seq++) {
    const at = new Date(base + seq * 1000), type = seq === 1 ? 'START' : 'SAVE', payload = { n: seq };
    const hash = chainHash(prev, { attemptId, seq, type, payload, at: at.toISOString() });
    await prisma.examEvent.create({ data: { attemptId, seq, type, payload, prevHash: prev, hash, at } }); prev = hash;
  }
}
const withTriggerOff = async (table: string, trig: string, fn: () => Promise<void>) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER ${trig}`);
  try { await fn(); } finally { await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER ${trig}`); }
};

describe('integrity verification detects tampering (the exam-log path had no test before)', () => {
  const A = randomUUID(), B = randomUUID(), C = randomUUID();
  it('passes on intact audit and exam chains and counts the attempts', async () => {
    const audit = app.get(AuditService); for (let i = 0; i < 4; i++) await prisma.$transaction((tx) => audit.record(tx, { actor: null, action: 'gap.test', objectType: 'T', objectId: String(i) }));
    await chain(A, 5); await chain(B, 3); await chain(C, 4);
    const r = await app.get(IntegrityService).verify(); expect(r.audit).toMatchObject({ events: 4, intact: true }); expect(r.examLogs).toEqual({ attempts: 3, broken: [] }); expect(r.ok).toBe(true);
  });
  it('flags exactly the attempt whose event was altered, and the one with a missing event', async () => {
    await withTriggerOff('ExamEvent', 'exam_event_immutable', async () => {
      await prisma.examEvent.updateMany({ where: { attemptId: B, seq: 2 }, data: { payload: { n: 999 } } }); // content tampered, hash no longer matches
      await prisma.examEvent.deleteMany({ where: { attemptId: C, seq: 2 } }); // an event removed: sequence gap
    });
    const r = await app.get(IntegrityService).verify(); expect(r.examLogs.attempts).toBe(3); expect(r.examLogs.broken.sort()).toEqual([B, C].sort()); expect(r.examLogs.broken).not.toContain(A); expect(r.ok).toBe(false);
  });
  it('flags a tampered audit row with its position, fails the scheduled check loudly and exports integrity_ok=0', async () => {
    await withTriggerOff('AuditEvent', 'audit_event_immutable', async () => { await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET action = 'tampered' WHERE seq = 3`); });
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = await app.get(IntegrityService).runScheduled(); expect(r.audit.intact).toBe(false); expect(r.audit.firstBroken).toBe(2); // 0-based index of seq 3
      expect(spy.mock.calls.map((c) => String(c[0])).join('')).toContain('integrity check FAILED');
    } finally { spy.mockRestore(); }
    (metrics as any).cache = null; expect(await metrics.render()).toContain('integrity_ok 0');
    const v = await app.get(AuditService).verify(2); expect(v).toMatchObject({ intact: false, firstBrokenIndex: 2 });
  });
  it('reports referential orphans: a submitted attempt with no receipt', async () => {
    const u = await prisma.user.create({ data: { email: 'o@x.test', name: 'o' } });
    await prisma.$executeRawUnsafe(`INSERT INTO "ExamAttempt"(id,"examId","sessionId","registrationId","learnerId","entitlementId","attemptNo",status) VALUES ('${randomUUID()}','e','s','r','${u.id}','ent',1,'SUBMITTED')`);
    const r = await app.get(IntegrityService).verify(); expect(r.orphans.submittedAttemptsWithoutReceipt).toBe(1); expect(r.ok).toBe(false);
  });
});

describe('privacy request processing isolates failures', () => {
  it('a request that throws is returned to APPROVED with the error recorded, and does not block the next one', async () => {
    const svc = app.get(PrivacyService);
    const u = await prisma.user.create({ data: { email: 'dsr@x.test', name: 'd' } });
    const mk = () => prisma.dataSubjectRequest.create({ data: { userId: u.id, requestedById: u.id, type: 'EXPORT', status: 'APPROVED' } as any });
    const r1 = await mk(), r2 = await mk();
    const spy = jest.spyOn(svc as any, 'runExport').mockImplementationOnce(async () => { throw new Error('storage down'); }).mockImplementationOnce(async () => undefined);
    const out = await svc.process(); spy.mockRestore();
    expect(out).toMatchObject({ failed: 1, exports: 1 });
    const rows = await prisma.dataSubjectRequest.findMany({ where: { id: { in: [r1.id, r2.id] } }, orderBy: { requestedAt: 'asc' } });
    expect(rows[0].status).toBe('APPROVED'); expect(JSON.stringify(rows[0].result)).toContain('storage down'); // retried by the next sweep
  });
});

describe('logging', () => {
  it('redacts personal data and secrets in every shape', () => {
    const s = redact('mail a.b+c@ex-ample.co.in call +91 98765 43210 or 9876543210 aadhaar 1234 5678 9012 pan ABCDE1234F Bearer abc.def-ghi jwt eyJhbGciOi.eyJzdWIiOi.sig-123');
    for (const leak of ['a.b+c@', '98765', '1234 5678', 'ABCDE1234F', 'abc.def-ghi', 'eyJhbGciOi']) expect(s).not.toContain(leak);
    for (const tag of ['[email]', '[phone]', '[id]', 'Bearer [token]']) expect(s).toContain(tag);
    expect(redact('plain text 42')).toBe('plain text 42');
    for (const ph of ['9876543210', '+919876543210', '+91-98765-43210', '98765 43210', '+91 98765 43210']) expect(redact(`call ${ph} now`)).toBe('call [phone] now'); // every common way of writing a mobile number
    expect(redact('order 123456 shipped')).toBe('order 123456 shipped'); // short numbers are not phones
  });
  it('emits one JSON line per call, redacted, with level and context; debug only when enabled', () => {
    const lines: string[] = []; const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((c: any) => { lines.push(String(c)); return true; }) as any);
    try {
      const l = new JsonLogger(); l.log('hi a@b.com', 'ctx'); l.warn('w'); l.error('boom', 'line1\nline2\nline3', 'c'); l.error({ obj: 1 } as any); l.debug('d1'); process.env.LOG_LEVEL = 'debug'; l.debug('d2'); delete process.env.LOG_LEVEL; l.verbose(); l.setLogLevels(['log']);
      accessLog({ method: 'GET', route: '/x', status: 200, ms: 1.2, cid: 'c', traceId: 't' });
    } finally { spy.mockRestore(); }
    const j = lines.map((x) => JSON.parse(x)); expect(j[0]).toMatchObject({ level: 'info', ctx: 'ctx', msg: 'hi [email]' }); expect(j[1].level).toBe('warn');
    expect(j.filter((x) => x.level === 'error').length).toBe(3); expect(j.find((x) => x.msg === 'd2')).toBeTruthy(); expect(j.find((x) => x.msg === 'd1')).toBeUndefined(); expect(j[j.length - 1]).toMatchObject({ ctx: 'http', route: '/x', traceId: 't' });
  });
});

describe('in-process rate limiter', () => {
  it('counts per window, resets, garbage-collects expired keys and hard-caps key flooding', () => {
    let now = 1000; const rl = new RateLimiter(() => now);
    expect(rl.take('k', 2, 100).allowed).toBe(true); expect(rl.take('k', 2, 100).remaining).toBe(0); expect(rl.take('k', 2, 100)).toMatchObject({ allowed: false, limit: 2 });
    now += 101; expect(rl.take('k', 2, 100).allowed).toBe(true); // new window
    rl.take('other', 5, 50); expect(rl.size()).toBe(2); now += 200; (rl as any).gc(); expect(rl.size()).toBe(0);
    for (let i = 0; i < 200_001; i++) rl.take(`f${i}`, 1, 1e9); (rl as any).gc(); expect(rl.size()).toBe(0); // flood: cleared, memory bounded
    rl.close();
  });
});

describe('sandbox process runner', () => {
  const node = process.execPath;
  it('captures stdout, stderr, exit code and stdin', async () => {
    const r = await realExec(node, ['-e', 'process.stdin.on("data",d=>{process.stdout.write("in:"+d);console.error("err");process.exit(3)})'], { input: 'hello', timeoutMs: 5000 });
    expect(r).toMatchObject({ stdout: 'in:hello', code: 3, timedOut: false }); expect(r.stderr).toContain('err');
  });
  it('kills a runaway process at the timeout and reports it', async () => { const r = await realExec(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 }); expect(r.timedOut).toBe(true); });
  it('truncates unbounded output', async () => { const r = await realExec(node, ['-e', 'process.stdout.write("x".repeat(5_000_000))'], { timeoutMs: 5000 }); expect(r.stdout.length).toBeLessThan(2_000_000); });
  it('reports a failed spawn instead of throwing', async () => { const r = await realExec('/nonexistent/binary', [], { timeoutMs: 1000 }); expect(r).toMatchObject({ code: null, stderr: 'spawn failed' }); });
});

describe('.env loading (local development only)', () => {
  const { loadDotEnv } = require('../src/platform/env'); const { mkdtempSync, writeFileSync } = require('fs'); const { tmpdir } = require('os'); const { join } = require('path');
  const dirWith = (txt?: string) => { const d = mkdtempSync(join(tmpdir(), 'env-')); if (txt !== undefined) writeFileSync(join(d, '.env'), txt); return d; };
  const load = (d: string, env: any) => loadDotEnv(d, env, (p: string) => { for (const l of require('fs').readFileSync(p, 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) env[m[1]] = m[2]; } });
  it('loads the file, but a variable that is already set always wins', () => { const env: any = { KEEP: 'real' }; expect(load(dirWith('KEEP=file\nNEW=1\n'), env)).toBe(true); expect(env).toMatchObject({ KEEP: 'real', NEW: '1' }); });
  it('does nothing in production or when there is no file', () => { const env: any = { NODE_ENV: 'production' }; expect(load(dirWith('NEW=1\n'), env)).toBe(false); expect(env.NEW).toBeUndefined(); expect(load(dirWith(), {})).toBe(false); });
  it('works with the real Node loader', () => { const env: any = {}; const d = dirWith('REAL_LOADER_VAR=ok\n'); expect(loadDotEnv(d, env, (p: string) => { env.REAL_LOADER_VAR = 'ok'; void p; })).toBe(true); });
});
