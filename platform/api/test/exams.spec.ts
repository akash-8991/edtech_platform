import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
process.env.PROCTOR_WEBHOOK_SECRET = 'whsec';
process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'media-'));
delete process.env.AI_KILL_SWITCH;
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { MockProctor, PROCTOR, signWebhook } from '../src/proctoring/provider';
import { QR_VALID_MS } from '../src/labs/labs';
import { consentHashFor } from '../src/exams/exams';
import { signToken } from '../src/domain/media-crypto';

const prisma = new PrismaClient();
const mock = new MockProctor();
let app: INestApplication; let http: any;
const tok: Record<string, string> = {}; const uid: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
const sess = (t: string) => ({ 'x-exam-session': t });
async function mkUser(key: string, role: string, language = 'en') {
  const u = await prisma.user.create({ data: { email: `${key.toLowerCase()}@x.test`, name: `${key} Person`, language, passwordHash: hashPassword('pw'), roles: { create: { role: role as any } } } });
  uid[key] = u.id; tok[key] = (await http.post('/v1/auth/login').send({ email: `${key.toLowerCase()}@x.test`, password: 'pw' })).body.accessToken;
}

let V: string, P: string, T1: string, T2: string, LAB: string, EXAM: string, CENTRE_EXAM: string, SESSION: string;
const ENT: Record<string, string> = {}; let evN = 0;
const wh = (body: any, o: { ts?: number; secret?: string } = {}) => { const raw = JSON.stringify(body); const ts = o.ts ?? Date.now(); return http.post('/v1/proctoring/webhook').set({ 'x-timestamp': String(ts), 'x-signature': signWebhook(o.secret ?? 'whsec', ts, raw), 'content-type': 'application/json' }).send(raw); };
const ev = (sessionId: string, type: string, extra: any = {}) => ({ eventId: `ev-${++evN}`, sessionId, type, occurredAt: new Date().toISOString(), ...extra });

async function mkLearner(key: string, o: { lab?: boolean; quiz?: boolean; language?: string } = {}) {
  await mkUser(key, 'LEARNER', o.language ?? 'en');
  const e = await prisma.entitlement.create({ data: { learnerId: uid[key], versionId: V, duration: 'M12', cohort: 'C', startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() + 300 * 86400000), approvedById: uid.admin } });
  ENT[key] = e.id;
  if (o.quiz !== false) await prisma.topicProgress.create({ data: { entitlementId: e.id, topicId: T2, videoDone: true, quizPassed: true } });
  if (o.lab !== false) await completeLab(key);
}
async function completeLab(key: string) {
  const slot = await prisma.labSlot.create({ data: { activityId: LAB, batchCode: 'old', startsAt: new Date(Date.now() - 86400000), endsAt: new Date(Date.now() - 80000000), capacity: 99, createdById: uid.lab1 } });
  await prisma.labBooking.create({ data: { slotId: slot.id, activityId: LAB, learnerId: uid[key], entitlementId: ENT[key], status: 'ATTENDED', attendedAt: new Date(), completedAt: new Date() } });
}
const runningSession = (examId: string, mode = 'REMOTE', o: any = {}) => prisma.examSession.create({ data: { examId, startsAt: new Date(Date.now() - 5 * 60_000), endsAt: new Date(Date.now() + 2 * 3600_000), mode, centre: mode === 'CENTRE' ? 'Delhi centre' : null, capacity: 500, createdById: uid.e1, ...o } });
const register = async (key: string, examId: string, sessionId: string) => prisma.examRegistration.create({ data: { examId, sessionId, learnerId: uid[key], entitlementId: ENT[key] } });
const DEV = { browserSupported: true, camera: true, microphone: true, screens: 1, bandwidthKbps: 2000 };
const CODES: Record<string, string> = {}; // exam id -> code (consent text is bound to the exam)
function checkIn(k: string, sessionId: string, examId: string, device: any = DEV) { return http.post(`/v1/exam-sessions/${sessionId}/check-in`).set(as(k)).send({ consent: true, consentHash: consentHashFor(CODES[examId] ?? 'FINAL'), device }); }
async function ready(k: string, examId = EXAM, sessionId?: string) { // register, check in, verify identity via the provider webhook
  const s = sessionId ?? (await runningSession(examId)).id; await register(k, examId, s);
  const r = await checkIn(k, s, examId).expect(201); const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: r.body.attemptId } });
  await wh(ev(a.providerSessionId!, 'identity_verified')).expect(201);
  return { attemptId: a.id, sessionId: s, providerSessionId: a.providerSessionId! };
}
async function start(k: string, examId = EXAM, sessionId?: string) { const r = await ready(k, examId, sessionId); const s = await http.post(`/v1/exam-attempts/${r.attemptId}/start`).set(as(k)).expect(201); return { ...r, token: s.body.sessionToken as string, body: s.body }; }
async function correct(attemptId: string) {
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } }); const items = a.paper as any[];
  const qs = await prisma.examQuestion.findMany({ where: { id: { in: items.map((i) => i.questionId) } } }); const out: any = {};
  for (const it of items) { const q = qs.find((x) => x.id === it.questionId)!; out[q.id] = q.type === 'MCQ_SINGLE' ? it.optionOrder.indexOf(q.answer) : q.type === 'MCQ_MULTI' ? (q.answer as number[]).map((o) => it.optionOrder.indexOf(o)) : q.answer; }
  return out;
}
const sit = async (k: string, o: { all?: boolean } = {}) => { const s = await start(k); await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set({ ...as(k), ...sess(s.token) }).send({ seq: 1, answers: o.all === false ? {} : await correct(s.attemptId) }).expect(200); const sub = await http.post(`/v1/exam-attempts/${s.attemptId}/submit`).set({ ...as(k), ...sess(s.token) }).expect(201); return { ...s, receipt: sub.body.receiptCode as string }; };
const attempt = (id: string) => prisma.examAttempt.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PROCTOR).useValue(mock).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  for (const [k, r] of [['admin', 'ACADEMIC_ADMIN'], ['platform', 'PLATFORM_ADMIN'], ['e1', 'EXAM_ADMIN'], ['assess1', 'ASSESSMENT_ADMIN'], ['assess2', 'ASSESSMENT_ADMIN'], ['fac1', 'FACULTY_REVIEWER'], ['fac2', 'FACULTY_REVIEWER'], ['lab1', 'LAB_COORDINATOR'], ['author', 'CONTENT_AUTHOR'], ['auditor', 'AUDITOR']] as const) await mkUser(k, r);
  const prog = await prisma.programme.create({ data: { code: 'EX-1', title: 'Exam Course', discipline: 'AI/ML' } }); P = prog.id;
  const v = await prisma.programmeVersion.create({ data: { programmeId: P, version: 1, state: 'PUBLISHED', authorId: uid.admin, hours: 2, languages: ['en'], publishedAt: new Date(), provenance: {},
    modules: { create: [{ position: 1, title: 'M', topics: { create: [{ position: 1, title: 'T1', hours: 1, outcomes: ['a'] }, { position: 2, title: 'T2', hours: 1, outcomes: ['b'] }] } }] } }, include: { modules: { include: { topics: { orderBy: { position: 'asc' } } } } } });
  V = v.id; [T1, T2] = v.modules[0].topics.map((t) => t.id);
  await prisma.quiz.create({ data: { topicId: T2, questions: { create: [{ position: 1, type: 'MCQ_SINGLE', text: 'q', options: ['a', 'b'], answer: 0 }] } } }); // T2 needs a passed quiz => programme progress is a real condition
  LAB = (await prisma.labActivity.create({ data: { versionId: V, code: 'L1', title: 'Soldering', safetyText: 'I have read the lab safety rules and will wear protective equipment.', safetyHash: 'x', prerequisiteTopicIds: [T1], createdById: uid.admin } })).id;
  await prisma.labActivity.update({ where: { id: LAB }, data: { safetyHash: require('crypto').createHash('sha256').update('I have read the lab safety rules and will wear protective equipment.').digest('hex') } });
  await mkLearner('l1', { lab: false, quiz: false });
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

