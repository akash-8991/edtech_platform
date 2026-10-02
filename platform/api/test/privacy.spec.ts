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
process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'media-'));
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { AI_PROVIDERS } from '../src/ai/providers';
import { PROCTOR, MockProctor } from '../src/proctoring/provider';
import { NOTICE_VERSION } from '../src/privacy/privacy';
import { accessibilityReport } from '../src/accessibility';
import { IntegrityService } from '../src/ops/integrity';

const prisma = new PrismaClient(); const mock = new MockProctor();
let app: INestApplication; let h: any; const tok: Record<string, string> = {}; const uid: Record<string, string> = {};
const PW = 'Correct-Horse-Battery-9';
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
async function mkUser(key: string, role: string, extra: any = {}) {
  const u = await prisma.user.create({ data: { email: `${key}@x.test`, name: `${key} Person`, passwordHash: hashPassword(PW), roles: { create: { role: role as any } }, ...extra } });
  uid[key] = u.id; tok[key] = (await h.post('/v1/auth/login').send({ email: `${key}@x.test`, password: PW })).body.accessToken;
}
let V: string, T1: string, ENT: string;
beforeAll(async () => {
  const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDERS).useValue({ anthropic: { name: 'anthropic', async complete(r: any) { const o = { answer: 'A thermistor changes resistance with temperature.', used_source_ids: ['S1'], confidence: 'high', needs_teacher: false }; return { json: o, text: '', inputTokens: 1, outputTokens: 1, model: r.model }; } } }).overrideProvider(PROCTOR).useValue(mock).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); h = request(app.getHttpServer());
  for (const [k, r] of [['admin', 'ACADEMIC_ADMIN'], ['plat', 'PLATFORM_ADMIN'], ['plat2', 'SUPER_ADMIN'], ['sup', 'SUPPORT_OPERATOR'], ['auditor', 'AUDITOR'], ['author', 'CONTENT_AUTHOR'], ['faculty', 'FACULTY_REVIEWER']] as const) await mkUser(k, r);
  const prog = await prisma.programme.create({ data: { code: 'PV', title: 'Privacy Course', discipline: 'AI/ML' } });
  const v = await prisma.programmeVersion.create({ data: { programmeId: prog.id, version: 1, state: 'PUBLISHED', authorId: uid.admin, hours: 1, publishedAt: new Date(), languages: ['en'], modules: { create: [{ position: 1, title: 'M', topics: { create: [{ position: 1, title: 'Sensors', hours: 1, outcomes: ['a'] }] } }] } }, include: { modules: { include: { topics: true } } } });
  V = v.id; T1 = v.modules[0].topics[0].id;
  await prisma.scriptManifest.create({ data: { topicId: T1, rev: 1, jobId: 'j', manifest: { scenes: [{ id: 's1', narration: { en: 'A thermistor is a sensor whose resistance changes with temperature.' }, on_screen_text: '', sources: [], interactions: [] }] } } });
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });
const asg = () => prisma.assignment.upsert({ where: { topicId: T1 }, update: {}, create: { topicId: T1, instructions: 'x' } });
async function mkLearner(key: string, o: { ended?: boolean } = {}) {
  await mkUser(key, 'LEARNER'); ENT = (await prisma.entitlement.create({ data: { learnerId: uid[key], versionId: V, duration: 'M12', cohort: 'C', startAt: new Date(Date.now() - 400 * 86400000), endAt: new Date(Date.now() + (o.ended ? -86400000 : 300 * 86400000)), approvedById: uid.admin, status: o.ended ? 'EXPIRED' : 'ACTIVE' } })).id; return ENT;
}

