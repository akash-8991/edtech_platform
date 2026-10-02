import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { generateKeyPairSync, privateDecrypt, constants, randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'media-'));
process.env.OFFLINE_MASTER_KEY = 'ab'.repeat(32);
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { decryptBuffer } from '../src/domain/media-crypto';

const prisma = new PrismaClient();
let app: INestApplication; let http: any;
const tok: Record<string, string> = {}; const uid: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
async function mkUser(key: string, role: string) {
  const u = await prisma.user.create({ data: { email: `${key}@x.test`, name: key, passwordHash: hashPassword('pw'), roles: { create: { role: role as any } } } });
  uid[key] = u.id; tok[key] = (await http.post('/v1/auth/login').send({ email: `${key}@x.test`, password: 'pw' })).body.accessToken;
}
const MP4 = Buffer.from('FAKE-MP4-BYTES-0123456789'.repeat(40)); // 1000 bytes
const hb = (topicId: string, assetId: string, from: number, to: number, extra: any = {}) =>
  ({ eventId: randomUUID(), topicId, type: 'VIDEO_HEARTBEAT', occurredAt: new Date().toISOString(), payload: { assetId, from, to }, ...extra });

let T1: string, T2: string, V: string, A1: string, ent: string;

beforeAll(async () => {
  const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  for (const [k, r] of [['author', 'CONTENT_AUTHOR'], ['faculty', 'FACULTY_REVIEWER'], ['approver', 'APPROVER_PUBLISHER'], ['admin', 'ACADEMIC_ADMIN'], ['learner', 'LEARNER'], ['other', 'LEARNER']] as const) await mkUser(k, r);

  // --- authored + published two-topic course (the real approval path) ---
  await http.post('/v1/authoring/programmes').set(as('author')).send({ code: 'P2', title: 'Phase2', discipline: 'AI' }).expect(201);
  const v = await http.post('/v1/authoring/programmes/P2/versions').set(as('author')).send({ hours: 2, languages: ['en'],
    modules: [{ title: 'M1', topics: [{ title: 'Topic 1', hours: 1 }, { title: 'Topic 2', hours: 1 }] }] }).expect(201);
  V = v.body.id; [T1, T2] = v.body.modules[0].topics.map((t: any) => t.id).sort((a: string, b: string) => 0) as string[];
  const topics = await prisma.topic.findMany({ where: { module: { versionId: V } }, orderBy: { position: 'asc' } }); [T1, T2] = topics.map((t) => t.id);
  for (const t of [T1, T2]) {
    const a = await http.post(`/v1/authoring/topics/${t}/assets`).set(as('author')).send({ language: 'en', durationSec: 100, provenance: { model: 'm', source: 'video_engine' },
      interactions: [{ id: 'ix1', atSec: 30, kind: 'pause_quiz', required: true, prompt: 'q?', correct: 1 }] }).expect(201);
    if (t === T1) A1 = a.body.id;
    for (const l of ['master', '360p', 'audio', 'transcript']) await http.put(`/v1/authoring/assets/${a.body.id}/files/${l}`).set(as('author')).set('content-type', 'application/octet-stream').send(MP4).expect(200);
    await http.put(`/v1/authoring/topics/${t}/quiz`).set(as('author')).send({ passPercent: 60, maxAttempts: 2, questions: [
      { type: 'MCQ_SINGLE', text: 'q1', options: ['a', 'b'], answer: 1, points: 1, rationale: 'because b' }, { type: 'NUMERIC', text: 'q2', answer: 4, tolerance: 0.1, points: 1 }] }).expect(200);
    await http.put(`/v1/authoring/topics/${t}/assignment`).set(as('author')).send({ instructions: 'do it', maxSubmissions: 2 }).expect(200);
  }
  for (const [u, to] of [['author', 'FACULTY_REVIEW'], ['faculty', 'FACULTY_APPROVED'], ['faculty', 'ADMIN_APPROVAL'], ['approver', 'PUBLISHED']] as const)
    await http.post(`/v1/authoring/versions/${V}/transition`).set(as(u)).send({ to }).expect(201);
  const e = await prisma.entitlement.create({ data: { learnerId: uid.learner, versionId: V, duration: 'M12', cohort: 'C1', startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() + 300 * 86400000), approvedById: uid.admin } });
  ent = e.id;
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('authoring readiness', () => {
  it('a mandatory topic without video/quiz/assignment cannot enter review', async () => {
    const v = await http.post('/v1/authoring/programmes/P2/versions').set(as('author')).send({ hours: 1, modules: [{ title: 'M', topics: [{ title: 'Bare', hours: 1 }] }] }).expect(201);
    const r = await http.post(`/v1/authoring/versions/${v.body.id}/transition`).set(as('author')).send({ to: 'FACULTY_REVIEW' }).expect(400);
    expect(r.body.issues.join()).toMatch(/no en video/); expect(r.body.issues.join()).toMatch(/quiz missing/);
  });
  it('published components are frozen', async () => {
    await http.put(`/v1/authoring/topics/${T1}/assignment`).set(as('author')).send({ instructions: 'x' }).expect(409);
  });
});

describe('gating + learning loop', () => {
  it('topic 2 is locked; learner cannot skip ahead via any endpoint', async () => {
    await http.get(`/v1/topics/${T2}`).set(as('learner')).expect(403);
    await http.get(`/v1/topics/${T2}/playback`).set(as('learner')).expect(403);
    await http.post(`/v1/topics/${T2}/quiz/start`).set(as('learner')).expect(403);
    await http.get(`/v1/topics/${T1}`).set(as('other')).expect(403); // no entitlement
  });

  it('quiz is blocked until the video is genuinely watched and interactions answered', async () => {
    await http.post(`/v1/topics/${T1}/quiz/start`).set(as('learner')).expect(409);
    // seek-to-end cheat: one heartbeat claiming the whole video is rejected
    const cheat = await http.post('/v1/learning-events').set(as('learner')).send({ events: [hb(T1, A1, 0, 100)] }).expect(201);
    expect(cheat.body.results[0]).toMatchObject({ status: 'rejected', reason: 'implausible_range' });
    // watch everything in 20s chunks, but skip the required interaction
    const evs = [0, 20, 40, 60, 80].map((s) => hb(T1, A1, s, s + 20));
    const r = await http.post('/v1/learning-events').set(as('learner')).send({ events: evs }).expect(201);
    expect(r.body.results.every((x: any) => x.status === 'accepted')).toBe(true);
    await http.post(`/v1/topics/${T1}/quiz/start`).set(as('learner')).expect(409); // passive playback is not mastery
    // idempotent replay (offline resync storm): same eventIds -> duplicates, no double counting
    const again = await http.post('/v1/learning-events').set(as('learner')).send({ events: evs }).expect(201);
    expect(again.body.results.every((x: any) => x.status === 'duplicate')).toBe(true);
    const ir = { eventId: randomUUID(), topicId: T1, type: 'INTERACTION_RESPONSE', occurredAt: new Date().toISOString(), payload: { assetId: A1, interactionId: 'ix1', response: 1 } };
    expect((await http.post('/v1/learning-events').set(as('learner')).send({ events: [ir] })).body.results[0].status).toBe('accepted');
    expect((await http.get(`/v1/me/entitlements/${ent}/progress`).set(as('learner'))).body.topics[0].videoDone).toBe(true);
  });

  let attemptId: string;
  it('quiz: no answer keys leak; failing consumes attempts; rationale only after pass', async () => {
    const s = await http.post(`/v1/topics/${T1}/quiz/start`).set(as('learner')).expect(201);
    expect(JSON.stringify(s.body)).not.toMatch(/"answer"|rationale|because b/);
    attemptId = s.body.attemptId;
    const qids = s.body.questions.map((q: any) => q.id);
    const bad = await http.post(`/v1/quiz-attempts/${attemptId}/submit`).set(as('learner')).send({ answers: { [qids[0]]: 0, [qids[1]]: 9 } }).expect(201);
    expect(bad.body).toMatchObject({ passed: false, attemptsRemaining: 1 }); expect(JSON.stringify(bad.body)).not.toMatch(/because b/);
    await http.post(`/v1/quiz-attempts/${attemptId}/submit`).set(as('learner')).send({ answers: {} }).expect(409); // no resubmit of same attempt
    await http.post(`/v1/quiz-attempts/${attemptId}/submit`).set(as('other')).send({ answers: {} }).expect(404);
    await http.post(`/v1/topics/${T1}/assignment/submit`).set(as('learner')).send({ text: 'x' }).expect(409); // quiz not passed
    const s2 = await http.post(`/v1/topics/${T1}/quiz/start`).set(as('learner')).expect(201);
    const good = await http.post(`/v1/quiz-attempts/${s2.body.attemptId}/submit`).set(as('learner')).send({ answers: { [qids[0]]: 1, [qids[1]]: 4.05 } }).expect(201);
    expect(good.body.passed).toBe(true); expect(JSON.stringify(good.body)).toMatch(/because b/);
    await http.post(`/v1/topics/${T1}/quiz/start`).set(as('learner')).expect(409); // already passed
  });

  it('assignment: uploads are owner-scoped; submission completes topic and unlocks the next + notifies', async () => {
    await http.get(`/v1/topics/${T2}`).set(as('learner')).expect(403); // still locked: assignment missing
    await http.put(`/v1/topics/${T1}/assignment/upload?name=evil.exe`).set(as('learner')).send(Buffer.from('x')).expect(400);
    const up = await http.put(`/v1/topics/${T1}/assignment/upload?name=notes.pdf`).set(as('learner')).set('content-type', 'application/octet-stream').send(Buffer.from('%PDF-1.4 hi')).expect(200);
    await http.post(`/v1/topics/${T1}/assignment/submit`).set(as('learner')).send({ files: [{ key: 'submissions/someone-else/x.pdf' }] }).expect(403);
    await http.post(`/v1/topics/${T1}/assignment/submit`).set(as('learner')).send({}).expect(400);
    await http.post(`/v1/topics/${T1}/assignment/submit`).set(as('learner')).send({ text: 'my work', files: [up.body] }).expect(201);
    await http.get(`/v1/topics/${T2}`).set(as('learner')).expect(200); // unlocked
    const types = (await http.get('/v1/me/notifications').set(as('learner'))).body.map((n: any) => n.type);
    expect(types).toEqual(expect.arrayContaining(['topic.completed', 'topic.unlocked']));
    await expect(prisma.$executeRawUnsafe(`UPDATE "Submission" SET "attemptNo"=9`)).rejects.toThrow(/append-only/);
  });

  it('admin override: extra quiz attempts and forced unlock are audited', async () => {
    await http.post(`/v1/entitlements/${ent}/progression-overrides`).set(as('learner')).send({ topicId: T2, type: 'UNLOCK_TOPIC', reason: 'x' }).expect(403);
    await http.post(`/v1/entitlements/${ent}/progression-overrides`).set(as('admin')).send({ topicId: T2, type: 'EXTRA_QUIZ_ATTEMPTS', value: 2 }).expect(400); // reason required
    await http.post(`/v1/entitlements/${ent}/progression-overrides`).set(as('admin')).send({ topicId: T2, type: 'EXTRA_QUIZ_ATTEMPTS', value: 2, reason: 'medical' }).expect(201);
    const log = await prisma.auditEvent.findMany({ where: { action: 'progression.override.extra_quiz_attempts' } });
    expect(log).toHaveLength(1); expect(log[0].reason).toBe('medical');
  });
});

describe('media delivery', () => {
  it('normal vs low-bandwidth manifests; interaction keys stripped; Range supported', async () => {
    const n = (await http.get(`/v1/topics/${T1}/playback`).set(as('learner')).expect(200)).body;
    expect(n.streams[0].label).toBe('360p'); expect(n.durationSec).toBe(100);
    expect(JSON.stringify(n.interactions)).not.toMatch(/correct/);
    const low = (await http.get(`/v1/topics/${T1}/playback?mode=low`).set(as('learner')).expect(200)).body;
    expect(low.streams.map((s: any) => s.label).slice(0, 2)).toEqual(['audio', 'transcript']);
    const full = await http.get(n.streams[0].url).expect(200); expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await http.get(n.streams[0].url).set('Range', 'bytes=10-19').expect(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/1000'); expect(part.body.length ?? part.text.length).toBe(10);
    await http.get(n.streams[0].url + 'x').expect(401);
    await http.get(n.streams[0].url).set('Range', 'bytes=5000-').expect(416);
  });
});

describe('offline licences', () => {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  let licenseId: string;
  it('device-bound download: only the registered device key can decrypt', async () => {
    await http.post('/v1/offline/devices').set(as('learner')).send({ deviceId: 'phone', publicKeyPem: 'junk' }).expect(400);
    await http.post('/v1/offline/devices').set(as('learner')).send({ deviceId: 'phone', publicKeyPem: pem }).expect(201);
    await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'phone', topicId: T2 }).expect(201); // T2 unlocked now
    const l = (await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'phone', topicId: T1 }).expect(201)).body;
    licenseId = l.licenseId;
    expect(new Date(l.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86400000 + 5000);
    const enc = (await http.get(l.downloadUrl).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); })).body as Buffer;
    expect(enc.equals(MP4)).toBe(false);
    const key = privateDecrypt({ key: kp.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(l.wrappedKey, 'base64'));
    expect(decryptBuffer(enc, key, Buffer.from(l.iv, 'base64'), Buffer.from(l.tag, 'base64')).equals(MP4)).toBe(true);
    await http.post('/v1/offline/licenses').set(as('other')).send({ deviceId: 'phone', topicId: T1 }).expect(403); // not their device
  });
  it('licence validity follows entitlement: pause, then revoke, kills offline access', async () => {
    const valid = async () => (await http.get('/v1/offline/licenses?deviceId=phone').set(as('learner'))).body.find((x: any) => x.licenseId === licenseId).valid;
    expect(await valid()).toBe(true);
    await http.post(`/v1/entitlements/${ent}/pause`).set(as('learner')).send({}).expect(201);
    expect(await valid()).toBe(false);
    await http.post(`/v1/entitlements/${ent}/resume`).set(as('learner')).expect(201);
    expect(await valid()).toBe(true);
    await http.post('/v1/offline/devices/phone/revoke').set(as('learner')).expect(201);
    expect(await valid()).toBe(false);
    await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'phone', topicId: T1 }).expect(403);
  });
  it('offline-recorded events sync after the fact and dedupe by eventId', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const e = { ...hb(T2, (await prisma.contentAsset.findFirstOrThrow({ where: { topicId: T2 } })).id, 0, 20), occurredAt: past, deviceId: 'phone', seq: 1 };
    expect((await http.post('/v1/learning-events').set(as('learner')).send({ events: [e, e] })).body.results.map((r: any) => r.status)).toEqual(['accepted', 'duplicate']);
  });
});

describe('reports', () => {
  it('cohort progress report is role-gated; CSV export is audited', async () => {
    await http.get(`/v1/reports/progress?versionId=${V}`).set(as('learner')).expect(403);
    const r = (await http.get(`/v1/reports/progress?versionId=${V}&cohort=C1`).set(as('admin')).expect(200)).body;
    expect(r.summary.learners).toBe(1); expect(r.rows[0]).toMatchObject({ completedTopics: 1, totalTopics: 2, percent: 50, atRisk: false });
    const csv = await http.get(`/v1/reports/progress?versionId=${V}&format=csv`).set(as('admin')).expect(200);
    expect(csv.text.split('\n')[0]).toContain('learner,email'); expect(csv.text).toContain('learner@x.test');
    expect(await prisma.auditEvent.count({ where: { action: 'report.exported' } })).toBe(1);
  });
});

describe('expiry', () => {
  it('expired entitlement loses all learning access server-side', async () => {
    await prisma.entitlement.update({ where: { id: ent }, data: { endAt: new Date(Date.now() - 1000) } });
    await http.get(`/v1/topics/${T1}`).set(as('learner')).expect(403);
    await http.get(`/v1/topics/${T1}/playback`).set(as('learner')).expect(403);
  });
});