// ================================================================== LABS ==================================================================
describe('labs (LAB-001..003)', () => {
  const futureSlot = (o: any = {}) => http.post('/v1/labs/slots').set(as('lab1')).send({ activityId: LAB, batchCode: 'B1', startsAt: new Date(Date.now() + 3 * 86400000).toISOString(), endsAt: new Date(Date.now() + 3 * 86400000 + 7200000).toISOString(), capacity: 2, ...o });
  let hash: string; let slotId: string;
  it('lab activities are authored on a draft version only, with safety text, valid prerequisites, and a content hash', async () => {
    const draft = await prisma.programmeVersion.create({ data: { programmeId: P, version: 9, authorId: uid.author, hours: 1, modules: { create: [{ position: 1, title: 'M', topics: { create: [{ position: 1, title: 'D', hours: 1 }] } }] } }, include: { modules: { include: { topics: true } } } });
    const dt = draft.modules[0].topics[0].id;
    await http.put(`/v1/authoring/versions/${draft.id}/labs/LAB-A`).set(as('author')).send({ title: 'x', safetyText: 'short' }).expect(400);
    await http.put(`/v1/authoring/versions/${draft.id}/labs/LAB-A`).set(as('author')).send({ title: 'x', safetyText: 'a sufficiently long safety acknowledgement text', prerequisiteTopicIds: [T1] }).expect(400); // topic from another version
    await http.put(`/v1/authoring/versions/${draft.id}/labs/bad code!`).set(as('author')).send({}).expect(400);
    const r = (await http.put(`/v1/authoring/versions/${draft.id}/labs/LAB-A`).set(as('author')).send({ title: 'Circuit lab', safetyText: 'a sufficiently long safety acknowledgement text', prerequisiteTopicIds: [dt], location: 'Lab 2' }).expect(200)).body;
    expect(r.safetyHash).toHaveLength(64); await http.put(`/v1/authoring/versions/${draft.id}/labs/LAB-A`).set(as('l1')).send({}).expect(403);
    await http.put(`/v1/authoring/versions/${V}/labs/L9`).set(as('admin')).send({ title: 'x', safetyText: 'a sufficiently long safety acknowledgement text' }).expect(409); // published: frozen
  });
  it('slots: coordinator only, future only, published course only', async () => {
    await futureSlot().set(as('l1')).expect(403); await futureSlot({ startsAt: new Date(Date.now() - 1000).toISOString() }).expect(400); await futureSlot({ capacity: 0 }).expect(400);
    slotId = (await futureSlot().expect(201)).body.id; expect((await http.get(`/v1/labs/slots?activityId=${LAB}`).set(as('l1')).expect(200)).body[0]).toMatchObject({ id: slotId, seatsLeft: 2 });
  });
  it('booking needs prerequisites complete AND the current safety text acknowledged; capacity is race-safe; one booking per lab', async () => {
    const labs = (await http.get('/v1/me/labs').set(as('l1')).expect(200)).body[0]; hash = labs.safetyHash; expect(labs.eligibility).toMatchObject({ eligible: false, safetyAcknowledged: false });
    const r = await http.post(`/v1/labs/slots/${slotId}/book`).set(as('l1')).expect(409); expect(r.body).toMatchObject({ error: 'not_eligible', safetyAcknowledged: false });
    await http.post(`/v1/labs/activities/${LAB}/ack`).set(as('l1')).send({ textHash: 'stale' }).expect(409); await http.post(`/v1/labs/activities/${LAB}/ack`).set(as('l1')).send({ textHash: hash }).expect(201);
    await http.post(`/v1/labs/slots/${slotId}/book`).set(as('l1')).expect(201); await http.post(`/v1/labs/slots/${slotId}/book`).set(as('l1')).expect(409);
    for (const k of ['m1', 'm2', 'm3']) { await mkLearner(k, { lab: false }); await http.post(`/v1/labs/activities/${LAB}/ack`).set(as(k)).send({ textHash: hash }).expect(201); }
    const race = await Promise.all(['m1', 'm2', 'm3'].map((k) => http.post(`/v1/labs/slots/${slotId}/book`).set(as(k)))); // capacity 2, one seat taken
    expect(race.filter((x: any) => x.status === 201)).toHaveLength(1); expect(race.filter((x: any) => x.status === 409)).toHaveLength(2);
    expect((await http.get(`/v1/labs/slots?activityId=${LAB}`).set(as('l1'))).body[0].seatsLeft).toBe(0);
  });
  it('learners cannot cancel inside the cut-off; coordinators can; cancelling a slot notifies everyone', async () => {
    const near = (await prisma.labSlot.create({ data: { activityId: LAB, batchCode: 'near', startsAt: new Date(Date.now() + 3 * 3600_000), endsAt: new Date(Date.now() + 6 * 3600_000), capacity: 5, createdById: uid.lab1 } })).id;
    await mkLearner('n1', { lab: false }); await http.post(`/v1/labs/activities/${LAB}/ack`).set(as('n1')).send({ textHash: hash }).expect(201);
    const b = (await http.post(`/v1/labs/slots/${near}/book`).set(as('n1')).expect(201)).body.id;
    await http.post(`/v1/labs/bookings/${b}/cancel`).set(as('n1')).expect(409); await http.post(`/v1/labs/bookings/${b}/cancel`).set(as('lab1')).expect(201);
    await http.post(`/v1/labs/slots/${slotId}/cancel`).set(as('lab1')).send({}).expect(400);
    expect((await http.post(`/v1/labs/slots/${slotId}/cancel`).set(as('lab1')).send({ reason: 'Equipment fault' }).expect(201)).body.cancelledBookings).toBe(2);
    expect((await prisma.notification.findMany({ where: { type: 'lab.slot_cancelled' } })).length).toBe(2); await http.post(`/v1/labs/slots/${slotId}/book`).set(as('m1')).expect(404);
  });
  it('attendance by teacher; completion needs evidence; coordinator completion is reasoned and audited', async () => {
    const slot = (await prisma.labSlot.create({ data: { activityId: LAB, batchCode: 'now', startsAt: new Date(Date.now() - 10 * 60_000), endsAt: new Date(Date.now() + 3600_000), capacity: 10, createdById: uid.lab1 } })).id;
    for (const k of ['m1', 'm2']) await http.post(`/v1/labs/slots/${slot}/book`).set(as(k)).expect(409); // already started
    const b = async (k: string) => (await prisma.labBooking.create({ data: { slotId: slot, activityId: LAB, learnerId: uid[k], entitlementId: ENT[k] } })).id;
    const b1 = await b('m1'), b2 = await b('m2');
    await http.post(`/v1/labs/slots/${slot}/attendance`).set(as('m1')).send({ learnerId: uid.m1, status: 'ATTENDED' }).expect(403);
    await http.post(`/v1/labs/slots/${slot}/attendance`).set(as('lab1')).send({ learnerId: uid.m1, status: 'MAYBE' }).expect(400);
    await http.post(`/v1/labs/slots/${slot}/attendance`).set(as('lab1')).send({ learnerId: uid.m1, status: 'ATTENDED' }).expect(201);
    expect((await prisma.labBooking.findUniqueOrThrow({ where: { id: b1 } })).completedAt).toBeNull(); // evidence still required
    await http.post(`/v1/labs/bookings/${b1}/evidence`).set(as('m1')).send({ files: [{ key: 'labs/someone-else/x.pdf' }] }).expect(403);
    await http.put('/v1/labs/evidence/upload?name=run.exe').set(as('m1')).send(Buffer.from('x')).expect(400);
    const up = (await http.put('/v1/labs/evidence/upload?name=circuit.png').set(as('m1')).set('content-type', 'application/octet-stream').send(Buffer.from('png')).expect(200)).body;
    await http.post(`/v1/labs/bookings/${b2}/evidence`).set(as('m2')).send({ files: [up] }).expect(403); // not their upload / not attended
    await http.post(`/v1/labs/bookings/${b1}/evidence`).set(as('m1')).send({ files: [up], note: 'done' }).expect(201);
    expect((await prisma.labBooking.findUniqueOrThrow({ where: { id: b1 } })).completedAt).not.toBeNull(); expect((await prisma.notification.findMany({ where: { userId: uid.m1, type: 'lab.completed' } })).length).toBe(1);
    await http.post(`/v1/labs/slots/${slot}/attendance`).set(as('lab1')).send({ learnerId: uid.m2, status: 'ATTENDED' }).expect(201);
    await http.post(`/v1/labs/bookings/${b2}/complete`).set(as('lab1')).send({}).expect(400); await http.post(`/v1/labs/bookings/${b2}/complete`).set(as('lab1')).send({ reason: 'Evidence handed in on paper' }).expect(201);
    expect((await prisma.auditEvent.findMany({ where: { action: 'lab.completed_by_coordinator' } })).length).toBe(1);
    const roster = (await http.get(`/v1/labs/slots/${slot}/roster`).set(as('lab1')).expect(200)).body; expect(roster.map((r: any) => r.completed)).toEqual([true, true]); await http.get(`/v1/labs/slots/${slot}/roster`).set(as('m1')).expect(403);
  });
  it('signed rotating QR: valid scan marks attendance idempotently; forged, expired, unbooked and out-of-window scans are refused', async () => {
    const slot = (await prisma.labSlot.create({ data: { activityId: LAB, batchCode: 'qr', startsAt: new Date(Date.now() + 5 * 60_000), endsAt: new Date(Date.now() + 3600_000), capacity: 10, createdById: uid.lab1 } })).id;
    await mkLearner('q1', { lab: false }); await mkLearner('q2', { lab: false });
    const bk = (await prisma.labBooking.create({ data: { slotId: slot, activityId: LAB, learnerId: uid.q1, entitlementId: ENT.q1 } })).id;
    const qr = (await http.get(`/v1/labs/slots/${slot}/qr`).set(as('lab1')).expect(200)).body; expect(qr.validSeconds).toBe(QR_VALID_MS / 1000); await http.get(`/v1/labs/slots/${slot}/qr`).set(as('q1')).expect(403);
    await http.post('/v1/labs/attendance').set(as('q2')).send({ token: qr.token }).expect(403); // no booking
    await http.post('/v1/labs/attendance').set(as('q1')).send({ token: qr.token + 'x' }).expect(403); await http.post('/v1/labs/attendance').set(as('q1')).send({ token: signToken('wrong-secret', { k: `labqr:${slot}`, exp: Date.now() + 60000 }) }).expect(403);
    await http.post('/v1/labs/attendance').set(as('q1')).send({ token: signToken(process.env.JWT_SECRET!, { k: `labqr:${slot}`, exp: Date.now() - 1000 }) }).expect(403);
    await http.post('/v1/labs/attendance').set(as('q1')).send({ token: qr.token }).expect(201); await http.post('/v1/labs/attendance').set(as('q1')).send({ token: qr.token }).expect(201);
    expect(await prisma.labBooking.findUniqueOrThrow({ where: { id: bk } })).toMatchObject({ status: 'ATTENDED', attendanceMethod: 'QR' });
    const early = (await prisma.labSlot.create({ data: { activityId: LAB, batchCode: 'early', startsAt: new Date(Date.now() + 5 * 3600_000), endsAt: new Date(Date.now() + 7 * 3600_000), capacity: 10, createdById: uid.lab1 } })).id;
    await prisma.labBooking.create({ data: { slotId: early, activityId: LAB, learnerId: uid.q2, entitlementId: ENT.q2 } });
    const earlyToken = (await http.get(`/v1/labs/slots/${early}/qr`).set(as('lab1'))).body.token;
    await http.post('/v1/labs/attendance').set(as('q2')).send({ token: earlyToken }).expect(409); // too early
  });
});

