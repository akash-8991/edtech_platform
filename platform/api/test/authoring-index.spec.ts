import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
const tok: Record<string, string> = {};
async function mkUser(key: string, role: string) {
  await prisma.user.create({ data: { email: `${key}@x.test`, name: `Name ${key}`, passwordHash: hashPassword('pw'), roles: { create: { role: role as any } } } });
  tok[key] = (await http.post('/v1/auth/login').send({ email: `${key}@x.test`, password: 'pw' })).body.accessToken;
}
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "AuditEvent","ApprovalRecord","ReviewComment","QualityFinding","Question","Quiz","Assignment","ContentAsset","Topic","Module","ProgrammeVersion","Programme","UserRole","User" RESTART IDENTITY CASCADE');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  await mkUser('author', 'CONTENT_AUTHOR'); await mkUser('faculty', 'FACULTY_REVIEWER'); await mkUser('learner', 'LEARNER');
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('staff index and full tree of authored content', () => {
  let vid: string;
  it('lists every programme with its versions (unpublished too) for authoring roles only', async () => {
    await http.post('/v1/authoring/programmes').set(as('author')).send({ code: 'IDX-1', title: 'Index test', discipline: 'AI/ML' }).expect(201);
    const v = await http.post('/v1/authoring/programmes/IDX-1/versions').set(as('author')).send({ hours: 2, modules: [{ title: 'M1', topics: [{ title: 'T1', hours: 2, quiz: { passPercent: 60, maxAttempts: 2, questions: [{ position: 1, type: 'MCQ_SINGLE', text: 'Q?', options: ['a', 'b'], answer: 0, points: 1, i18n: { hi: { text: 'प्र?' } } }] } }] }] }).expect(201);
    vid = v.body.id;
    const list = (await http.get('/v1/authoring/programmes').set(as('faculty')).expect(200)).body;
    expect(list).toHaveLength(1); expect(list[0].code).toBe('IDX-1'); expect(list[0].versions[0]).toMatchObject({ id: vid, version: 1, state: 'DRAFT', authorName: 'Name author' });
    await http.get('/v1/authoring/programmes').set(as('learner')).expect(403); await http.get('/v1/authoring/programmes').expect(401);
  });
  it('returns the whole version with quiz answers and who is who, to staff only', async () => {
    await http.post(`/v1/authoring/versions/${vid}/comments`).set(as('faculty')).send({ body: 'Check Q1' }).expect(201);
    const t = (await http.get(`/v1/authoring/versions/${vid}/tree`).set(as('faculty')).expect(200)).body;
    expect(t.programme.code).toBe('IDX-1'); expect(t.modules[0].topics[0].quiz.questions[0]).toMatchObject({ text: 'Q?', answer: 0 }); expect(t.people[t.authorId]).toBe('Name author'); expect(t.comments[0].body).toBe('Check Q1');
    await http.get(`/v1/authoring/versions/${vid}/tree`).set(as('learner')).expect(403);
    await http.get('/v1/authoring/versions/00000000-0000-0000-0000-000000000000/tree').set(as('faculty')).expect(404);
  });
  it('keeps Hindi question text when a draft is edited with its own tree (read-modify-write)', async () => {
    const t = (await http.get(`/v1/authoring/versions/${vid}/tree`).set(as('author'))).body;
    await http.put(`/v1/authoring/versions/${vid}`).set(as('author')).send({ modules: t.modules }).expect(200);
    const after = (await http.get(`/v1/authoring/versions/${vid}/tree`).set(as('author'))).body;
    expect(after.modules[0].topics[0].quiz.questions[0].i18n).toEqual({ hi: { text: 'प्र?' } });
  });
  it('keeps Hindi question text when only the quiz is replaced', async () => {
    const t = (await http.get(`/v1/authoring/versions/${vid}/tree`).set(as('author'))).body; const topic = t.modules[0].topics[0]; const q = topic.quiz.questions[0];
    await http.put(`/v1/authoring/topics/${topic.id}/quiz`).set(as('author')).send({ passPercent: 50, maxAttempts: 2, questions: [{ type: q.type, text: 'Q edited?', options: q.options, answer: q.answer, points: 1, i18n: q.i18n }] }).expect(200);
    const after = (await http.get(`/v1/authoring/versions/${vid}/tree`).set(as('author'))).body.modules[0].topics[0].quiz;
    expect(after.questions[0]).toMatchObject({ text: 'Q edited?', i18n: { hi: { text: 'प्र?' } } }); expect(after.passPercent).toBe(50);
  });
});