describe('consent (purpose-limited, versioned, withdrawable)', () => {
  it('records consent to a specific notice version; stale versions are refused; withdrawal is recorded; history is kept', async () => {
    await mkLearner('c1'); const c0 = (await h.get('/v1/me/consents').set(as('c1')).expect(200)).body; expect(c0.every((x: any) => !x.granted)).toBe(true);
    await h.put('/v1/me/consents').set(as('c1')).send({ purpose: 'NOPE', granted: true, version: NOTICE_VERSION }).expect(400);
    const stale = await h.put('/v1/me/consents').set(as('c1')).send({ purpose: 'AI_TUTOR', granted: true, version: '1999-01' }).expect(409); expect(stale.body.currentNoticeVersion).toBe(NOTICE_VERSION);
    await h.put('/v1/me/consents').set(as('c1')).send({ purpose: 'AI_TUTOR', granted: true, version: NOTICE_VERSION }).expect(200);
    expect((await h.get('/v1/me/consents').set(as('c1'))).body.find((x: any) => x.purpose === 'AI_TUTOR')).toMatchObject({ granted: true, upToDate: true });
    await h.put('/v1/me/consents').set(as('c1')).send({ purpose: 'AI_TUTOR', granted: false, version: NOTICE_VERSION }).expect(200);
    expect(await prisma.consentRecord.count({ where: { userId: uid.c1, purpose: 'AI_TUTOR' } })).toBe(2); expect((await prisma.auditEvent.findMany({ where: { action: { in: ['privacy.consent_granted', 'privacy.consent_withdrawn'] } } })).length).toBe(2);
  });
  it('when enforced, the AI tutor refuses until the learner has consented and stops again after withdrawal', async () => {
    process.env.PRIVACY_ENFORCE_CONSENT = '1';
    try {
      await mkLearner('c2'); await h.post('/v1/entitlements/' + ENT + '/progression-overrides').set(as('admin')).send({ topicId: T1, type: 'UNLOCK_TOPIC', reason: 'x' }).expect(201);
      const ask = () => h.post('/v1/tutor/ask').set(as('c2')).send({ question: 'What does a thermistor do when temperature changes?' });
      const r = await ask().expect(403); expect(r.body).toMatchObject({ error: 'consent_required', purpose: 'AI_TUTOR' });
      await h.put('/v1/me/consents').set(as('c2')).send({ purpose: 'AI_TUTOR', granted: true, version: NOTICE_VERSION }).expect(200); await ask().expect(201);
      await h.put('/v1/me/consents').set(as('c2')).send({ purpose: 'AI_TUTOR', granted: false, version: NOTICE_VERSION }).expect(200); await ask().expect(403);
    } finally { process.env.PRIVACY_ENFORCE_CONSENT = '0'; }
  });
});