// ============================================================== EXAM SETUP =================================================================
const BANK = [
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ tag: 'sensors', type: 'MCQ_SINGLE', text: `Sensor Q${i}`, options: ['A', 'B', 'C', 'D'], answer: i % 4, difficulty: 2, points: 2 })),
  ...[0, 1, 2].map((i) => ({ tag: 'sensors', type: 'MCQ_MULTI', text: `Sensor multi ${i}`, options: ['A', 'B', 'C', 'D'], answer: [0, 2], difficulty: 3, points: 3 })),
  ...[0, 1, 2].map((i) => ({ tag: 'sensors', type: 'NUMERIC', text: `Sensor numeric ${i}`, answer: 10 + i, tolerance: 0.1, difficulty: 2, points: 1 })),
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ tag: 'networks', type: 'MCQ_SINGLE', text: `Network Q${i}`, options: ['A', 'B', 'C', 'D'], answer: (i + 1) % 4, difficulty: 2, points: 2, i18n: { hi: { text: `नेटवर्क प्रश्न ${i}`, options: ['अ', 'ब', 'स', 'द'] } } })),
];
const examBody = (o: any = {}) => ({ versionId: V, code: 'FINAL', title: 'Final exam', durationMin: 30, passPercent: 60, maxAttempts: 2, blueprint: [{ tag: 'sensors', count: 4 }, { tag: 'networks', count: 3 }], proctoring: { mode: 'REMOTE', requireId: true, requireDevice: true, device: { camera: true, microphone: true, singleScreen: true } }, ...o });

describe('exam bank, definitions, sessions', () => {
  it('the exam bank is invisible to authors and faculty; questions are validated; freeze blocks edits', async () => {
    for (const k of ['author', 'fac1', 'l1', 'lab1']) await http.post(`/v1/exams/bank/${P}/questions`).set(as(k)).send({ questions: BANK }).expect(403);
    await http.post(`/v1/exams/bank/${P}/questions`).set(as('e1')).send({ questions: [{ type: 'MCQ_SINGLE', text: 'q', tag: 't', options: ['a', 'b'], answer: 7 }] }).expect(400);
    await http.post(`/v1/exams/bank/${P}/questions`).set(as('e1')).send({ questions: [{ type: 'MCQ_SINGLE', text: 'q', tag: 't', options: ['a', 'b'], answer: [0] }] }).expect(400);
    await http.post(`/v1/exams/bank/${P}/questions`).set(as('e1')).send({ questions: [] }).expect(400);
    await http.put('/v1/admin/config/exam.change_freeze').set(as('platform')).send({ value: true }).expect(200);
    await http.post(`/v1/exams/bank/${P}/questions`).set(as('e1')).send({ questions: BANK.map((q) => ({ ...q })) }).expect(423); await http.put('/v1/admin/config/exam.change_freeze').set(as('platform')).send({ value: false }).expect(200);
    expect((await http.post(`/v1/exams/bank/${P}/questions`).set(as('e1')).send({ questions: BANK.map((q: any) => ({ ...q, tag: q.tag })) }).expect(201)).body.added).toBe(18);
    const cov = (await http.get(`/v1/exams/bank/${P}/coverage`).set(as('assess1')).expect(200)).body; expect(cov.filter((c: any) => c.tag === 'networks').reduce((s: number, c: any) => s + c.count, 0)).toBe(6);
  });
  it('definition needs a satisfiable blueprint and a different administrator to publish; published exams are immutable', async () => {
    await http.post('/v1/exams').set(as('author')).send(examBody()).expect(403);
    await http.post('/v1/exams').set(as('e1')).send(examBody({ durationMin: 5 })).expect(400); await http.post('/v1/exams').set(as('e1')).send(examBody({ blueprint: [] })).expect(400); await http.post('/v1/exams').set(as('e1')).send(examBody({ proctoring: { mode: 'ONLINE' } })).expect(400);
    const bad = (await http.post('/v1/exams').set(as('e1')).send(examBody({ code: 'BAD', blueprint: [{ tag: 'sensors', count: 50 }] })).expect(201)).body.id;
    const r = await http.post(`/v1/exams/${bad}/publish`).set(as('assess1')).expect(400); expect(r.body.issues.join()).toMatch(/needs 50 questions, bank has 12/);
    EXAM = (await http.post('/v1/exams').set(as('e1')).send(examBody()).expect(201)).body.id;
    await http.post(`/v1/exams/${EXAM}/publish`).set(as('e1')).expect(409); // creator cannot publish
    const p = (await http.post(`/v1/exams/${EXAM}/publish`).set(as('assess1')).expect(201)).body; expect(p.status).toBe('PUBLISHED'); await http.post(`/v1/exams/${EXAM}/publish`).set(as('assess2')).expect(409);
    CODES[EXAM] = 'FINAL'; CENTRE_EXAM = (await http.post('/v1/exams').set(as('e1')).send(examBody({ code: 'CENTRE1', proctoring: { mode: 'CENTRE', requireId: true, requireDevice: false } })).expect(201)).body.id; await http.post(`/v1/exams/${CENTRE_EXAM}/publish`).set(as('assess1')).expect(201); CODES[CENTRE_EXAM] = 'CENTRE1';
    expect((await prisma.auditEvent.findMany({ where: { action: 'exam.published' } })).length).toBe(2);
  });
  it('sessions: future only, window must fit the exam, mode must match proctoring config', async () => {
    const f = (o: any) => http.post(`/v1/exams/${EXAM}/sessions`).set(as('e1')).send({ startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 86400000 + 2 * 3600_000).toISOString(), mode: 'REMOTE', capacity: 2, ...o });
    await f({ startsAt: new Date(Date.now() - 1000).toISOString() }).expect(400); await f({ endsAt: new Date(Date.now() + 86400000 + 600_000).toISOString() }).expect(400); await f({ mode: 'CENTRE', centre: 'x' }).expect(400); await f({}).set(as('l1')).expect(403);
    SESSION = (await f({}).expect(201)).body.id; expect((await http.get(`/v1/exams/${EXAM}/sessions`).set(as('auditor')).expect(200)).body).toHaveLength(1);
  });
});

