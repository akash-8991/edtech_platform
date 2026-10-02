import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret'; process.env.ADMISSIONS_HMAC_SECRET = 'hmac-secret';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { AuditService } from '../src/audit';
import { ChainVerifier, chainHash, GENESIS } from '../src/domain/audit-chain';
import { IntegrityService } from '../src/ops/integrity';
import { sealSecret, openSecret } from '../src/security/crypto';
import { secretsFor, verifyAny, verifyJwt } from '../src/security/keyring';
import { signToken } from '../src/domain/media-crypto';
import { loadSecrets } from '../src/platform/secrets';
import { rotateKeys } from '../scripts/rotate-keys';

const prisma = new PrismaClient();
let app: INestApplication; let http: any; let tok = ''; let tok2 = '';
const as = (t = tok) => ({ Authorization: `Bearer ${t}` });
const rec = (ref: string, extra: any = {}) => ({ externalRef: ref, email: `${ref.toLowerCase()}@x.test`, name: 'N', programmeCode: 'P-P1', duration: 'M12', cohort: 'C1', ...extra });
const env = (o: Record<string, string | undefined>) => { const saved: any = {}; for (const [k, v] of Object.entries(o)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v as string; } }; };

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "ExamEvent","OfflineLicense","OfflinePackage","Submission","ExamAttempt","TopicProgress","DataSubjectRequest","IdempotencyKey","AuditEvent","ApprovalRecord","ReviewComment","EntitlementPause","EntitlementException","Entitlement","Topic","Module","ProgrammeVersion","Programme","LearnerApplication","UserRole","User" RESTART IDENTITY CASCADE');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  for (const k of ['admin', 'admin2']) await prisma.user.create({ data: { email: `${k}@x.test`, name: k, passwordHash: hashPassword('pw'), roles: { create: { role: 'ACADEMIC_ADMIN' } } } });
  tok = (await http.post('/v1/auth/login').send({ email: 'admin@x.test', password: 'pw' })).body.accessToken;
  tok2 = (await http.post('/v1/auth/login').send({ email: 'admin2@x.test', password: 'pw' })).body.accessToken;
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('Idempotency-Key', () => {
  let appId = '';
  beforeAll(async () => { appId = (await http.post('/v1/applications/import').set(as()).send({ applications: [rec('IDEM-1')] })).body.results[0].id; });
  it('replays the stored response instead of running the handler again', async () => {
    const send = () => http.post(`/v1/applications/${appId}/decision`).set(as()).set('Idempotency-Key', 'key-reject-0001').send({ decision: 'REJECT', reason: 'no' });
    const a = await send(); expect(a.status).toBe(201); expect(a.headers['idempotent-replay']).toBeUndefined();
    const b = await send(); expect(b.status).toBe(201); expect(b.headers['idempotent-replay']).toBe('true'); expect(b.body).toEqual(a.body);
    // without the key the same call is a real second attempt and is refused
    await http.post(`/v1/applications/${appId}/decision`).set(as()).send({ decision: 'REJECT', reason: 'no' }).expect(409);
    expect(await prisma.auditEvent.count({ where: { action: 'application.rejected' } })).toBe(1);
  });
  it('same key + different request is 422; keys are scoped per actor', async () => {
    await http.post(`/v1/applications/${appId}/decision`).set(as()).set('Idempotency-Key', 'key-reject-0001').send({ decision: 'REJECT', reason: 'different' }).expect(422);
    const r = await http.post('/v1/applications/import').set(as()).set('Idempotency-Key', 'shared-key-0001').send({ applications: [rec('IDEM-2')] }).expect(201);
    const r2 = await http.post('/v1/applications/import').set(as(tok2)).set('Idempotency-Key', 'shared-key-0001').send({ applications: [rec('IDEM-2')] }).expect(201);
    expect(r2.headers['idempotent-replay']).toBeUndefined(); // the other admin did NOT receive the first admin's stored response
    expect(r.body.results[0].result).toBe('created'); expect(r2.body.results[0].result).toBe('duplicate');
  });
  it('concurrent retries with one key run the handler once and all callers get the same answer', async () => {
    const id = (await http.post('/v1/applications/import').set(as()).send({ applications: [rec('IDEM-3')] })).body.results[0].id;
    const rs = await Promise.all(Array.from({ length: 10 }, () => http.post(`/v1/applications/${id}/decision`).set(as()).set('Idempotency-Key', 'key-conc-00001').send({ decision: 'RETURN', reason: 'docs' })));
    const ok = rs.filter((r: any) => r.status === 201), inprog = rs.filter((r: any) => r.status === 409);
    expect(ok.length + inprog.length).toBe(10); expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(await prisma.auditEvent.count({ where: { action: 'application.returned', objectId: id } })).toBe(1);
    const after = await http.post(`/v1/applications/${id}/decision`).set(as()).set('Idempotency-Key', 'key-conc-00001').send({ decision: 'RETURN', reason: 'docs' }).expect(201);
    expect(after.headers['idempotent-replay']).toBe('true');
  });
  it('a failed attempt releases the key so the client can retry; malformed keys are rejected; no header = untouched', async () => {
    const id = (await http.post('/v1/applications/import').set(as()).send({ applications: [rec('IDEM-4')] })).body.results[0].id;
    await http.post(`/v1/applications/${id}/decision`).set(as()).set('Idempotency-Key', 'key-retry-0001').send({ decision: 'MAYBE' }).expect(400);
    await http.post(`/v1/applications/${id}/decision`).set(as()).set('Idempotency-Key', 'key-retry-0001').send({ decision: 'RETURN', reason: 'ok' }).expect(201); // same key, now valid: not poisoned by the failure
    await http.post(`/v1/applications/${id}/decision`).set(as()).set('Idempotency-Key', 'x').send({ decision: 'RETURN', reason: 'ok' }).expect(422);
    expect(await prisma.idempotencyKey.count({ where: { state: 'IN_PROGRESS' } })).toBe(0);
  });
  it('takes over a crashed in-progress request after the stale window', async () => {
    const actor = (await prisma.user.findUnique({ where: { email: 'admin@x.test' } }))!.id;
    await prisma.idempotencyKey.create({ data: { actorId: actor, key: 'key-stale-0001', method: 'POST', path: '/v1/applications/import', requestHash: 'x', expiresAt: new Date(Date.now() + 1e6), createdAt: new Date(Date.now() - 10 * 60_000) } });
    await http.post('/v1/applications/import').set(as()).set('Idempotency-Key', 'key-stale-0001').send({ applications: [rec('IDEM-5')] }).expect(201);
  });
});

