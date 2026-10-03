// Exercises the read and rarely-hit routes so the API contracts (src/platform/contracts) are inferred from, and enforced against, real
// responses for every route. The contract interceptor (CONTRACT_ENFORCE=1) fails any response that drifts from its declared schema.
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret'; process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'media-gaps-')); process.env.OFFLINE_MASTER_KEY = 'ab'.repeat(32);
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';

const prisma = new PrismaClient(); let app: INestApplication; let http: any;
const tok: Record<string, string> = {}; const uid: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
const ROLES: [string, string][] = [['admin', 'ACADEMIC_ADMIN'], ['platform', 'PLATFORM_ADMIN'], ['super', 'SUPER_ADMIN'], ['author', 'CONTENT_AUTHOR'], ['faculty', 'FACULTY_REVIEWER'], ['approver', 'APPROVER_PUBLISHER'],
  ['learner', 'LEARNER'], ['teacher', 'DOUBT_TEACHER'], ['exam', 'EXAM_ADMIN'], ['support', 'SUPPORT_OPERATOR']];
let V = '', ENT = '', QID = '', PROG = '';

beforeAll(async () => {
  const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  for (const [k, r] of ROLES) {
    const u = await prisma.user.create({ data: { email: `${k}@x.test`, name: k, passwordHash: hashPassword('pw'), roles: { create: { role: r as any } } } }); uid[k] = u.id;
    tok[k] = (await http.post('/v1/auth/login').send({ email: `${k}@x.test`, password: 'pw' })).body.accessToken;
  }
  await http.post('/v1/authoring/programmes').set(as('author')).send({ code: 'PG', title: 'Gaps', discipline: 'AI' }).expect(201);
  const v = await http.post('/v1/authoring/programmes/PG/versions').set(as('author')).send({ hours: 1, languages: ['en'], modules: [{ title: 'M', topics: [{ title: 'T', hours: 1 }] }] }).expect(201); V = v.body.id;
  PROG = (await prisma.programme.findFirstOrThrow({ where: { code: 'PG' } })).id;
  ENT = (await prisma.entitlement.create({ data: { learnerId: uid.learner, versionId: V, duration: 'M12', cohort: 'C1', startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() + 300 * 86400000), approvedById: uid.admin } })).id;
  await prisma.teacherProfile.create({ data: { userId: uid.teacher, disciplines: ['AI'], skills: ['x'], languages: ['en'] } });
  QID = (await prisma.examQuestion.create({ data: { programmeId: PROG, tag: 't', type: 'MCQ_SINGLE', text: 'q', options: ['a', 'b'], answer: 1, createdById: uid.exam } })).id;
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('read routes with little other coverage', () => {
  it('staff lists and settings', async () => {
    await http.get('/v1/admin/config').set(as('admin')).expect(200);
    await http.get('/v1/ai/jobs').set(as('admin')).expect(200);
    await http.get('/v1/ai/prompts').set(as('admin')).expect(200);
    await http.get(`/v1/authoring/versions/${V}/labs`).set(as('author')).expect(200);
    await http.get('/v1/doubt-centre/teachers').set(as('admin')).expect(200);
    await http.get('/v1/faq').set(as('admin')).expect(200);
  });
  it('learner lists', async () => {
    await http.get('/v1/me/doubts').set(as('learner')).expect(200);
    await http.get('/v1/me/privacy/requests').set(as('learner')).expect(200);
    await http.get('/v1/me/submissions').set(as('learner')).expect(200);
    await http.get('/v1/tutor/conversations').set(as('learner')).expect(200);
    const mine = (await http.get('/v1/me/entitlements').set(as('learner')).expect(200)).body; expect(mine).toHaveLength(1);
  });
  it('teacher workspace', async () => {
    await http.get('/v1/teacher/appointments').set(as('teacher')).expect(200);
    expect((await http.get('/v1/teacher/profile').set(as('teacher')).expect(200)).body.userId).toBe(uid.teacher);
    await http.put('/v1/teacher/profile').set(as('teacher')).send({ available: false }).expect(200);
  });
  it('notification read, bank retire and entitlement revoke', async () => {
    const n = await prisma.notification.create({ data: { userId: uid.learner, type: 'TEST', payload: { title: 't' } } });
    await http.post(`/v1/me/notifications/${n.id}/read`).set(as('learner')).expect(201);
    await http.post(`/v1/exams/bank/questions/${QID}/retire`).set(as('exam')).send({ reason: 'outdated' }).expect(201);
    await http.post(`/v1/entitlements/${ENT}/revoke`).set(as('admin')).send({ reason: 'withdrawn' }).expect(201);
  });
});

describe('staff entitlement search and detail', () => {
  it('searches by learner, programme and status, pages with a cursor, and refuses learners', async () => {
    const all = (await http.get('/v1/admin/entitlements').set(as('support')).expect(200)).body; expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ learner: { email: 'learner@x.test' }, programme: { code: 'PG' }, versionNumber: 1, status: 'REVOKED', learningAccess: false });
    expect((await http.get('/v1/admin/entitlements?q=LEARN').set(as('admin')).expect(200)).body).toHaveLength(1);
    expect((await http.get('/v1/admin/entitlements?q=nobody').set(as('admin')).expect(200)).body).toHaveLength(0);
    expect((await http.get('/v1/admin/entitlements?status=ACTIVE').set(as('admin')).expect(200)).body).toHaveLength(0);
    expect((await http.get('/v1/admin/entitlements?programme=PG&status=REVOKED').set(as('admin')).expect(200)).body).toHaveLength(1);
    expect((await http.get('/v1/admin/entitlements?programme=ZZ').set(as('admin')).expect(200)).body).toHaveLength(0);
    await http.get('/v1/admin/entitlements?status=BOGUS').set(as('admin')).expect(400);
    await http.get('/v1/admin/entitlements').set(as('learner')).expect(403); await http.get('/v1/admin/entitlements').expect(401);
  });
  it('detail carries pauses, extensions, overrides and the audit history', async () => {
    const d = (await http.get(`/v1/admin/entitlements/${ENT}`).set(as('admin')).expect(200)).body;
    expect(d.learner.email).toBe('learner@x.test'); expect(Array.isArray(d.pauses)).toBe(true); expect(d.history.map((h: any) => h.action)).toContain('entitlement.revoked');
    await http.get('/v1/admin/entitlements/00000000-0000-0000-0000-000000000000').set(as('admin')).expect(404);
  });
});

describe('sign-in options', () => {
  it('reports whether SSO is configured without creating a login attempt', async () => {
    delete process.env.OIDC_ISSUER;
    expect((await http.get('/v1/auth/sso/config').expect(200)).body.enabled).toBe(false);
    Object.assign(process.env, { OIDC_ISSUER: 'https://idp.test', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_REDIRECT_URI: 'https://app.test/sso/callback', OIDC_LABEL: 'Campus login' });
    try { expect((await http.get('/v1/auth/sso/config').expect(200)).body).toEqual({ enabled: true, label: 'Campus login' }); } finally { for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_LABEL']) delete process.env[k]; }
  });
});