describe('eligibility and registration (EXM-001)', () => {
  it('learners see exactly which conditions fail; registration is refused with the reasons; completing the lab fixes it', async () => {
    const e = (await http.get('/v1/me/exams').set(as('l1')).expect(200)).body.find((x: any) => x.examId === EXAM);
    expect(e.eligibility.eligible).toBe(false); expect(e.eligibility.checks.find((c: any) => c.key === 'labs').detail).toMatch(/L1/); expect(e.eligibility.checks.find((c: any) => c.key === 'programme_progress').ok).toBe(false); // T2 quiz not passed for l1
    const r = await http.post(`/v1/exams/${EXAM}/register`).set(as('l1')).send({ sessionId: SESSION }).expect(409); expect(r.body.error).toBe('not_eligible');
    await prisma.topicProgress.create({ data: { entitlementId: ENT.l1, topicId: T2, videoDone: true, quizPassed: true } }); await completeLab('l1');
    await http.post(`/v1/exams/${EXAM}/register`).set(as('l1')).send({ sessionId: SESSION }).expect(201);
    expect((await prisma.notification.findMany({ where: { userId: uid.l1, type: 'exam.registered' } })).length).toBe(1);
  });
  it('capacity is race-safe; one active registration per exam; late cancellation refused', async () => {
    const small = (await http.post(`/v1/exams/${EXAM}/sessions`).set(as('e1')).send({ startsAt: new Date(Date.now() + 2 * 86400000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400000 + 2 * 3600_000).toISOString(), mode: 'REMOTE', capacity: 1 }).expect(201)).body.id;
    for (const k of ['r1', 'r2']) await mkLearner(k);
    const race = await Promise.all(['r1', 'r2'].map((k) => http.post(`/v1/exams/${EXAM}/register`).set(as(k)).send({ sessionId: small }))); expect(race.map((x: any) => x.status).sort()).toEqual([201, 409]);
    await http.post(`/v1/exams/${EXAM}/register`).set(as('l1')).send({ sessionId: small }).expect(409); // already registered elsewhere
    const soon = (await prisma.examSession.create({ data: { examId: EXAM, startsAt: new Date(Date.now() + 20 * 60_000), endsAt: new Date(Date.now() + 3 * 3600_000), mode: 'REMOTE', capacity: 9, createdById: uid.e1 } })).id;
    await mkLearner('r3'); await http.post(`/v1/exams/${EXAM}/register`).set(as('r3')).send({ sessionId: soon }).expect(201); await http.post(`/v1/exam-sessions/${soon}/unregister`).set(as('r3')).expect(409);
    await http.post(`/v1/exam-sessions/${SESSION}/unregister`).set(as('l1')).expect(201); await http.post(`/v1/exams/${EXAM}/register`).set(as('l1')).send({ sessionId: SESSION }).expect(201);
  });
  it('an exception waives academic conditions (audited) but never an inactive entitlement or an integrity case; assignments under review block', async () => {
    await mkLearner('o1', { lab: false, quiz: false });
    await http.post(`/v1/exams/${EXAM}/eligibility-overrides`).set(as('e1')).send({ learnerId: uid.o1, reason: 'x' }).expect(403); await http.post(`/v1/exams/${EXAM}/eligibility-overrides`).set(as('admin')).send({ learnerId: uid.o1 }).expect(400);
    await http.post(`/v1/exams/${EXAM}/eligibility-overrides`).set(as('admin')).send({ learnerId: uid.o1, reason: 'Lab and quiz completed at partner institute' }).expect(201);
    const el = (await http.get('/v1/me/exams').set(as('o1'))).body.find((x: any) => x.examId === EXAM).eligibility; expect(el).toMatchObject({ eligible: true, overridden: true });
    await prisma.entitlement.update({ where: { id: ENT.o1 }, data: { status: 'PAUSED' } }); expect((await http.get('/v1/me/exams').set(as('o1'))).body.find((x: any) => x.examId === EXAM).eligibility.eligible).toBe(false); await prisma.entitlement.update({ where: { id: ENT.o1 }, data: { status: 'ACTIVE' } });
    // integrity case blocks, and an override cannot waive it
    const topic = await prisma.topic.create({ data: { moduleId: (await prisma.module.findFirstOrThrow({ where: { versionId: V } })).id, position: 9, title: 'Opt', hours: 1, mandatory: false } });
    const asg = await prisma.assignment.create({ data: { topicId: topic.id, instructions: 'x' } });
    const sub = await prisma.submission.create({ data: { assignmentId: asg.id, topicId: topic.id, learnerId: uid.o1, entitlementId: ENT.o1, attemptNo: 1, content: {} } });
    await prisma.submissionGrade.create({ data: { submissionId: sub.id, assignmentId: asg.id, topicId: topic.id, learnerId: uid.o1, entitlementId: ENT.o1, versionId: V, state: 'GRADED', integrityOutcome: 'CONFIRMED_CONCERN', finalPercent: 40 } });
    const blocked = (await http.get('/v1/me/exams').set(as('o1'))).body.find((x: any) => x.examId === EXAM).eligibility; expect(blocked.eligible).toBe(false); expect(blocked.checks.find((c: any) => c.key === 'integrity').ok).toBe(false);
    await http.post(`/v1/exams/integrity-cases/${sub.id}/resolve`).set(as('admin')).send({ reason: 'Case closed after hearing' }).expect(201); expect((await http.get('/v1/me/exams').set(as('o1'))).body.find((x: any) => x.examId === EXAM).eligibility.eligible).toBe(true);
    await prisma.submissionGrade.update({ where: { submissionId: sub.id }, data: { state: 'MODERATION_REQUIRED' } }); expect((await http.get('/v1/me/exams').set(as('o1'))).body.find((x: any) => x.examId === EXAM).eligibility.checks.find((c: any) => c.key === 'assignments_released').ok).toBe(false);
    await prisma.submissionGrade.delete({ where: { submissionId: sub.id } });
  });
});

describe('check-in: consent, device, identity (EXM-003)', () => {
  let s: string;
  it('consent is explicit and versioned; device must pass; identity by provider webhook; provider only sees a token', async () => {
    await mkLearner('c1'); s = (await runningSession(EXAM)).id; await register('c1', EXAM, s);
    const noConsent = await http.post(`/v1/exam-sessions/${s}/check-in`).set(as('c1')).send({ consent: false, device: DEV }).expect(400); expect(noConsent.body.consentText).toMatch(/consent to identity verification/);
    await http.post(`/v1/exam-sessions/${s}/check-in`).set(as('c1')).send({ consent: true, consentHash: 'stale', device: DEV }).expect(400);
    await http.post(`/v1/exam-sessions/${s}/check-in`).set(as('l1')).send({ consent: true, device: DEV }).expect(403); // not registered for this session
    const bad = (await checkIn('c1', s, EXAM, { browserSupported: true, camera: false, microphone: true, screens: 2, bandwidthKbps: 100 }).expect(201)).body;
    expect(bad).toMatchObject({ status: 'CHECKED_IN', device: { ok: false } }); expect(bad.device.problems).toEqual(expect.arrayContaining(['camera not available', 'more than one screen detected']));
    const a = await attempt(bad.attemptId); expect(a.providerSessionId).toBeTruthy(); const ps = mock.sessions.get(a.providerSessionId!)!.req;
    expect(ps).toMatchObject({ consent: true, examCode: 'FINAL', mode: 'REMOTE' }); expect(JSON.stringify(ps)).not.toMatch(/c1@x\.test|c1 Person/); expect(ps.learnerToken).toMatch(/^[0-9a-f]{32}$/); expect(ps.learnerToken).not.toContain(uid.c1);
    await http.post(`/v1/exam-attempts/${bad.attemptId}/start`).set(as('c1')).expect(409);
    const fixed = (await http.post(`/v1/exam-attempts/${bad.attemptId}/device-check`).set(as('c1')).send({ device: DEV }).expect(201)).body; expect(fixed).toMatchObject({ status: 'CHECKED_IN', device: { ok: true } }); // still waiting for identity
    const nr = await http.post(`/v1/exam-attempts/${bad.attemptId}/start`).set(as('c1')).expect(409); expect(nr.body).toMatchObject({ error: 'not_ready', device: true, identity: 'PENDING' });
    await wh(ev(a.providerSessionId!, 'identity_verified')).expect(201); expect((await attempt(bad.attemptId)).status).toBe('READY');
    const again = (await checkIn('c1', s, EXAM).expect(201)).body; expect(again.attemptId).toBe(bad.attemptId); expect(mock.byAttempt.size).toBeGreaterThan(0); // idempotent re-check-in
  });
  it('failed provider identity check raises a HIGH incident; provider outage returns 503 without stranding the learner; window enforced', async () => {
    await mkLearner('c2'); const s2 = (await runningSession(EXAM)).id; await register('c2', EXAM, s2); const ci = (await checkIn('c2', s2, EXAM).expect(201)).body; const a = await attempt(ci.attemptId);
    await wh(ev(a.providerSessionId!, 'identity_failed', { detail: { reason: 'face mismatch' } })).expect(201);
    expect(await prisma.incident.findFirstOrThrow({ where: { attemptId: a.id, type: 'identity_failed' } })).toMatchObject({ severity: 'HIGH', status: 'OPEN', source: 'PROVIDER' }); expect((await attempt(a.id)).status).toBe('CHECKED_IN');
    await mkLearner('c3'); const s3 = (await runningSession(EXAM)).id; await register('c3', EXAM, s3);
    const orig = mock.createSession.bind(mock); (mock as any).createSession = async () => { throw new Error('vendor down'); };
    await checkIn('c3', s3, EXAM).expect(503); (mock as any).createSession = orig; await checkIn('c3', s3, EXAM).expect(201);
    await mkLearner('c4'); const late = (await prisma.examSession.create({ data: { examId: EXAM, startsAt: new Date(Date.now() + 3 * 3600_000), endsAt: new Date(Date.now() + 5 * 3600_000), mode: 'REMOTE', capacity: 9, createdById: uid.e1 } })).id; await register('c4', EXAM, late);
    await checkIn('c4', late, EXAM).expect(409); // opens 15 minutes before
  });
});