describe('keyset pagination', () => {
  it('walks every page exactly once; limit is capped; last page has no cursor', async () => {
    await http.post('/v1/applications/import').set(as()).send({ applications: Array.from({ length: 7 }, (_, i) => rec(`PG-${i}`)) }).expect(201);
    const total = await prisma.learnerApplication.count(); const seen: string[] = []; let cursor: string | undefined, pages = 0;
    do { const r = await http.get('/v1/applications').query({ limit: 3, ...(cursor && { cursor }) }).set(as()).expect(200); pages++; seen.push(...r.body.map((x: any) => x.id)); expect(r.body.length).toBeLessThanOrEqual(3); cursor = r.headers['x-next-cursor']; } while (cursor && pages < 50);
    expect(seen.length).toBe(total); expect(new Set(seen).size).toBe(total); expect(pages).toBe(Math.ceil(total / 3));
    expect((await http.get('/v1/applications').query({ limit: 100000 }).set(as())).body.length).toBe(total); // clamped, not an error
  });
});

describe('streaming integrity verification', () => {
  it('audit verification is identical at any batch size and finds a tampered row', async () => {
    const audit = app.get(AuditService); const n = await prisma.auditEvent.count();
    for (const b of [1, 2, 7, 5000]) expect(await audit.verify(b)).toEqual({ events: n, intact: true, firstBrokenIndex: null });
    const v = new ChainVerifier(); const rows = [] as any[]; let prev = GENESIS; for (let i = 0; i < 5; i++) { const payload = { i }; const hash = chainHash(prev, payload); rows.push({ prevHash: prev, hash, payload }); prev = hash; }
    rows[3] = { ...rows[3], payload: { i: 99 } }; rows.forEach((r) => v.push(r)); expect(v.broken).toBe(3); expect(v.count).toBe(5);
  });
  it('whole-database integrity still passes through the streaming path', async () => { const r = await app.get(IntegrityService).verify(); expect(r.audit.intact).toBe(true); expect(r.examLogs.broken).toEqual([]); expect(r.orphans).toEqual({ submissionsWithoutGradeState: 0, gradesPointingAtMissingRecord: 0, submittedAttemptsWithoutReceipt: 0, entitlementsWithoutUser: 0, progressWithoutEntitlement: 0 }); expect(r.ok).toBe(true); });
});

