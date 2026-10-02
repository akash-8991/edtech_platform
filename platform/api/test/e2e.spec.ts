import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
process.env.ADMISSIONS_HMAC_SECRET = 'hmac-secret';
// eslint-disable-next-line import/first
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';

const prisma = new PrismaClient();
let app: INestApplication; let http: any;
const tok: Record<string, string> = {}; const id: Record<string, string> = {};

async function mkUser(key: string, role: string) {
  const u = await prisma.user.create({ data: { email: `${key}@x.test`, name: key, passwordHash: hashPassword('pw'), roles: { create: { role: role as any } } } });
  id[key] = u.id;
  tok[key] = (await http.post('/v1/auth/login').send({ email: `${key}@x.test`, password: 'pw' })).body.accessToken;
}
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
const sign = (body: object, ts = Date.now()) => {
  const raw = JSON.stringify(body);
  return { raw, headers: { 'x-timestamp': String(ts), 'x-signature': createHmac('sha256', 'hmac-secret').update(`${ts}.${raw}`).digest('hex'), 'content-type': 'application/json' } };
};

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "AuditEvent","ApprovalRecord","ReviewComment","EntitlementPause","EntitlementException","Entitlement","Topic","Module","ProgrammeVersion","Programme","LearnerApplication","UserRole","User" RESTART IDENTITY CASCADE');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  await mkUser('author', 'CONTENT_AUTHOR'); await mkUser('faculty', 'FACULTY_REVIEWER'); await mkUser('approver', 'APPROVER_PUBLISHER');
  await mkUser('admin', 'ACADEMIC_ADMIN'); await mkUser('auditor', 'AUDITOR');
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('platform foundation journey', () => {
  let versionId: string; let appId: string; let entId: string;

  it('rejects unauthenticated and wrong-role calls', async () => {
    await http.get('/v1/catalogue').expect(401);
    await http.post('/v1/authoring/programmes').set(as('faculty')).send({ code: 'X', title: 'x', discipline: 'x' }).expect(403);
  });

  it('authoring: draft -> review needs reconciled hours; maker-checker holds; no direct publish', async () => {
    await http.post('/v1/authoring/programmes').set(as('author')).send({ code: 'AIML-12', title: 'AI/ML Foundations', discipline: 'AI/ML' }).expect(201);
    const v = await http.post('/v1/authoring/programmes/AIML-12/versions').set(as('author')).send({
      hours: 3, outcomes: ['Explain ML'], provenance: { source: 'ai', model: 'm1', promptHash: 'abc' },
      modules: [{ title: 'M1', topics: [{ title: 'T1', hours: 2, mandatory: false }, { title: 'T2', hours: 2, mandatory: false }] }] }).expect(201);
    versionId = v.body.id;
    const bad = await http.post(`/v1/authoring/versions/${versionId}/transition`).set(as('author')).send({ to: 'FACULTY_REVIEW' }).expect(400);
    expect(bad.body.issues[0]).toMatch(/hours/);
    await http.put(`/v1/authoring/versions/${versionId}`).set(as('author')).send({ hours: 4, modules: [{ title: 'M1', topics: [{ title: 'T1', hours: 2, mandatory: false }, { title: 'T2', hours: 2, mandatory: false }] }] }).expect(200);
    await http.post(`/v1/authoring/versions/${versionId}/transition`).set(as('author')).send({ to: 'PUBLISHED' }).expect(409);
    await http.post(`/v1/authoring/versions/${versionId}/transition`).set(as('author')).send({ to: 'FACULTY_REVIEW' }).expect(201);
    await http.put(`/v1/authoring/versions/${versionId}`).set(as('author')).send({ hours: 9 }).expect(409); // frozen in review
    await http.post(`/v1/authoring/versions/${versionId}/transition`).set(as('faculty')).send({ to: 'FACULTY_APPROVED' }).expect(201);
    await http.post(`/v1/authoring/versions/${versionId}/transition`).set(as('faculty')).send({ to: 'ADMIN_APPROVAL' }).expect(201);
    await http.post(`/v1/authoring/versions/${versionId}/transition`).set(as('author')).send({ to: 'PUBLISHED' }).expect(403);
    await mkUser('facapprover', 'APPROVER_PUBLISHER');
    await http.post(`/v1/authoring/versions/${versionId}/transition`).set(as('approver')).send({ to: 'PUBLISHED' }).expect(201);
    await http.get('/v1/catalogue').set(as('author')).expect(200).expect((r: any) => expect(r.body).toHaveLength(1));
  });

  it('admissions intake: signed, replay-safe, idempotent, validated', async () => {
    const payload = { applications: [
      { externalRef: 'ADM-1', email: 'L1@x.test', name: 'Learner One', programmeCode: 'AIML-12', duration: 'M12', cohort: 'C1' },
      { externalRef: 'ADM-2', email: 'bad', name: 'x', programmeCode: 'AIML-12', duration: 'M12', cohort: 'C1' }] };
    const s = sign(payload);
    await http.post('/v1/admissions/applications').set({ ...s.headers, 'x-signature': 'ab'.repeat(32) }).send(s.raw).expect(401);
    await http.post('/v1/admissions/applications').set(sign(payload, Date.now() - 10 * 60_000).headers).send(sign(payload, Date.now() - 10 * 60_000).raw).expect(401);
    const r1 = await http.post('/v1/admissions/applications').set(s.headers).send(s.raw).expect(201);
    expect(r1.body.summary).toEqual({ created: 1, duplicate: 0, invalid: 1 });
    const r2 = await http.post('/v1/admissions/applications').set(sign(payload).headers).send(sign(payload).raw).expect(201);
    expect(r2.body.summary.duplicate).toBe(1);
    appId = r1.body.results[0].id;
  });

  it('approval creates learner + 12-month entitlement; double-approve blocked', async () => {
    await http.post(`/v1/applications/${appId}/decision`).set(as('author')).send({ decision: 'APPROVE' }).expect(403);
    const r = await http.post(`/v1/applications/${appId}/decision`).set(as('admin')).send({ decision: 'APPROVE' }).expect(201);
    entId = r.body.entitlementId;
    await http.post(`/v1/applications/${appId}/decision`).set(as('admin')).send({ decision: 'APPROVE' }).expect(409);
    const ent = await prisma.entitlement.findUniqueOrThrow({ where: { id: entId } });
    expect(ent.endAt.getUTCFullYear() - ent.startAt.getUTCFullYear()).toBe(1);
    await prisma.user.update({ where: { email: 'l1@x.test' }, data: { passwordHash: hashPassword('pw') } });
    tok.learner = (await http.post('/v1/auth/login').send({ email: 'l1@x.test', password: 'pw' })).body.accessToken;
  });

  it('learner pause/resume never extends end date; pause blocks access; objects are owner-scoped', async () => {
    const before = await prisma.entitlement.findUniqueOrThrow({ where: { id: entId } });
    await http.post(`/v1/entitlements/${entId}/pause`).set(as('learner')).send({}).expect(201);
    expect((await http.get(`/v1/entitlements/${entId}/access`).set(as('learner'))).body.allowed).toBe(false);
    await http.post(`/v1/entitlements/${entId}/pause`).set(as('learner')).send({}).expect(409);
    await http.post(`/v1/entitlements/${entId}/resume`).set(as('learner')).expect(201);
    const after = await prisma.entitlement.findUniqueOrThrow({ where: { id: entId } });
    expect(after.endAt.getTime()).toBe(before.endAt.getTime());
    expect((await http.get(`/v1/entitlements/${entId}/access`).set(as('learner'))).body.allowed).toBe(true);
    await mkUser('other', 'LEARNER');
    await http.post(`/v1/entitlements/${entId}/pause`).set(as('other')).send({}).expect(403);
    await http.post(`/v1/entitlements/${entId}/exceptions`).set(as('learner')).send({ extendDays: 5, reason: 'x' }).expect(403);
    await http.post(`/v1/entitlements/${entId}/exceptions`).set(as('admin')).send({ extendDays: 5, reason: 'illness' }).expect(201);
  });

  it('learner sees only entitled published structure, no provenance/author', async () => {
    const d = await http.get(`/v1/catalogue/versions/${versionId}`).set(as('learner')).expect(200);
    expect(d.body.provenance).toBeUndefined(); expect(d.body.authorId).toBeUndefined();
    await http.get(`/v1/catalogue/versions/${versionId}`).set(as('other')).expect(403);
  });

  it('audit: complete, hash chain intact, DB refuses mutation, tamper detected', async () => {
    const ev = await http.get('/v1/audit').set(as('auditor')).expect(200);
    const actions = ev.body.map((e: any) => e.action);
    for (const a of ['version.published', 'entitlement.created', 'entitlement.paused', 'entitlement.resumed', 'entitlement.exception_extended', 'application.approved'])
      expect(actions).toContain(a);
    await http.get('/v1/audit').set(as('learner')).expect(403);
    expect((await http.get('/v1/audit/verify').set(as('auditor'))).body.intact).toBe(true);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET reason='x' WHERE seq=1`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ApprovalRecord"`)).rejects.toThrow(/append-only/);
    // simulate superuser tampering (trigger disabled) -> chain must flag it
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_immutable`);
    await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET reason='tampered' WHERE seq=2`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_event_immutable`);
    const v = (await http.get('/v1/audit/verify').set(as('auditor'))).body;
    expect(v.intact).toBe(false); expect(v.firstBrokenIndex).toBe(1);
  });
});