describe('taking the exam (EXM-002)', () => {
  it('papers are randomised per learner, keys never leave the server, Hindi text is served when preferred, watermark is attempt-specific', async () => {
    await mkLearner('t1'); await mkLearner('t2', { language: 'hi' });
    const a = await start('t1'), b = await start('t2'); const qa = a.body.questions;
    expect(qa).toHaveLength(7); expect(JSON.stringify(a.body)).not.toMatch(/"answer"|correct|tolerance|rationale/); expect(qa.filter((q: any) => q.tag === 'sensors')).toHaveLength(4); expect(qa.filter((q: any) => q.tag === 'networks')).toHaveLength(3);
    expect(qa.map((q: any) => q.id)).not.toEqual(b.body.questions.map((q: any) => q.id)); expect(a.body.watermark).toMatch(/^[0-9A-F]{8}$/); expect(a.body.watermark).not.toBe(b.body.watermark);
    expect(b.body.questions.filter((q: any) => q.tag === 'networks')[0].text).toMatch(/नेटवर्क/);
    const dl = new Date(a.body.deadlineAt).getTime() - new Date(a.body.serverTime).getTime(); expect(dl).toBe(30 * 60_000);
    const resumed = (await http.post(`/v1/exam-attempts/${a.attemptId}/resume`).set(as('t1')).send({ deviceId: 'phone' }).expect(201)).body; expect(resumed.questions.map((q: any) => q.id)).toEqual(qa.map((q: any) => q.id)); expect(resumed.questions.map((q: any) => q.options)).toEqual(qa.map((q: any) => q.options)); // identical paper on reconnect
    await http.post(`/v1/exam-attempts/${a.attemptId}/start`).set(as('t1')).expect(409);
  });
  it('autosave: needs the live session token, is idempotent and monotonic, only accepts questions on your paper; reconnect locks out the old window', async () => {
    await mkLearner('t3'); const s = await start('t3'); const qid = s.body.questions[0].id; const H = (t: string) => ({ ...as('t3'), ...sess(t) });
    await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(as('t3')).send({ seq: 1, answers: {} }).expect(409); await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(H('bogus')).send({ seq: 1, answers: {} }).expect(409);
    expect((await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(H(s.token)).send({ seq: 1, answers: { [qid]: 1 } }).expect(200)).body).toMatchObject({ saved: true, saveSeq: 1 });
    expect((await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(H(s.token)).send({ seq: 1, answers: { [qid]: 3 } }).expect(200)).body).toMatchObject({ saved: false, saveSeq: 1 }); // duplicate/stale ignored
    expect((await attempt(s.attemptId)).answers).toEqual({ [qid]: 1 });
    await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(H(s.token)).send({ seq: 2, answers: { 'not-on-paper': 1 } }).expect(400); await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(H(s.token)).send({ seq: 0, answers: {} }).expect(400);
    await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(as('t1')).set(sess(s.token)).send({ seq: 3, answers: {} }).expect(404); // someone else's attempt
    const r = (await http.post(`/v1/exam-attempts/${s.attemptId}/resume`).set(as('t3')).send({ deviceId: 'laptop2' }).expect(201)).body; expect(r.answers).toEqual({ [qid]: 1 }); expect(r.remainingMs).toBeGreaterThan(29 * 60_000 - 5000);
    await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(H(s.token)).send({ seq: 4, answers: { [qid]: 2 } }).expect(409); // old window is out
    await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set(H(r.sessionToken)).send({ seq: 4, answers: { [qid]: 2 } }).expect(200);
  });
  it('platform-detected signals and repeated session switches become incidents for human review, never automatic penalties', async () => {
    await mkLearner('t4'); const s = await start('t4'); const H = { ...as('t4'), ...sess(s.token) };
    await http.post(`/v1/exam-attempts/${s.attemptId}/signals`).set(H).send({ kind: 'DANCE' }).expect(400);
    for (let i = 0; i < 4; i++) await http.post(`/v1/exam-attempts/${s.attemptId}/signals`).set(H).send({ kind: 'FOCUS_LOST' }).expect(201); expect(await prisma.incident.count({ where: { attemptId: s.attemptId } })).toBe(0);
    await http.post(`/v1/exam-attempts/${s.attemptId}/signals`).set(H).send({ kind: 'FOCUS_LOST' }).expect(201); await http.post(`/v1/exam-attempts/${s.attemptId}/signals`).set(H).send({ kind: 'FOCUS_LOST' }).expect(201);
    expect(await prisma.incident.findMany({ where: { attemptId: s.attemptId } })).toEqual([expect.objectContaining({ type: 'tab_switch', severity: 'MEDIUM', source: 'SYSTEM', status: 'OPEN' })]); // one per type/severity
    for (let i = 0; i < 3; i++) await http.post(`/v1/exam-attempts/${s.attemptId}/resume`).set(as('t4')).send({}).expect(201);
    expect((await prisma.incident.findMany({ where: { attemptId: s.attemptId } })).map((i) => i.type).sort()).toEqual(['session_takeover', 'tab_switch']); expect((await attempt(s.attemptId)).status).toBe('IN_PROGRESS');
  });
  it('accommodations extend only the learner\'s own clock, within the session window, and are audited', async () => {
    await mkLearner('t5'); await http.post('/v1/exams/accommodations').set(as('l1')).send({ learnerId: uid.t5, type: 'EXTRA_TIME', extraTimePercent: 25, reason: 'x' }).expect(403);
    await http.post('/v1/exams/accommodations').set(as('e1')).send({ learnerId: uid.t5, type: 'EXTRA_TIME', extraTimePercent: 500, reason: 'x' }).expect(400);
    await http.post('/v1/exams/accommodations').set(as('e1')).send({ learnerId: uid.t5, type: 'EXTRA_TIME', extraTimePercent: 25, reason: 'Documented dyslexia, certificate 2026/114' }).expect(201);
    const s = await start('t5'); expect(new Date(s.body.deadlineAt).getTime() - new Date(s.body.serverTime).getTime()).toBe(37.5 * 60_000); expect((await prisma.auditEvent.findMany({ where: { action: 'exam.accommodation_granted' } })).length).toBe(1);
    const tight = await prisma.examSession.create({ data: { examId: EXAM, startsAt: new Date(Date.now() - 5 * 60_000), endsAt: new Date(Date.now() + 20 * 60_000), mode: 'REMOTE', capacity: 5, createdById: uid.e1 } }); await mkLearner('t6'); const s6 = await start('t6', EXAM, tight.id);
    expect(new Date(s6.body.deadlineAt).getTime() - new Date(s6.body.serverTime).getTime()).toBeLessThanOrEqual(20 * 60_000); // late starters lose time; the window never stretches
  });
  it('submission scores objectively through the option permutation, issues an immutable receipt, and is idempotent; late saves are refused; expiry auto-submits what was saved', async () => {
    await mkLearner('s1'); const s = await sit('s1'); const a = await attempt(s.attemptId);
    expect(a.score).toMatchObject({ percent: 100 }); expect(a.passed).toBe(true); expect(s.receipt).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect((await http.post(`/v1/exam-attempts/${s.attemptId}/submit`).set({ ...as('s1'), ...sess(s.token) }).expect(201)).body.receiptCode).toBe(s.receipt);
    await http.put(`/v1/exam-attempts/${s.attemptId}/answers`).set({ ...as('s1'), ...sess(s.token) }).send({ seq: 9, answers: {} }).expect(409);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ExamSubmission" SET "answersHash"='x'`)).rejects.toThrow(/append-only/); await expect(prisma.$executeRawUnsafe(`DELETE FROM "ExamSubmission"`)).rejects.toThrow(/append-only/);
    await mkLearner('s2'); const w = await sit('s2', { all: false }); expect((await attempt(w.attemptId)).score).toMatchObject({ percent: 0 });
    await mkLearner('s3'); const e = await start('s3'); const some = Object.entries(await correct(e.attemptId)).slice(0, 3); await http.put(`/v1/exam-attempts/${e.attemptId}/answers`).set({ ...as('s3'), ...sess(e.token) }).send({ seq: 1, answers: Object.fromEntries(some) }).expect(200);
    await prisma.examAttempt.update({ where: { id: e.attemptId }, data: { deadlineAt: new Date(Date.now() - 60_000) } });
    await http.put(`/v1/exam-attempts/${e.attemptId}/answers`).set({ ...as('s3'), ...sess(e.token) }).send({ seq: 2, answers: {} }).expect(409); await http.post(`/v1/exam-attempts/${e.attemptId}/submit`).set({ ...as('s3'), ...sess(e.token) }).expect(409);
    expect((await http.post('/v1/exam-ops/sweep').set(as('e1')).expect(201)).body.autoSubmitted).toBeGreaterThanOrEqual(1);
    const au = await attempt(e.attemptId); expect(au).toMatchObject({ status: 'SUBMITTED', autoSubmitted: true }); expect((au.score as any).rawPoints).toBeGreaterThan(0); expect((await http.get(`/v1/me/exam-attempts/${e.attemptId}`).set(as('s3'))).body.receiptCode).toMatch(/-/);
  });
  it('the per-attempt event log is a hash chain: intact when untouched, tamper-evident, and append-only', async () => {
    const a = (await prisma.examAttempt.findFirstOrThrow({ where: { learnerId: uid.s1 } })).id; const v = (await http.get(`/v1/exam-ops/attempts/${a}/verify-log`).set(as('auditor')).expect(200)).body; expect(v).toMatchObject({ intact: true }); expect(v.events).toBeGreaterThanOrEqual(4);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ExamEvent" SET type='X' WHERE "attemptId"='${a}'`)).rejects.toThrow(/append-only/);
    await prisma.$executeRawUnsafe(`ALTER TABLE "ExamEvent" DISABLE TRIGGER exam_event_immutable`); await prisma.$executeRawUnsafe(`UPDATE "ExamEvent" SET payload='{"answersHash":"forged"}' WHERE "attemptId"='${a}' AND type='SUBMIT'`); await prisma.$executeRawUnsafe(`ALTER TABLE "ExamEvent" ENABLE TRIGGER exam_event_immutable`);
    expect((await http.get(`/v1/exam-ops/attempts/${a}/verify-log`).set(as('auditor'))).body.intact).toBe(false);
  });
});