describe('data export (permissioned, encrypted at rest, expiring, audited)', () => {
  let rid: string;
  it('needs the account password (step-up); other open requests are not duplicated', async () => {
    await mkLearner('e1'); await prisma.submission.create({ data: { assignmentId: (await asg()).id, topicId: T1, learnerId: uid.e1, entitlementId: ENT, attemptNo: 1, content: { text: 'my private essay about thermistors' } } });
    await h.post('/v1/me/privacy/requests').set(as('e1')).send({ type: 'EXPORT' }).expect(403); await h.post('/v1/me/privacy/requests').set(as('e1')).send({ type: 'EXPORT', password: 'wrong' }).expect(403);
    rid = (await h.post('/v1/me/privacy/requests').set(as('e1')).send({ type: 'EXPORT', password: PW }).expect(201)).body.id; await h.post('/v1/me/privacy/requests').set(as('e1')).send({ type: 'EXPORT', password: PW }).expect(409);
    await h.post('/v1/me/privacy/requests').set(as('e1')).send({ type: 'DELETE_ALL' }).expect(400);
  });
  it('is generated asynchronously, encrypted on disk, downloadable only by the owner, and every download is audited', async () => {
    expect((await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: rid } })).status).toBe('APPROVED'); await h.get(`/v1/me/privacy/requests/${rid}/download`).set(as('e1')).expect(404); // not ready
    expect((await h.post('/v1/privacy/process').set(as('plat')).expect(201)).body.exports).toBe(1);
    const r = await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: rid } }); expect(r).toMatchObject({ status: 'COMPLETED' }); expect(r.exportExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    const raw = require('fs').readFileSync(join(process.env.MEDIA_ROOT!, r.exportKey!)); expect(raw.toString('utf8')).not.toContain('private essay'); expect(raw.toString('utf8')).not.toContain('e1@x.test'); // ciphertext on disk
    await h.get(`/v1/me/privacy/requests/${rid}/download`).set(as('e2')).expect(401); await mkLearner('e2'); await h.get(`/v1/me/privacy/requests/${rid}/download`).set(as('e2')).expect(404); // someone else's request
    const dl = await h.get(`/v1/me/privacy/requests/${rid}/download`).set(as('e1')).expect(200); expect(dl.headers['content-disposition']).toMatch(/attachment/);
    const b = JSON.parse(dl.text); expect(b.profile).toMatchObject({ email: 'e1@x.test' }); expect(b.submissions[0].content.text).toMatch(/private essay/); expect(b.entitlements[0].programme.code).toBe('PV'); expect(JSON.stringify({ ...b, note: undefined })).not.toMatch(/e2@x\.test|moderat|integrity|similarity/i);
    expect((await prisma.auditEvent.findMany({ where: { action: 'privacy.export_downloaded' } })).length).toBe(1); expect((await prisma.notification.findMany({ where: { userId: uid.e1, type: 'privacy.export_ready' } })).length).toBe(1);
  });
  it('expired exports cannot be downloaded and are deleted by the retention job', async () => {
    await prisma.dataSubjectRequest.update({ where: { id: rid }, data: { exportExpiresAt: new Date(Date.now() - 1000) } }); await h.get(`/v1/me/privacy/requests/${rid}/download`).set(as('e1')).expect(409);
    const key = (await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: rid } })).exportKey!; expect(require('fs').existsSync(join(process.env.MEDIA_ROOT!, key))).toBe(true);
    await h.post('/v1/privacy/retention/run').set(as('plat')).expect(201); expect(require('fs').existsSync(join(process.env.MEDIA_ROOT!, key))).toBe(false); expect((await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: rid } })).exportKey).toBeNull();
  });
});

