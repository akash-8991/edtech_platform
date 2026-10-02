import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
const REPLICA = process.env.TEST_REPLICA_URL; // a real streaming replica of the test DB; the suite is skipped without one (see docs/ops/scaling.md)
import { hashPassword } from '../src/common/auth';
import { poolUrl, PrismaService, ReadDb } from '../src/common/prisma.service';
import { metrics } from '../src/platform/metrics';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => Promise<boolean>, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };

describe('connection pool settings', () => {
  const U = 'postgresql://u:p@db:5432/x';
  it('applies limits and the PgBouncer flag from the environment, never overriding explicit URL params', () => {
    expect(poolUrl(U, { DB_CONNECTION_LIMIT: '20', DB_POOL_TIMEOUT: '10', DB_PGBOUNCER: '1' } as any)).toBe(`${U}?connection_limit=20&pool_timeout=10&pgbouncer=true`);
    expect(poolUrl(`${U}?connection_limit=3`, { DB_CONNECTION_LIMIT: '20' } as any)).toBe(`${U}?connection_limit=3`);
    expect(poolUrl(U, {} as any)).toBe(U); expect(poolUrl(U, { DB_PGBOUNCER: '0' } as any)).toBe(U); expect(poolUrl(undefined, {} as any)).toBeUndefined();
  });
  it('without a replica URL, reports run on the primary', async () => {
    const saved = process.env.DATABASE_REPLICA_URL; delete process.env.DATABASE_REPLICA_URL;
    const p = new PrismaService(); try { const r = new ReadDb(p); expect(r.usingReplica).toBe(false); expect(await r.run(async (db) => db === (p as any))).toBe(true); } finally { await p.$disconnect(); if (saved) process.env.DATABASE_REPLICA_URL = saved; }
  });
});

describe('replica fallback', () => {
  it('a failing replica falls back to the primary exactly once; other errors are not masked', async () => {
    const saved = process.env.DATABASE_REPLICA_URL; process.env.DATABASE_REPLICA_URL = 'postgresql://edtech:edtech@127.0.0.1:1/edtech_test?connect_timeout=2';
    const p = new PrismaService(); const r = new ReadDb(p);
    try {
      let calls = 0; const out = await r.run(async (db) => { calls++; return (await db.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`)[0].one; });
      expect(out).toBe(1); expect(calls).toBe(2); expect(await metrics.render()).toContain('read_replica_fallback_total 1');
      await expect(r.run(async () => { throw new Error('logic bug'); })).rejects.toThrow('logic bug');
    } finally { await r.onModuleDestroy(); await p.$disconnect(); if (saved) process.env.DATABASE_REPLICA_URL = saved; else delete process.env.DATABASE_REPLICA_URL; }
  });
});

(REPLICA ? describe : describe.skip)('real streaming replica', () => {
  let primary: PrismaClient; let replica: PrismaClient;
  let app: INestApplication; let h: any; let tok = ''; let AppModule: any;
  beforeAll(async () => {
    primary = new PrismaClient(); replica = new PrismaClient({ datasources: { db: { url: REPLICA! } } });
    process.env.DATABASE_REPLICA_URL = REPLICA;
    ({ AppModule } = await import('../src/app.module'));
    await primary.$executeRawUnsafe('TRUNCATE "User" CASCADE'); // scratch test database
    await primary.user.create({ data: { email: 'scale-admin@x.test', name: 'a', passwordHash: hashPassword('pw'), roles: { create: { role: 'ACADEMIC_ADMIN' } } } });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = mod.createNestApplication({ rawBody: true } as any); await app.init(); h = request(app.getHttpServer());
    tok = (await h.post('/v1/auth/login').send({ email: 'scale-admin@x.test', password: 'pw' })).body.accessToken;
  });
  afterAll(async () => { await app?.close(); await primary?.$disconnect(); await replica?.$disconnect(); delete process.env.DATABASE_REPLICA_URL; });

  it('it is a replica: in recovery, rejects writes, and primary writes arrive', async () => {
    expect((await replica.$queryRaw<{ r: boolean }[]>`SELECT pg_is_in_recovery() r`)[0].r).toBe(true);
    await expect(replica.user.create({ data: { email: 'nope@x.test', name: 'n' } })).rejects.toThrow(/read-only/i);
    expect(await until(async () => !!(await replica.user.findUnique({ where: { email: 'scale-admin@x.test' } })))).toBe(true);
  });
  it('report endpoints are served from the replica, not the primary', async () => {
    const reads = async (c: PrismaClient) => Number((await c.$queryRaw<{ n: bigint }[]>`SELECT (tup_returned + tup_fetched)::bigint n FROM pg_stat_database WHERE datname = current_database()`)[0].n);
    await sleep(1500); const before = await reads(replica); const v = '00000000-0000-0000-0000-000000000000';
    for (const url of [`/v1/reports/progress?versionId=${v}`, `/v1/reports/exams?examId=${v}`, '/v1/reports/grading', '/v1/reports/tutor', '/v1/reports/doubts']) { const r = await h.get(url).set({ Authorization: `Bearer ${tok}` }); expect([200, 403, 404]).toContain(r.status); }
    // the admin role is not allowed on every report; the ones it may call must have hit the replica
    expect(await until(async () => (await reads(replica)) > before, 8000)).toBe(true);
  });
  it('a report that would write fails loudly instead of silently writing to the replica', async () => {
    const db = app.get(ReadDb); expect(db.usingReplica).toBe(true);
    await expect(db.run((c) => c.user.create({ data: { email: 'w@x.test', name: 'w' } }))).rejects.toThrow(/read-only/i);
  });
});