describe('result hold, authorised release (EXM-004)', () => {
  it('remote results are held until the provider report is final; learners never see score or incident detail while held; webhook is signed and replay-safe', async () => {
    await mkLearner('h1'); const s = await sit('h1'); expect((await attempt(s.attemptId)).resultState).toBe('HELD');
    const v = (await http.get(`/v1/me/exam-attempts/${s.attemptId}`).set(as('h1')).expect(200)).body; expect(v).toMatchObject({ state: 'UNDER_REVIEW' }); expect(JSON.stringify(v)).not.toMatch(/percent|incident|score/);
    const body = ev(s.providerSessionId, 'report_final'); const raw = JSON.stringify(body), ts = Date.now();
    await http.post('/v1/proctoring/webhook').set({ 'x-timestamp': String(ts), 'x-signature': signWebhook('wrong', ts, raw), 'content-type': 'application/json' }).send(raw).expect(401);
    await http.post('/v1/proctoring/webhook').set({ 'x-timestamp': String(ts - 10 * 60_000), 'x-signature': signWebhook('whsec', ts - 10 * 60_000, raw), 'content-type': 'application/json' }).send(raw).expect(401);
    await http.post('/v1/proctoring/webhook').send({ eventId: 'x' }).expect(401); await wh({ eventId: 1 }).expect(400);
    expect((await wh(body).expect(201)).body.status).toBe('accepted'); expect((await wh(body).expect(201)).body.status).toBe('duplicate'); expect((await wh(ev('no-such-session', 'report_final')).expect(201)).body.status).toBe('unknown_session');
    expect((await attempt(s.attemptId)).resultState).toBe('READY'); expect((await http.get(`/v1/me/exam-attempts/${s.attemptId}`).set(as('h1'))).body.state).toBe('AWAITING_RELEASE');
    await expect(prisma.$executeRawUnsafe(`UPDATE "ProctorWebhookEvent" SET provider='x'`)).rejects.toThrow(/append-only/);
  });
  it('release is for authorised roles only, once, and shows the learner a score without answer keys', async () => {
    const a = await prisma.examAttempt.findFirstOrThrow({ where: { learnerId: uid.h1 } });
    for (const k of ['e1', 'fac1', 'h1', 'author']) await http.post(`/v1/exam-ops/attempts/${a.id}/release`).set(as(k)).expect(403);
    await http.post(`/v1/exam-ops/attempts/${a.id}/release`).set(as('assess2')).expect(201); await http.post(`/v1/exam-ops/attempts/${a.id}/release`).set(as('admin')).expect(409);
    const v = (await http.get(`/v1/me/exam-attempts/${a.id}`).set(as('h1')).expect(200)).body; expect(v).toMatchObject({ state: 'RELEASED', percent: 100, passed: true, passMark: 60 }); expect(Object.keys(v.sections).sort()).toEqual(['networks', 'sensors']); expect(JSON.stringify(v)).not.toMatch(/answer|perItem|questionId/);
    expect((await prisma.notification.findMany({ where: { userId: uid.h1, type: 'exam.result_released' } })).length).toBe(1);
    expect((await http.get(`/v1/exam-ops/attempts/${a.id}/result`).set(as('assess1')).expect(200)).body.score.percent).toBe(100);
  });
  let hot: { attemptId: string; providerSessionId: string; incId: string };
  it('provider incidents hold the result even after the report is final; evidence links must be https and are access-controlled, expiring and audited', async () => {
    await mkLearner('h2'); const s = await sit('h2'); await wh(ev(s.providerSessionId, 'report_final')).expect(201); expect((await attempt(s.attemptId)).resultState).toBe('READY');
    await wh(ev(s.providerSessionId, 'incident', { incidentType: 'multiple_faces', severity: 'HIGH', evidenceUrl: 'https://vendor.example/evidence/abc', evidenceExpiresAt: new Date(Date.now() + 3600_000).toISOString() })).expect(201);
    await wh(ev(s.providerSessionId, 'incident', { incidentType: 'audio_anomaly', severity: 'LOW', evidenceUrl: 'http://insecure/evidence', evidenceExpiresAt: new Date(Date.now() - 1000).toISOString() })).expect(201);
    const incs = await prisma.incident.findMany({ where: { attemptId: s.attemptId }, orderBy: { severity: 'asc' } }); expect(incs).toHaveLength(2); expect((await attempt(s.attemptId)).resultState).toBe('HELD');
    const hi = incs.find((i) => i.type === 'multiple_faces')!, lo = incs.find((i) => i.type === 'audio_anomaly')!; expect(lo.evidenceUrl).toBeNull(); hot = { attemptId: s.attemptId, providerSessionId: s.providerSessionId, incId: hi.id };
    await http.get(`/v1/incidents/${hi.id}/evidence`).set(as('h2')).expect(403); await http.get(`/v1/incidents/${hi.id}/evidence`).set(as('auditor')).expect(403);
    expect((await http.get(`/v1/incidents/${hi.id}/evidence`).set(as('fac1')).expect(200)).body.url).toBe('https://vendor.example/evidence/abc'); await http.get(`/v1/incidents/${lo.id}/evidence`).set(as('fac1')).expect(404);
    await prisma.incident.update({ where: { id: hi.id }, data: { evidenceExpiresAt: new Date(Date.now() - 1000) } }); await http.get(`/v1/incidents/${hi.id}/evidence`).set(as('fac1')).expect(410);
    expect((await prisma.auditEvent.findMany({ where: { action: 'incident.evidence_accessed', objectId: hi.id } })).length).toBe(2); // success and expired attempt both logged
  });
  it('the incident queue is severity-ordered; the case file is pseudonymous and blind to the score', async () => {
    const q = (await http.get('/v1/exam-ops/incidents').set(as('fac1')).expect(200)).body; expect(q[0].severity).toBe('HIGH'); expect(q.every((x: any, i: number) => i === 0 || ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].indexOf(q[i - 1].severity) <= ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].indexOf(x.severity))).toBe(true); await http.get('/v1/exam-ops/incidents').set(as('l1')).expect(403);
    const c = (await http.get(`/v1/exam-ops/attempts/${hot.attemptId}/case`).set(as('fac1')).expect(200)).body; expect(c.learnerRef).toMatch(/^[0-9a-f]{8}$/); expect(JSON.stringify(c)).not.toMatch(/h2@x\.test|h2 Person|"percent"|rawPoints|score|passed/); expect(c.timeline.map((t: any) => t.type)).toEqual(expect.arrayContaining(['CHECK_IN', 'START', 'SAVE', 'SUBMIT', 'INCIDENT']));
    expect(JSON.stringify(c.timeline.find((t: any) => t.type === 'SAVE'))).not.toMatch(/answersHash/);
  });
  it('adjudication needs a valid decision and reason; a minor/dismissed outcome makes the result READY; a confirmed major incident needs a human ruling; an invalidation notifies the learner', async () => {
    const dec = (id: string, b: any, k = 'fac1') => http.post(`/v1/exam-ops/incidents/${id}/decide`).set(as(k)).send(b);
    await dec(hot.incId, { decision: 'MAYBE', reason: 'x' }).expect(400); await dec(hot.incId, { decision: 'DISMISSED' }).expect(400); await dec(hot.incId, { decision: 'DISMISSED', reason: 'x' }, 'e1').expect(403);
    await http.post(`/v1/exam-ops/attempts/${hot.attemptId}/outcome`).set(as('fac1')).send({ outcome: 'VALID', reason: 'x' }).expect(409); // open incidents remain
    await dec(hot.incId, { decision: 'NEEDS_INFO', reason: 'Request provider clip' }).expect(201); expect((await attempt(hot.attemptId)).resultState).toBe('HELD');
    await dec(hot.incId, { decision: 'CONFIRMED_MAJOR', reason: 'Second person visible for 40s' }).expect(201); expect((await attempt(hot.attemptId)).resultState).toBe('HELD'); // needs an outcome
    const lo = await prisma.incident.findFirstOrThrow({ where: { attemptId: hot.attemptId, type: 'audio_anomaly' } }); await dec(lo.id, { decision: 'DISMISSED', reason: 'Background noise' }).expect(201);
    await http.post(`/v1/exam-ops/attempts/${hot.attemptId}/outcome`).set(as('fac1')).send({ outcome: 'MAYBE', reason: 'x' }).expect(400);
    await http.post(`/v1/exam-ops/attempts/${hot.attemptId}/outcome`).set(as('fac1')).send({ outcome: 'INVALIDATED', reason: 'Impersonation by a second person' }).expect(201);
    expect(await attempt(hot.attemptId)).toMatchObject({ resultState: 'INVALIDATED', outcome: 'INVALIDATED', outcomeById: uid.fac1 }); expect((await prisma.notification.findMany({ where: { userId: uid.h2, type: 'exam.invalidated' } })).length).toBe(1);
    const v = (await http.get(`/v1/me/exam-attempts/${hot.attemptId}`).set(as('h2')).expect(200)).body; expect(v).toMatchObject({ state: 'INVALIDATED', reason: 'Impersonation by a second person', appeal: { eligible: true } }); expect(v.percent).toBeUndefined();
    await http.post(`/v1/exam-ops/attempts/${hot.attemptId}/release`).set(as('assess2')).expect(409); // an invalidated result is not "released"
    expect((await prisma.auditEvent.findMany({ where: { action: { in: ['incident.decided', 'exam.outcome_set'] } } })).length).toBeGreaterThanOrEqual(4);
  });
  it('segregation of duties: the person who recorded an incident cannot decide it; an adjudicator cannot release the attempt they ruled on; bulk release reports what it skipped', async () => {
    await mkLearner('h3'); const s = await sit('h3'); await wh(ev(s.providerSessionId, 'report_final')).expect(201);
    const inc = (await http.post(`/v1/proctor/attempts/${s.attemptId}/incidents`).set(as('e1')).send({ type: 'phone_visible', severity: 'MEDIUM', detail: { note: 'phone on desk' } }).expect(201)).body; await http.post(`/v1/proctor/attempts/${s.attemptId}/incidents`).set(as('fac1')).send({ type: 'x' }).expect(403); await http.post(`/v1/proctor/attempts/${s.attemptId}/incidents`).set(as('e1')).send({}).expect(400);
    await http.post(`/v1/exam-ops/incidents/${inc.id}/decide`).set(as('assess1')).send({ decision: 'CONFIRMED_MINOR', reason: 'x' }).expect(201); // fine: different person from recorder
    const mine = (await http.post(`/v1/proctor/attempts/${s.attemptId}/incidents`).set(as('assess1')).send({ type: 'late_arrival', severity: 'LOW' }).expect(201)).body; await http.post(`/v1/exam-ops/incidents/${mine.id}/decide`).set(as('assess1')).send({ decision: 'DISMISSED', reason: 'x' }).expect(409);
    await http.post(`/v1/exam-ops/incidents/${mine.id}/decide`).set(as('fac2')).send({ decision: 'DISMISSED', reason: 'Learner explained' }).expect(201); expect((await attempt(s.attemptId)).resultState).toBe('READY');
    await http.post(`/v1/exam-ops/attempts/${s.attemptId}/release`).set(as('assess1')).expect(409); // assess1 adjudicated an incident here
    await mkLearner('h4'); const s4 = await sit('h4', { all: false }); await wh(ev(s4.providerSessionId, 'report_final')).expect(201);
    const bulk = (await http.post(`/v1/exam-ops/sessions/${s.sessionId}/release-ready`).set(as('assess1')).expect(201)).body; expect(bulk.released).toBe(0); expect(bulk.skipped.map((x: any) => x.attemptId)).toEqual([s.attemptId]);
    await http.post(`/v1/exam-ops/attempts/${s.attemptId}/release`).set(as('admin')).expect(201);
  });
  it('a serious incident arriving after release pulls the result back for review', async () => {
    const a = await prisma.examAttempt.findFirstOrThrow({ where: { learnerId: uid.h1 } }); expect(a.resultState).toBe('RELEASED');
    await wh(ev((await attempt(a.id)).providerSessionId!, 'incident', { incidentType: 'late_provider_flag', severity: 'CRITICAL' })).expect(201);
    expect(await attempt(a.id)).toMatchObject({ resultState: 'HELD', releasedAt: null }); expect((await http.get(`/v1/me/exam-attempts/${a.id}`).set(as('h1'))).body.state).toBe('UNDER_REVIEW');
  });
  it('missing webhooks are recovered by polling the provider report', async () => {
    await mkLearner('p1'); const s = await sit('p1'); expect((await attempt(s.attemptId)).resultState).toBe('HELD');
    await prisma.examAttempt.update({ where: { id: s.attemptId }, data: { submittedAt: new Date(Date.now() - 10 * 60_000) } });
    mock.reports.set(s.providerSessionId, { final: true, incidents: [{ eventId: 'poll-1', type: 'face_missing', severity: 'MEDIUM', occurredAt: new Date().toISOString() }] });
    expect((await http.post('/v1/exam-ops/sweep').set(as('assess1')).expect(201)).body.reportsPolled).toBeGreaterThanOrEqual(1);
    expect(await attempt(s.attemptId)).toMatchObject({ proctorReportFinal: true, resultState: 'HELD' }); expect(await prisma.incident.count({ where: { attemptId: s.attemptId, providerEventId: 'poll-1' } })).toBe(1);
    await http.post('/v1/exam-ops/sweep').set(as('assess1')).expect(201); expect(await prisma.incident.count({ where: { attemptId: s.attemptId } })).toBe(1); // not duplicated
  });
  it('an unreachable provider report can be waived by an exam admin with a reason (audited)', async () => {
    await mkLearner('p2'); const s = await sit('p2'); await http.post(`/v1/exam-ops/attempts/${s.attemptId}/waive-report`).set(as('e1')).send({}).expect(400);
    await http.post(`/v1/exam-ops/attempts/${s.attemptId}/waive-report`).set(as('e1')).send({ reason: 'Provider outage confirmed in incident INC-77' }).expect(201); expect((await attempt(s.attemptId)).resultState).toBe('READY');
    expect((await prisma.auditEvent.findMany({ where: { action: 'exam.proctor_report_waived' } })).length).toBe(1);
  });
});