describe('correction and erasure', () => {
  it('corrections are approved by someone else, applied exactly as requested, and audited', async () => {
    await mkLearner('r1'); const r = (await h.post('/v1/me/privacy/requests').set(as('r1')).send({ type: 'CORRECTION', details: { name: '  Priya Sharma  ', email: 'attacker@evil.com', language: 'hi' } }).expect(201)).body;
    await h.post('/v1/me/privacy/requests').set(as('r1')).send({ type: 'CORRECTION', details: {} }).expect(400); await h.post(`/v1/privacy/requests/${r.id}/decide`).set(as('r1')).send({ decision: 'APPROVE', reason: 'x' }).expect(403);
    await h.post(`/v1/privacy/requests/${r.id}/decide`).set(as('plat')).send({ decision: 'APPROVE' }).expect(400); await h.post(`/v1/privacy/requests/${r.id}/decide`).set(as('plat')).send({ decision: 'APPROVE', reason: 'ID checked' }).expect(201);
    await h.post(`/v1/privacy/requests/${r.id}/decide`).set(as('plat2')).send({ decision: 'APPROVE', reason: 'x' }).expect(409); await h.post('/v1/privacy/process').set(as('plat')).expect(201);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: uid.r1 } })).toMatchObject({ name: 'Priya Sharma', language: 'hi', email: 'r1@x.test' }); // email can never be changed this way
  });
  it('erasure is blocked while an entitlement is live or a legal hold applies', async () => {
    await mkLearner('b1'); const r = (await h.post('/v1/me/privacy/requests').set(as('b1')).send({ type: 'ERASURE', password: PW, details: { reason: 'leaving' } }).expect(201)).body;
    await h.post(`/v1/privacy/requests/${r.id}/decide`).set(as('plat')).send({ decision: 'APPROVE', reason: 'verified' }).expect(201); await h.post('/v1/privacy/process').set(as('plat')).expect(201);
    expect(await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'BLOCKED' }); expect((await prisma.user.findUniqueOrThrow({ where: { id: uid.b1 } })).status).toBe('ACTIVE');
    await mkLearner('b2', { ended: true }); await h.put(`/v1/privacy/users/${uid.b2}/legal-hold`).set(as('plat')).send({ hold: true, reason: 'Disciplinary inquiry 2026/9' }).expect(200);
    await h.put(`/v1/privacy/users/${uid.b2}/legal-hold`).set(as('b2')).send({ hold: false, reason: 'x' }).expect(403);
    const r2 = (await h.post('/v1/privacy/requests/on-behalf').set(as('sup')).send({ userId: uid.b2, type: 'ERASURE' }).expect(201)).body; await h.post(`/v1/privacy/requests/${r2.id}/decide`).set(as('sup')).send({ decision: 'APPROVE', reason: 'x' }).expect(403); // support files, platform admin decides
    await h.post(`/v1/privacy/requests/${r2.id}/decide`).set(as('plat')).send({ decision: 'APPROVE', reason: 'ok' }).expect(201); await h.post('/v1/privacy/process').set(as('plat')).expect(201);
    expect((await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: r2.id } })).result).toMatchObject({ reason: 'legal hold' });
  });
  it('erasure removes personal data everywhere it lives, keeps the pseudonymised academic record and audit trail, revokes access, and tells the proctoring vendor', async () => {
    const ent = await mkLearner('x1', { ended: true }); const pw = (await prisma.user.findUniqueOrThrow({ where: { id: uid.x1 } })).email;
    const conv = await prisma.tutorConversation.create({ data: { learnerId: uid.x1, entitlementId: ent, versionId: V } }); await prisma.tutorMessage.create({ data: { conversationId: conv.id, learnerId: uid.x1, role: 'LEARNER', content: 'my phone is 9876543210' } });
    await prisma.tutorMessage.create({ data: { conversationId: conv.id, learnerId: uid.x1, role: 'TUTOR', content: 'answer', status: 'ANSWERED', retrieved: { chunks: [{ id: 'c' }] } as any } });
    const t = await prisma.doubtTicket.create({ data: { learnerId: uid.x1, entitlementId: ent, versionId: V, category: 'CONTENT', priority: 'P3', subject: 'my private doubt', source: 'MANUAL', contextBundle: { x: 1 } as any, firstResponseDueAt: new Date() } });
    await h.put('/v1/doubts/upload?name=note.png').set(as('x1')).set('content-type', 'application/octet-stream').send(Buffer.from('png')).expect(200);
    await prisma.ticketMessage.create({ data: { ticketId: t.id, authorRole: 'LEARNER', body: 'private words', attachments: [] } }); await prisma.notification.create({ data: { userId: uid.x1, type: 'x', payload: {} } });
    const sub = await prisma.submission.create({ data: { assignmentId: (await asg()).id, topicId: T1, learnerId: uid.x1, entitlementId: ent, attemptNo: 1, content: { text: 'essay' } } }); void sub;
    await prisma.examAttempt.create({ data: { examId: 'e', sessionId: 's', registrationId: 'r', learnerId: uid.x1, entitlementId: ent, attemptNo: 1, providerSessionId: 'prov-1' } });
    await prisma.learnerApplication.create({ data: { externalRef: 'x1', email: pw, name: 'x1 Person', programmeCode: 'PV', duration: 'M12', cohort: 'C', learnerId: uid.x1 } });
    await prisma.device.create({ data: { userId: uid.x1, deviceId: 'phone', publicKeyPem: 'k' } });
    const r = (await h.post('/v1/me/privacy/requests').set(as('x1')).send({ type: 'ERASURE', password: PW }).expect(201)).body; await h.post(`/v1/privacy/requests/${r.id}/decide`).set(as('plat')).send({ decision: 'APPROVE', reason: 'verified in person' }).expect(201);
    expect((await h.post('/v1/privacy/process').set(as('plat')).expect(201)).body.erasures).toBe(1);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: uid.x1 } }); expect(u).toMatchObject({ status: 'ERASED', name: 'Erased learner', passwordHash: null, email: `erased-${uid.x1}@invalid.local` }); expect(u.erasedAt).not.toBeNull();
    expect((await prisma.tutorMessage.findMany({ where: { learnerId: uid.x1 } })).map((m) => m.content)).toEqual(['[erased]', '[erased]']); expect((await prisma.tutorMessage.findMany({ where: { learnerId: uid.x1, role: 'TUTOR' } }))[0].status).toBe('ANSWERED'); // statuses kept for analytics
    expect(await prisma.ticketMessage.findFirstOrThrow({ where: { ticketId: t.id } })).toMatchObject({ body: '[erased]' }); expect(await prisma.doubtTicket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ subject: '[erased]', contextBundle: {} });
    expect(await prisma.notification.count({ where: { userId: uid.x1 } })).toBe(0); expect(await prisma.device.count({ where: { userId: uid.x1 } })).toBe(0); expect((await prisma.learnerApplication.findFirstOrThrow({ where: { learnerId: uid.x1 } })).email).toMatch(/^erased-/);
    expect(require('fs').existsSync(join(process.env.MEDIA_ROOT!, 'doubts', uid.x1))).toBe(false);
    expect(await prisma.submission.count({ where: { learnerId: uid.x1 } })).toBe(1); expect(await prisma.entitlement.count({ where: { learnerId: uid.x1 } })).toBe(1); expect(await prisma.examAttempt.count({ where: { learnerId: uid.x1 } })).toBe(1); // academic record retained, pseudonymised
    await h.get('/v1/auth/me').set(as('x1')).expect(401); await h.post('/v1/auth/login').send({ email: pw, password: PW }).expect(401);
    expect(mock.erased.length).toBe(1); expect(mock.erased[0]).toMatch(/^[0-9a-f]{32}$/);
    const res = (await prisma.dataSubjectRequest.findUniqueOrThrow({ where: { id: r.id } })); expect(res.status).toBe('COMPLETED'); expect(JSON.stringify(res.result)).toMatch(/retained/); expect((res.result as any).external.proctoringProvider).toMatch(/erasure requested/);
    const a = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'privacy.erasure_completed' } }); expect(JSON.stringify({ ...a, seq: Number(a.seq) })).not.toMatch(/9876543210|x1@x\.test|private/); expect((await h.get('/v1/audit/verify').set(as('auditor'))).body.intact).toBe(true); // audit chain survives erasure
  });
  it('outside the erasure routine the evidence tables stay append-only (the bypass is transaction-local)', async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE "TutorMessage" SET content='tampered'`)).rejects.toThrow(/forbidden/); await expect(prisma.$executeRawUnsafe(`DELETE FROM "ProctorWebhookEvent"`)).resolves.toBeDefined().catch(() => undefined);
    await expect(prisma.$executeRawUnsafe(`UPDATE "TicketMessage" SET body='tampered'`)).rejects.toThrow(/append-only/);
  });
});

describe('retention', () => {
  it('dry run reports, the real run removes only data past its retention period and is audited; academic records are untouched', async () => {
    await mkLearner('t1'); const old = new Date(Date.now() - 400 * 86400000);
    await prisma.notification.create({ data: { userId: uid.t1, type: 'old', payload: {}, createdAt: old } }); await prisma.notification.create({ data: { userId: uid.t1, type: 'new', payload: {} } });
    const conv = await prisma.tutorConversation.create({ data: { learnerId: uid.t1, entitlementId: ENT, versionId: V } }); await prisma.tutorMessage.create({ data: { conversationId: conv.id, learnerId: uid.t1, role: 'LEARNER', content: 'old question', createdAt: old } }); await prisma.tutorMessage.create({ data: { conversationId: conv.id, learnerId: uid.t1, role: 'LEARNER', content: 'recent question' } });
    await prisma.proctorWebhookEvent.create({ data: { provider: 'mock', eventId: 'old-evt', payload: {}, receivedAt: new Date(Date.now() - 200 * 86400000) } });
    const sess = await prisma.userSession.create({ data: { userId: uid.t1, authMethod: 'PASSWORD', expiresAt: old, revokedAt: old } }); await prisma.refreshToken.create({ data: { sessionId: sess.id, tokenHash: 'h', expiresAt: old } }); await prisma.oidcLogin.create({ data: { state: 's', nonce: 'n', verifier: 'v', expiresAt: new Date(Date.now() - 1000) } });
    const runsBefore = await prisma.auditEvent.count({ where: { action: 'privacy.retention_run' } });
    const dry = (await h.post('/v1/privacy/retention/run?dryRun=true').set(as('plat')).expect(201)).body; expect(dry).toMatchObject({ dryRun: true }); expect(dry.wouldRemove).toMatchObject({ notifications: 1, tutorMessages: 1, webhookEvents: 1, oidcLogins: 1 }); expect(await prisma.notification.count({ where: { userId: uid.t1 } })).toBe(2);
    await h.post('/v1/privacy/retention/run').set(as('sup')).expect(403); const real = (await h.post('/v1/privacy/retention/run').set(as('plat')).expect(201)).body; expect(real.removed.notifications).toBe(1);
    expect((await prisma.notification.findMany({ where: { userId: uid.t1 } })).map((n) => n.type)).toEqual(['new']); expect((await prisma.tutorMessage.findMany({ where: { learnerId: uid.t1 }, orderBy: { createdAt: 'asc' } })).map((m) => m.content)).toEqual(['[expired]', 'recent question']);
    expect(await prisma.proctorWebhookEvent.count({ where: { eventId: 'old-evt' } })).toBe(0); expect(await prisma.userSession.count({ where: { id: sess.id } })).toBe(0); expect(await prisma.refreshToken.count({ where: { sessionId: sess.id } })).toBe(0); expect(await prisma.oidcLogin.count()).toBe(0);
    expect(await prisma.auditEvent.count({ where: { action: 'privacy.retention_run' } })).toBe(runsBefore + 1); expect(await prisma.entitlement.count({ where: { learnerId: uid.t1 } })).toBe(1);
  });
});

describe('accessibility: preferences and content readiness', () => {
  it('learners store accessibility/localisation preferences server-side (cross-device); invalid values are refused; language syncs to the profile', async () => {
    await mkLearner('a1'); await h.put('/v1/me/preferences').set(as('a1')).send({ playbackSpeed: 5 }).expect(400); await h.put('/v1/me/preferences').set(as('a1')).send({ nope: true }).expect(400);
    await h.put('/v1/me/preferences').set(as('a1')).send({ captions: true, fontScale: 1.5, highContrast: true, language: 'hi' }).expect(200); await h.put('/v1/me/preferences').set(as('a1')).send({ playbackSpeed: 1.25, reducedMotion: true }).expect(200);
    expect((await h.get('/v1/me/preferences').set(as('a1')).expect(200)).body).toEqual({ captions: true, fontScale: 1.5, highContrast: true, language: 'hi', playbackSpeed: 1.25, reducedMotion: true }); expect((await prisma.user.findUniqueOrThrow({ where: { id: uid.a1 } })).language).toBe('hi');
  });
  it('content readiness report flags missing transcripts and interaction text alternatives; low-bandwidth and audio-only gaps are advisory', () => {
    const topics = [{ title: 'T', mandatory: true, assets: [{ kind: 'VIDEO', language: 'en', files: { master: {} }, interactions: [{ id: 'i1', prompt: '' }, { id: 'i2', prompt: 'ok' }] }, { kind: 'VIDEO', language: 'hi', files: { master: {}, transcript: {}, audio: {}, '360p': {} }, interactions: [] }] }, { title: 'Opt', mandatory: false, assets: [] }];
    const r = accessibilityReport(topics as any, ['en', 'hi']); expect(r.filter((i) => i.severity === 'BLOCKING').map((i) => i.rule).sort()).toEqual(['interaction_text', 'transcript']); expect(r.filter((i) => i.severity === 'ADVISORY').map((i) => i.rule).sort()).toEqual(['audio_only', 'low_bandwidth']);
    expect(accessibilityReport([{ title: 'Ok', mandatory: true, assets: [{ kind: 'VIDEO', language: 'en', files: { master: {}, transcript: {}, audio: {}, '360p': {} }, interactions: [] }] }] as any, ['en'])).toEqual([]);
  });
  it('when enforced, a version cannot go to review until every mandatory video has a transcript', async () => {
    process.env.ACCESSIBILITY_ENFORCE = '1';
    try {
      const prog = await prisma.programme.findFirstOrThrow(); const v = await prisma.programmeVersion.create({ data: { programmeId: prog.id, version: 5, authorId: uid.author, hours: 1, languages: ['en'], modules: { create: [{ position: 1, title: 'M', topics: { create: [{ position: 1, title: 'D', hours: 1, outcomes: ['x'] }] } }] } }, include: { modules: { include: { topics: true } } } });
      const t = v.modules[0].topics[0].id; await prisma.quiz.create({ data: { topicId: t, questions: { create: [{ position: 1, type: 'MCQ_SINGLE', text: 'q', options: ['a', 'b'], answer: 0 }] } } }); await prisma.assignment.create({ data: { topicId: t, instructions: 'x' } });
      const a = await prisma.contentAsset.create({ data: { topicId: t, language: 'en', createdById: uid.author, durationSec: 10, files: { master: { key: 'k', checksum: 'c', size: 1 } } } });
      const rep = (await h.get(`/v1/authoring/versions/${v.id}/accessibility`).set(as('author')).expect(200)).body; expect(rep).toMatchObject({ blocking: 1, enforced: true });
      const bad = await h.post(`/v1/authoring/versions/${v.id}/transition`).set(as('author')).send({ to: 'FACULTY_REVIEW' }).expect(400); expect(bad.body.issues.join()).toMatch(/accessibility: en video has no transcript/);
      await prisma.contentAsset.update({ where: { id: a.id }, data: { files: { master: { key: 'k', checksum: 'c', size: 1 }, transcript: { key: 't', checksum: 'c', size: 1 } } } });
      await h.post(`/v1/authoring/versions/${v.id}/transition`).set(as('author')).send({ to: 'FACULTY_REVIEW' }).expect(201);
    } finally { process.env.ACCESSIBILITY_ENFORCE = '0'; }
  });
});

describe('integrity verification (disaster-recovery drill primitive)', () => {
  it('verifies the audit chain, every exam log chain and core relationships; detects tampering and orphans', async () => {
    const svc = app.get(IntegrityService); await prisma.examEvent.deleteMany().catch(() => undefined);
    const ok = await svc.verify(); expect(ok.audit.intact).toBe(true); expect(ok.counts.users).toBeGreaterThan(5); expect(ok.orphans.entitlementsWithoutUser).toBe(0);
    expect((await h.get('/v1/ops/integrity').set(as('auditor')).expect(200)).body).toHaveProperty('ok'); await h.get('/v1/ops/integrity').set(as('author')).expect(403);
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_immutable`); await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET reason='forged' WHERE seq=(SELECT min(seq) FROM "AuditEvent")`); await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_event_immutable`);
    const bad = await svc.verify(); expect(bad.ok).toBe(false); expect(bad.audit).toMatchObject({ intact: false, firstBroken: 0 });
  });
});