describe('key rotation', () => {
  it('JWT: tokens signed with a retired secret verify during the overlap and stop after it is dropped', async () => {
    const old = new JwtService({ secret: 'old-secret-value' });
    const t = await old.signAsync({ sub: 'u1' }); const cur = new JwtService({ secret: 'new-secret-value' });
    let undo = env({ JWT_SECRET: 'new-secret-value', JWT_SECRET_PREVIOUS: 'old-secret-value' });
    try { expect((await verifyJwt(cur, t)).sub).toBe('u1'); expect((await verifyJwt(cur, await cur.signAsync({ sub: 'u2' }))).sub).toBe('u2'); } finally { undo(); }
    undo = env({ JWT_SECRET: 'new-secret-value', JWT_SECRET_PREVIOUS: undefined });
    try { await expect(verifyJwt(cur, t)).rejects.toThrow('invalid signature'); await expect(verifyJwt(cur, 'garbage')).rejects.toThrow(); } finally { undo(); }
  });
  it('end to end: a live session token keeps working across a rotation of the signing secret', async () => {
    const undo = env({ JWT_SECRET: 'rotated-secret-xxxxxxxxxxxxxxxxxxxxxxxx', JWT_SECRET_PREVIOUS: 'test-secret' });
    try { await http.get('/v1/auth/me').set(as()).expect(200); } finally { undo(); }
    const undo2 = env({ JWT_SECRET: 'rotated-secret-xxxxxxxxxxxxxxxxxxxxxxxx', JWT_SECRET_PREVIOUS: undefined });
    try { await http.get('/v1/auth/me').set(as()).expect(401); } finally { undo2(); }
  });
  it('signed media tokens verify under a retired secret; production refuses to run without real secrets', () => {
    const t = signToken('old-media', { k: 'a', exp: Date.now() + 60_000 });
    const undo = env({ MEDIA_TOKEN_SECRET: 'new-media', MEDIA_TOKEN_SECRET_PREVIOUS: 'old-media' });
    try { expect(verifyAny(secretsFor('MEDIA_TOKEN_SECRET').all, t)?.k).toBe('a'); } finally { undo(); }
    const u2 = env({ NODE_ENV: 'production', MEDIA_TOKEN_SECRET: undefined, JWT_SECRET: undefined });
    try { expect(() => secretsFor('MEDIA_TOKEN_SECRET', 'JWT_SECRET')).toThrow('not configured'); } finally { u2(); }
  });
  it('data keys: stored ciphertext opens under the retired key, rotate-keys re-seals it, and it still opens once the old key is dropped', async () => {
    const A = randomBytes(32).toString('hex'), B = randomBytes(32).toString('hex'); const seed = Buffer.from('totp-seed-bytes-123');
    let undo = env({ DATA_ENC_KEY: A, DATA_ENC_KEY_PREVIOUS: undefined });
    let u: any; try { u = await prisma.user.create({ data: { email: 'mfa@x.test', name: 'm', mfaSecretEnc: sealSecret(seed) } }); } finally { undo(); }
    undo = env({ DATA_ENC_KEY: B, DATA_ENC_KEY_PREVIOUS: A });
    try {
      expect(openSecret(u.mfaSecretEnc).equals(seed)).toBe(true); // overlap: old ciphertext still readable
      expect((await rotateKeys(prisma as any, true)).mfaSecrets).toBe(1); expect((await prisma.user.findUnique({ where: { id: u.id } }))!.mfaSecretEnc).toBe(u.mfaSecretEnc); // dry run changed nothing
      const r = await rotateKeys(prisma as any); expect(r).toMatchObject({ mfaSecrets: 1, failed: [] });
      expect((await rotateKeys(prisma as any)).mfaSecrets).toBe(0); // idempotent
    } finally { undo(); }
    undo = env({ DATA_ENC_KEY: B, DATA_ENC_KEY_PREVIOUS: undefined });
    try { expect(openSecret((await prisma.user.findUnique({ where: { id: u.id } }))!.mfaSecretEnc!).equals(seed)).toBe(true); } finally { undo(); }
  });
});

describe('secret store loader', () => {
  const fake = (res: any) => ({ send: async () => { if (res instanceof Error) throw res; return res; } });
  it('applies vault values over env, ignores junk, never returns values', async () => {
    const e: any = { SECRETS_MANAGER_SECRET_ID: 'prod/edtech', JWT_SECRET: 'stale-manifest-value' };
    const names = await loadSecrets(e, fake({ SecretString: JSON.stringify({ JWT_SECRET: 'from-vault', DATA_ENC_KEY: 'k'.repeat(64), 'bad name': 'x', EMPTY: '', NUM: 5 }) }));
    expect(e.JWT_SECRET).toBe('from-vault'); expect(e.DATA_ENC_KEY).toHaveLength(64); expect(names.sort()).toEqual(['DATA_ENC_KEY', 'JWT_SECRET']); expect(JSON.stringify(names)).not.toContain('from-vault');
  });
  it('does nothing when not configured, and fails closed when configured but unreadable or malformed', async () => {
    expect(await loadSecrets({} as any, fake(new Error('should not be called')))).toEqual([]);
    const cfg = () => ({ SECRETS_MANAGER_SECRET_ID: 's' } as any);
    await expect(loadSecrets(cfg(), fake(Object.assign(new Error('x'), { name: 'AccessDeniedException' })))).rejects.toThrow('AccessDeniedException');
    await expect(loadSecrets(cfg(), fake({ SecretString: 'not json' }))).rejects.toThrow('not a JSON object');
    await expect(loadSecrets(cfg(), fake({ SecretString: '[1,2]' }))).rejects.toThrow('not a JSON object');
  });
});