describe('appeals', () => {
  it('learners appeal an invalidation once, within the window; the original adjudicators cannot hear it; overturning releases a valid result', async () => {
    const a = hot0(); const id = (await a).id;
    await http.post(`/v1/me/exam-attempts/${id}/appeal`).set(as('h2')).send({ reason: 'too short' }).expect(400); await http.post(`/v1/me/exam-attempts/${id}/appeal`).set(as('h1')).send({ reason: 'x'.repeat(30) }).expect(404);
    const ap = (await http.post(`/v1/me/exam-attempts/${id}/appeal`).set(as('h2')).send({ reason: 'The second person was a family member passing in the room, not helping me.' }).expect(201)).body.appealId; await http.post(`/v1/me/exam-attempts/${id}/appeal`).set(as('h2')).send({ reason: 'x'.repeat(30) }).expect(409);
    expect((await http.get('/v1/exam-ops/appeals').set(as('fac2')).expect(200)).body[0].id).toBe(ap);
    await http.post(`/v1/exam-ops/appeals/${ap}/decide`).set(as('fac1')).send({ decision: 'OVERTURNED', reason: 'x' }).expect(403); // ruled on the original
    await http.post(`/v1/exam-ops/appeals/${ap}/decide`).set(as('fac2')).send({ decision: 'MAYBE', reason: 'x' }).expect(400); await http.post(`/v1/exam-ops/appeals/${ap}/decide`).set(as('fac2')).send({ decision: 'OVERTURNED' }).expect(400);
    await http.post(`/v1/exam-ops/appeals/${ap}/decide`).set(as('fac2')).send({ decision: 'OVERTURNED', reason: 'Centre CCTV confirms the person left before the start' }).expect(201);
    expect(await prisma.examAttempt.findUniqueOrThrow({ where: { id } })).toMatchObject({ resultState: 'RELEASED', outcome: 'VALID' }); expect((await http.get(`/v1/me/exam-attempts/${id}`).set(as('h2'))).body).toMatchObject({ state: 'RELEASED', percent: 100 });
    await http.post(`/v1/exam-ops/appeals/${ap}/decide`).set(as('fac2')).send({ decision: 'UPHELD', reason: 'x' }).expect(409); expect((await prisma.notification.findMany({ where: { userId: uid.h2, type: 'exam.appeal_decided' } })).length).toBe(1);
  });
  it('appeals are only for invalidated or incident-affected results and close with the window', async () => {
        const id = (await prisma.examAttempt.findFirstOrThrow({ where: { learnerId: uid.h3 } })).id; await prisma.examAttempt.update({ where: { id }, data: { releasedAt: new Date(Date.now() - 10 * 86400000) } });
    await http.post(`/v1/me/exam-attempts/${id}/appeal`).set(as('h3')).send({ reason: 'x'.repeat(30) }).expect(409);
    await http.post(`/v1/me/exam-attempts/${(await prisma.examAttempt.findFirstOrThrow({ where: { learnerId: uid.s1 } })).id}/appeal`).set(as('s1')).send({ reason: 'x'.repeat(30) }).expect(409); // clean result: nothing to appeal
  });
});
const hot0 = () => prisma.examAttempt.findFirstOrThrow({ where: { learnerId: uid.h2 } });

describe('centre-proctored exams', () => {
  it('identity is verified by a proctor (with a note); no provider is involved; results are READY at submission when clean', async () => {
    await mkLearner('z1'); const s = await runningSession(CENTRE_EXAM, 'CENTRE'); await register('z1', CENTRE_EXAM, s.id);
    const ci = (await checkIn('z1', s.id, CENTRE_EXAM, {}).expect(201)).body; expect(ci).toMatchObject({ mode: 'CENTRE', status: 'CHECKED_IN', idCheck: 'PENDING', launchUrl: null }); expect((await attempt(ci.attemptId)).providerSessionId).toBeNull();
    await http.post(`/v1/proctor/attempts/${ci.attemptId}/verify-id`).set(as('z1')).send({ status: 'VERIFIED', note: 'x' }).expect(403); await http.post(`/v1/proctor/attempts/${ci.attemptId}/verify-id`).set(as('e1')).send({ status: 'VERIFIED' }).expect(400);
    await http.post(`/v1/proctor/attempts/${ci.attemptId}/verify-id`).set(as('e1')).send({ status: 'VERIFIED', note: 'Aadhaar card matched at desk 4' }).expect(201); expect((await attempt(ci.attemptId)).status).toBe('READY');
    const st = (await http.post(`/v1/exam-attempts/${ci.attemptId}/start`).set(as('z1')).expect(201)).body;
    await http.put(`/v1/exam-attempts/${ci.attemptId}/answers`).set({ ...as('z1'), ...sess(st.sessionToken) }).send({ seq: 1, answers: await correct(ci.attemptId) }).expect(200); await http.post(`/v1/exam-attempts/${ci.attemptId}/submit`).set({ ...as('z1'), ...sess(st.sessionToken) }).expect(201);
    expect((await attempt(ci.attemptId)).resultState).toBe('READY'); expect((await prisma.auditEvent.findMany({ where: { action: 'exam.identity_set' } })).length).toBe(1);
    await http.post(`/v1/exam-ops/attempts/${ci.attemptId}/release`).set(as('admin')).expect(201);
  });
  it('a failed centre identity check raises an incident and blocks the start', async () => {
    await mkLearner('z2'); const s = await runningSession(CENTRE_EXAM, 'CENTRE'); await register('z2', CENTRE_EXAM, s.id); const ci = (await checkIn('z2', s.id, CENTRE_EXAM, {}).expect(201)).body;
    await http.post(`/v1/proctor/attempts/${ci.attemptId}/verify-id`).set(as('e1')).send({ status: 'FAILED', note: 'Photo does not match' }).expect(201);
    expect(await prisma.incident.findFirstOrThrow({ where: { attemptId: ci.attemptId } })).toMatchObject({ type: 'identity_failed', source: 'PROCTOR', severity: 'HIGH' }); await http.post(`/v1/exam-attempts/${ci.attemptId}/start`).set(as('z2')).expect(409);
  });
});

describe('operations, analytics, completion', () => {
  it('ops dashboard shows live attempts, stale autosave, incident queue, held/awaiting results; role-gated', async () => {
    await mkLearner('d1'); const s = await start('d1'); await prisma.examAttempt.update({ where: { id: s.attemptId }, data: { lastSavedAt: new Date(Date.now() - 5 * 60_000) } });
    await http.get('/v1/exam-ops/status').set(as('l1')).expect(403); const st = (await http.get('/v1/exam-ops/status').set(as('e1')).expect(200)).body;
    expect(st.inProgress).toBeGreaterThanOrEqual(1); expect(st.staleAutosave).toBeGreaterThanOrEqual(1); expect(st.heldResults).toBeGreaterThanOrEqual(1); expect(st).toHaveProperty('openIncidents'); expect(st.webhookEventsLastHour).toBeGreaterThan(5); expect(st.remoteAwaitingProctorReport).toBeGreaterThanOrEqual(0);
  });
  it('exam report: funnel, results, section means, item analysis, integrity and appeals; role-gated', async () => {
    await http.get(`/v1/reports/exams?examId=${EXAM}`).set(as('l1')).expect(403); await http.get('/v1/reports/exams').set(as('auditor')).expect(400);
    const r = (await http.get(`/v1/reports/exams?examId=${EXAM}`).set(as('auditor')).expect(200)).body;
    expect(r.funnel.submitted).toBeGreaterThan(8); expect(r.funnel.released).toBeGreaterThan(1); expect(r.funnel.invalidated).toBe(0); expect(r.funnel.autoSubmitted).toBe(1); expect(r.results.n).toBeGreaterThan(5); expect(r.results.passRate).toBeGreaterThan(0); expect(r.results.distribution).toHaveLength(10);
    expect(Object.keys(r.sections).sort()).toEqual(['networks', 'sensors']); expect(r.itemAnalysis[0]).toHaveProperty('pValue'); expect(r.integrity.byType).toHaveProperty('multiple_faces'); expect(r.integrity.byStatus.CONFIRMED_MAJOR).toBe(1); expect(r.appeals).toMatchObject({ filed: 1, overturned: 1 }); expect(r.integrity.sessionTakeovers).toBeGreaterThanOrEqual(1);
  });
  it('programme completion needs topics, mandatory labs and released passing exams; invalidated attempts do not count', async () => {
    await prisma.examDefinition.update({ where: { id: CENTRE_EXAM }, data: { status: 'RETIRED' } }); // only FINAL counts towards completion
    const c = (await http.get('/v1/me/completion').set(as('s1')).expect(200)).body; expect(c.topics.complete).toBe(true); expect(c.labs.complete).toBe(true); expect(c.exams).toEqual([{ code: 'FINAL', passed: false }]); expect(c.programmeComplete).toBe(false); // s1 passed but result is still HELD
    await mkLearner('f1'); const s = await sit('f1'); await wh(ev(s.providerSessionId, 'report_final')).expect(201); await http.post(`/v1/exam-ops/attempts/${s.attemptId}/release`).set(as('assess2')).expect(201);
    const done = (await http.get('/v1/me/completion').set(as('f1')).expect(200)).body; expect(done).toMatchObject({ programmeComplete: true }); expect(done.exams).toEqual([{ code: 'FINAL', passed: true }]);
  });
  it('the audit chain stays intact across every privileged exam and lab action', async () => {
    expect((await http.get('/v1/audit/verify').set(as('auditor')).expect(200)).body.intact).toBe(true);
    const a = (await prisma.auditEvent.findMany()).map((e) => e.action);
    expect(a).toEqual(expect.arrayContaining(['exam.bank_questions_added', 'exam.defined', 'exam.published', 'exam.session_created', 'exam.eligibility_override', 'exam.accommodation_granted', 'exam.result_released', 'exam.outcome_set', 'exam.appealed', 'exam.appeal_decided', 'incident.decided', 'incident.evidence_accessed', 'incident.recorded', 'lab.slot_created', 'lab.slot_cancelled', 'lab.activity_set', 'integrity.case_resolved']));
  });
});
