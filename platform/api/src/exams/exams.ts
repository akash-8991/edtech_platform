import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpException, Inject, Injectable, NotFoundException, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, Roles } from '../common/auth';
import { need } from '../common/http';
import { paged } from '../common/page';
import { AuditService } from '../audit';
import { ConfigService } from '../ai/config';
import { NotificationsService } from '../notifications';
import { ProgressionService } from '../learning';
import { hasLearningAccess } from '../domain/entitlement';
import { chainHash, GENESIS } from '../domain/audit-chain';
import { accepting, answersHash, BankItem, buildPaper, defaultRules, deadlineFor, evaluateDevice, evaluateEligibility, EligibilityRules, PaperItem, QKey, receiptCode, resultStateFor, scoreAttempt, signalIncidents, validateBlueprint, watermarkFor } from '../domain/exam';
import { LabsService, sha } from '../labs/labs';
import { learnerToken, PROCTOR, ProctorProvider } from '../proctoring/provider';

type Db = Prisma.TransactionClient | PrismaService;
const EXAM_ADMIN = ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'];
const RELEASERS = ['ASSESSMENT_ADMIN', 'ACADEMIC_ADMIN'];
const secret = () => process.env.EXAM_RECEIPT_SECRET ?? process.env.JWT_SECRET ?? 'dev-only';
export const CONSENT_TEXT = 'I consent to identity verification, device checks and monitoring (video, audio and screen as configured for this exam) while I sit it, and to my exam data being reviewed by authorised staff for integrity purposes.';
export const consentHashFor = (examCode: string) => sha(`${CONSENT_TEXT}|${examCode}`);
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const SIGNALS = ['FOCUS_LOST', 'FULLSCREEN_EXIT', 'COPY', 'PASTE'];

@Injectable()
export class ExamsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private config: ConfigService, private notes: NotificationsService, private prog: ProgressionService, private labs: LabsService, @Inject(PROCTOR) public proctor: ProctorProvider) {}

  async assertNotFrozen() { if (await this.config.get<boolean>('exam.change_freeze')) throw new HttpException({ error: 'change_freeze', message: 'Exam change freeze is active' }, 423); }

  // ---- tamper-evident per-attempt log -----------------------------------------------------------------------------------------------
  async appendEvent(tx: Db, attemptId: string, type: string, payload: object = {}) {
    await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'examlog:' + attemptId}))`;
    const last = await tx.examEvent.findFirst({ where: { attemptId }, orderBy: { seq: 'desc' } });
    const seq = (last?.seq ?? 0) + 1, at = new Date(), prevHash = last?.hash ?? GENESIS;
    const body = JSON.parse(JSON.stringify({ attemptId, seq, type, payload, at: at.toISOString() }));
    return tx.examEvent.create({ data: { attemptId, seq, type, payload: payload as any, prevHash, hash: chainHash(prevHash, body), at } });
  }

  // ---- bank (segregated from learning quizzes) ----------------------------------------------------------------------------------------
  async addQuestions(programmeId: string, qs: any[], actor: Actor) {
    await this.assertNotFrozen();
    if (!Array.isArray(qs) || !qs.length || qs.length > 200) throw new BadRequestException('1..200 questions per call');
    const prog = await this.prisma.programme.findUnique({ where: { id: programmeId } }); if (!prog) throw new NotFoundException('programme');
    const rows = qs.map((q, i) => {
      const at = `question ${i + 1}`;
      if (!['MCQ_SINGLE', 'MCQ_MULTI', 'NUMERIC'].includes(q.type) || typeof q.text !== 'string' || !q.text.trim() || typeof q.tag !== 'string' || !q.tag.trim() || q.answer === undefined) throw new BadRequestException(`${at}: type, text, tag and answer required`);
      if (q.type !== 'NUMERIC') {
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8) throw new BadRequestException(`${at}: 2..8 options`);
        const idx = q.type === 'MCQ_SINGLE' ? [q.answer] : q.answer;
        if (!Array.isArray(idx) || !idx.length || idx.some((x: any) => !Number.isInteger(x) || x < 0 || x >= q.options.length)) throw new BadRequestException(`${at}: answer index out of range`);
        if (q.type === 'MCQ_SINGLE' && Array.isArray(q.answer)) throw new BadRequestException(`${at}: single-choice answer must be one index`);
      } else if (!Number.isFinite(q.answer)) throw new BadRequestException(`${at}: numeric answer required`);
      return { programmeId, tag: q.tag.trim(), difficulty: Math.min(5, Math.max(1, q.difficulty ?? 2)), type: q.type, text: q.text, options: q.options ?? [], answer: q.answer, tolerance: q.tolerance ?? 0, points: q.points ?? 1, i18n: q.i18n ?? {}, createdById: actor.id };
    });
    return this.prisma.$transaction(async (tx) => {
      await tx.examQuestion.createMany({ data: rows });
      await this.audit.record(tx, { actor, action: 'exam.bank_questions_added', objectType: 'Programme', objectId: programmeId, after: { count: rows.length, tags: [...new Set(rows.map((r) => r.tag))] } });
      return { added: rows.length };
    });
  }
  async bankItems(programmeId: string): Promise<BankItem[]> {
    return (await this.prisma.examQuestion.findMany({ where: { programmeId, status: 'ACTIVE' }, select: { id: true, tag: true, difficulty: true, points: true, options: true, type: true } }))
      .map((q) => ({ id: q.id, tag: q.tag, difficulty: q.difficulty, points: q.points, optionCount: q.type === 'NUMERIC' ? 0 : (q.options as any[]).length }));
  }

  // ---- definitions -------------------------------------------------------------------------------------------------------------------------
  async createExam(b: any, actor: Actor) {
    await this.assertNotFrozen();
    const v = await this.prisma.programmeVersion.findUnique({ where: { id: b.versionId } });
    if (!v || v.state !== 'PUBLISHED') throw new BadRequestException('exams are defined on a published course version');
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(b.code ?? '')) throw new BadRequestException('code 2..30 chars');
    if (!Number.isInteger(b.durationMin) || b.durationMin < 10 || b.durationMin > 300) throw new BadRequestException('durationMin 10..300');
    const pass = b.passPercent ?? 50, maxA = b.maxAttempts ?? 2; if (!(pass >= 1 && pass <= 100) || !(Number.isInteger(maxA) && maxA >= 1 && maxA <= 5)) throw new BadRequestException('passPercent 1..100, maxAttempts 1..5');
    const el: EligibilityRules = { ...defaultRules(), ...(b.eligibility ?? {}) };
    if (!(el.minProgrammePercent >= 0 && el.minProgrammePercent <= 100)) throw new BadRequestException('eligibility.minProgrammePercent 0..100');
    const pr = { mode: 'REMOTE', requireId: true, requireDevice: true, device: { camera: true, microphone: true, singleScreen: true }, ...(b.proctoring ?? {}) };
    if (!['REMOTE', 'CENTRE'].includes(pr.mode)) throw new BadRequestException('proctoring.mode REMOTE|CENTRE');
    if (!Array.isArray(b.blueprint) || !b.blueprint.length) throw new BadRequestException('blueprint required');
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.examDefinition.create({ data: { versionId: b.versionId, code: b.code, title: b.title ?? b.code, durationMin: b.durationMin, passPercent: pass, maxAttempts: maxA, cooldownDays: b.cooldownDays ?? 7, eligibility: el as any, blueprint: b.blueprint, proctoring: pr, shuffle: b.shuffle ?? true, createdById: actor.id } });
      await this.audit.record(tx, { actor, action: 'exam.defined', objectType: 'ExamDefinition', objectId: e.id, after: { code: e.code, durationMin: e.durationMin, mode: pr.mode } });
      return e;
    });
  }

  async publishExam(id: string, actor: Actor) {
    await this.assertNotFrozen();
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.examDefinition.findUnique({ where: { id } });
      if (!e) throw new NotFoundException();
      if (e.status !== 'DRAFT') throw new ConflictException(`exam is ${e.status}`);
      if (e.createdById === actor.id) throw new ConflictException('segregation of duties: a different administrator must publish this exam');
      const v = await tx.programmeVersion.findUniqueOrThrow({ where: { id: e.versionId } });
      const { errors, warnings } = validateBlueprint(e.blueprint as any, await this.bankItems(v.programmeId));
      if (errors.length) throw new BadRequestException({ error: 'blueprint_not_satisfiable', issues: errors });
      const u = await tx.examDefinition.update({ where: { id }, data: { status: 'PUBLISHED', approvedById: actor.id, publishedAt: new Date() } });
      await this.audit.record(tx, { actor, action: 'exam.published', objectType: 'ExamDefinition', objectId: id, after: { warnings } });
      return { ...u, warnings };
    });
  }

  async createSession(examId: string, b: any, actor: Actor) {
    await this.assertNotFrozen();
    const e = await this.prisma.examDefinition.findUnique({ where: { id: examId } });
    if (!e || e.status !== 'PUBLISHED') throw new BadRequestException('exam must be published');
    const s = new Date(b.startsAt), en = new Date(b.endsAt);
    if (isNaN(s.getTime()) || isNaN(en.getTime()) || s.getTime() < Date.now()) throw new BadRequestException('startsAt must be in the future');
    if (en.getTime() - s.getTime() < e.durationMin * 60_000) throw new BadRequestException('the window must be at least as long as the exam duration');
    if (!['REMOTE', 'CENTRE'].includes(b.mode) || (b.mode === 'CENTRE' && !b.centre)) throw new BadRequestException('mode REMOTE|CENTRE; centre is required for CENTRE');
    if ((e.proctoring as any).mode !== b.mode) throw new BadRequestException(`this exam is configured for ${(e.proctoring as any).mode} proctoring`);
    if (!Number.isInteger(b.capacity) || b.capacity < 1 || b.capacity > 25_000) throw new BadRequestException('capacity 1..25000');
    return this.prisma.$transaction(async (tx) => {
      const x = await tx.examSession.create({ data: { examId, startsAt: s, endsAt: en, mode: b.mode, centre: b.centre, capacity: b.capacity, createdById: actor.id } });
      await this.audit.record(tx, { actor, action: 'exam.session_created', objectType: 'ExamSession', objectId: x.id, after: { examId, startsAt: s, mode: b.mode, capacity: b.capacity } });
      return x;
    });
  }

  // ---- eligibility (EXM-001) ------------------------------------------------------------------------------------------------------------
  async eligibility(learnerId: string, exam: { id: string; versionId: string; eligibility: any; maxAttempts: number; cooldownDays: number }) {
    const ent = await this.prisma.entitlement.findUnique({ where: { learnerId_versionId: { learnerId, versionId: exam.versionId } } });
    if (!ent) throw new ForbiddenException('no entitlement for this course');
    const st = await this.prog.state(this.prisma, ent); const mand = st.rows.filter((r) => r.topic.mandatory);
    const labs = await this.prisma.labActivity.findMany({ where: { versionId: exam.versionId, mandatory: true }, select: { code: true } });
    const grades = await this.prisma.submissionGrade.findMany({ where: { entitlementId: ent.id }, orderBy: { createdAt: 'desc' } });
    const latest = new Map<string, (typeof grades)[number]>(); grades.forEach((g) => { if (!latest.has(g.topicId)) latest.set(g.topicId, g); });
    const finals = [...latest.values()].filter((g) => g.finalPercent !== null);
    const attempts = await this.prisma.examAttempt.findMany({ where: { examId: exam.id, learnerId, status: { in: ['IN_PROGRESS', 'SUBMITTED'] } }, orderBy: { startedAt: 'desc' } });
    const override = await this.prisma.eligibilityOverride.findFirst({ where: { examId: exam.id, learnerId } });
    const r = evaluateEligibility({ ...defaultRules(), ...exam.eligibility }, {
      entitlementActive: hasLearningAccess(ent, new Date()), programmePercent: mand.length ? Math.round((mand.filter((x) => x.complete).length / mand.length) * 100) : 0, labsCompleted: await this.labs.completedCodes(learnerId, exam.versionId), labsMandatory: labs.map((l) => l.code),
      assignmentAverage: finals.length ? Math.round((finals.reduce((s, g) => s + g.finalPercent!, 0) / finals.length) * 10) / 10 : null, assignmentsPending: [...latest.values()].filter((g) => ['PENDING_AI', 'MODERATION_REQUIRED', 'APPEALED'].includes(g.state)).length,
      integrityConcerns: await this.prisma.submissionGrade.count({ where: { learnerId, integrityOutcome: 'CONFIRMED_CONCERN' } }), attemptsUsed: attempts.length, maxAttempts: exam.maxAttempts, lastAttemptAt: attempts[0]?.startedAt ?? null, cooldownDays: exam.cooldownDays, now: new Date() }, !!override);
    return { ...r, ent };
  }

  async register(examId: string, sessionId: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'examsess:' + sessionId}))`;
      const s = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!s || s.examId !== examId || s.status !== 'SCHEDULED') throw new NotFoundException();
      if (s.startsAt.getTime() < Date.now()) throw new ConflictException('session already started');
      const e = await tx.examDefinition.findUniqueOrThrow({ where: { id: examId } });
      const el = await this.eligibility(actor.id, e as any);
      if (!el.eligible) throw new ConflictException({ error: 'not_eligible', checks: el.checks.filter((c) => !c.ok) });
      const mine = await tx.examRegistration.findFirst({ where: { examId, learnerId: actor.id, status: 'REGISTERED', sessionId: { not: sessionId } } });
      if (mine) throw new ConflictException('you are already registered for another session of this exam: cancel it first');
      if ((await tx.examRegistration.count({ where: { sessionId, status: 'REGISTERED' } })) >= s.capacity) throw new ConflictException('session is full');
      const r = await tx.examRegistration.upsert({ where: { sessionId_learnerId: { sessionId, learnerId: actor.id } }, update: { status: 'REGISTERED' }, create: { examId, sessionId, learnerId: actor.id, entitlementId: el.ent.id } });
      await this.notes.notify(tx, actor.id, 'exam.registered', { examId, sessionId, startsAt: s.startsAt, mode: s.mode });
      return r;
    });
  }

  async unregister(sessionId: string, actor: Actor) {
    const s = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!s || s.startsAt.getTime() - Date.now() < 3_600_000) throw new ConflictException('registrations can be cancelled until 1 hour before the session');
    const r = await this.prisma.examRegistration.updateMany({ where: { sessionId, learnerId: actor.id, status: 'REGISTERED' }, data: { status: 'CANCELLED' } });
    if (!r.count) throw new NotFoundException(); return { ok: true };
  }

  // ---- check-in: consent, device, identity (EXM-003) --------------------------------------------------------------------------------------
  private async readiness(tx: Db, attemptId: string) {
    const a = await tx.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    if (a.status !== 'CHECKED_IN') return a;
    const exam = await tx.examDefinition.findUniqueOrThrow({ where: { id: a.examId } }); const pr = exam.proctoring as any;
    const ok = !!a.consentAt && (!pr.requireDevice || (a.deviceCheck as any)?.ok) && (!pr.requireId || (a.idCheck as any)?.status === 'VERIFIED');
    return ok ? tx.examAttempt.update({ where: { id: a.id }, data: { status: 'READY' } }) : a;
  }

  async checkIn(sessionId: string, actor: Actor, b: { consent: boolean; consentHash: string; device?: any }) {
    const early = await this.config.get<number>('exam.checkin_early_minutes'); const minBw = await this.config.get<number>('exam.device_min_bandwidth_kbps');
    const s = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!s || s.status !== 'SCHEDULED') throw new NotFoundException();
    const exam = await this.prisma.examDefinition.findUniqueOrThrow({ where: { id: s.examId } });
    const reg = await this.prisma.examRegistration.findFirst({ where: { sessionId, learnerId: actor.id, status: 'REGISTERED' } });
    if (!reg) throw new ForbiddenException('you are not registered for this session');
    const now = Date.now(); if (now < s.startsAt.getTime() - early * 60_000 || now > s.endsAt.getTime() - 60_000) throw new ConflictException(`check-in opens ${early} minutes before the session and closes before it ends`);
    if (b.consent !== true || b.consentHash !== consentHashFor(exam.code)) throw new BadRequestException({ error: 'consent_required', consentText: CONSENT_TEXT, consentHash: consentHashFor(exam.code) });
    const el = await this.eligibility(actor.id, exam as any); if (!el.eligible) throw new ConflictException({ error: 'not_eligible', checks: el.checks.filter((c) => !c.ok) });
    const pr = exam.proctoring as any;
    const dev = evaluateDevice(b.device ?? {}, { camera: !!pr.device?.camera, microphone: !!pr.device?.microphone, minBandwidthKbps: minBw, singleScreen: !!pr.device?.singleScreen });
    const existing = await this.prisma.examAttempt.findFirst({ where: { registrationId: reg.id, status: { in: ['CHECKED_IN', 'READY'] } } });
    const attempt = await this.prisma.$transaction(async (tx) => {
      const used = await tx.examAttempt.count({ where: { examId: exam.id, learnerId: actor.id, status: { in: ['IN_PROGRESS', 'SUBMITTED'] } } });
      const a = existing ?? await tx.examAttempt.create({ data: { examId: exam.id, sessionId, registrationId: reg.id, learnerId: actor.id, entitlementId: reg.entitlementId, attemptNo: used + 1, idCheck: { status: pr.requireId ? 'PENDING' : 'NOT_REQUIRED' } as any,
        extraTimePercent: await this.extraTime(tx, actor.id, exam.id) } });
      await tx.examAttempt.update({ where: { id: a.id }, data: { consentAt: new Date(), consentHash: b.consentHash, deviceCheck: { ...dev, report: b.device ?? {}, at: new Date().toISOString() } as any } });
      await this.appendEvent(tx, a.id, 'CHECK_IN', { consentHash: b.consentHash, device: dev, mode: s.mode });
      return this.readiness(tx, a.id);
    });
    let launchUrl: string | null = attempt.launchUrl;
    if (s.mode === 'REMOTE' && !attempt.providerSessionId) { // provider only ever sees a tokenised reference + consent
      try {
        const ps = await this.proctor.createSession({ attemptId: attempt.id, examCode: exam.code, learnerToken: learnerToken(secret(), actor.id), mode: 'REMOTE', startsAt: s.startsAt, endsAt: s.endsAt, consent: true, checks: { identity: !!pr.requireId, device: !!pr.requireDevice } });
        await this.prisma.examAttempt.update({ where: { id: attempt.id }, data: { providerSessionId: ps.providerSessionId, launchUrl: ps.launchUrl } }); launchUrl = ps.launchUrl ?? null;
      } catch (e: any) { throw new HttpException({ error: 'proctor_unavailable', message: 'Proctoring service unavailable; please retry check-in shortly' }, 503); }
    }
    const fresh = await this.prisma.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    return { attemptId: fresh.id, status: fresh.status, device: dev, idCheck: (fresh.idCheck as any)?.status, launchUrl, mode: s.mode };
  }

  private async extraTime(tx: Db, learnerId: string, examId: string) {
    const acc = await tx.examAccommodation.findMany({ where: { learnerId, active: true, OR: [{ examId }, { examId: null }] } });
    return Math.min(100, acc.reduce((s, a) => s + a.extraTimePercent, 0));
  }

  async deviceCheck(attemptId: string, actor: Actor, report: any) {
    const a = await this.prisma.examAttempt.findFirst({ where: { id: attemptId, learnerId: actor.id } });
    if (!a || a.status === 'IN_PROGRESS' || a.status === 'SUBMITTED') throw new NotFoundException();
    const exam = await this.prisma.examDefinition.findUniqueOrThrow({ where: { id: a.examId } }); const pr = exam.proctoring as any;
    const dev = evaluateDevice(report ?? {}, { camera: !!pr.device?.camera, microphone: !!pr.device?.microphone, minBandwidthKbps: await this.config.get<number>('exam.device_min_bandwidth_kbps'), singleScreen: !!pr.device?.singleScreen });
    return this.prisma.$transaction(async (tx) => { await tx.examAttempt.update({ where: { id: a.id }, data: { deviceCheck: { ...dev, report, at: new Date().toISOString() } as any } }); await this.appendEvent(tx, a.id, 'DEVICE_CHECK', dev); const r = await this.readiness(tx, a.id); return { status: r.status, device: dev }; });
  }

  async setIdentity(attemptId: string, status: 'VERIFIED' | 'FAILED', method: string, byId: string | null, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.examAttempt.findUnique({ where: { id: attemptId } });
      if (!a || !['CHECKED_IN', 'READY'].includes(a.status)) throw new ConflictException('identity can only be set before the exam starts');
      await tx.examAttempt.update({ where: { id: a.id }, data: { idCheck: { status, method, byId, at: new Date().toISOString(), note } as any } });
      await this.appendEvent(tx, a.id, 'IDENTITY', { status, method });
      if (status === 'FAILED') await tx.incident.create({ data: { attemptId: a.id, source: byId ? 'PROCTOR' : 'PROVIDER', type: 'identity_failed', severity: 'HIGH', occurredAt: new Date(), detail: { method, note } as any } });
      return this.readiness(tx, a.id);
    });
  }

  // ---- the exam itself (EXM-002) --------------------------------------------------------------------------------------------------------------
  private async questionsFor(items: PaperItem[], lang: string) {
    const qs = await this.prisma.examQuestion.findMany({ where: { id: { in: items.map((i) => i.questionId) } } });
    return items.map((it) => { const q = qs.find((x) => x.id === it.questionId)!; const t = (q.i18n as any)?.[lang]; const opts = ((t?.options ?? q.options) as string[]); 
      return { id: q.id, tag: q.tag, type: q.type, text: t?.text ?? q.text, options: q.type === 'NUMERIC' ? [] : it.optionOrder.map((o) => opts[o]), points: q.points }; });
  }

  private async mustOwn(attemptId: string, actor: Actor) {
    const a = await this.prisma.examAttempt.findFirst({ where: { id: attemptId, learnerId: actor.id } });
    if (!a) throw new NotFoundException(); return a;
  }
  private checkSession(a: { sessionTokenHash: string | null }, token?: string) {
    if (!token || !a.sessionTokenHash || tokenHash(token) !== a.sessionTokenHash) throw new HttpException({ error: 'session_invalid', message: 'This exam is open in another window or the session has expired; resume to continue here' }, 409);
  }

  async start(attemptId: string, actor: Actor) {
    const a0 = await this.mustOwn(attemptId, actor);
    const s = await this.prisma.examSession.findUniqueOrThrow({ where: { id: a0.sessionId } });
    const exam = await this.prisma.examDefinition.findUniqueOrThrow({ where: { id: a0.examId } });
    const v = await this.prisma.programmeVersion.findUniqueOrThrow({ where: { id: exam.versionId } });
    const ent = await this.prisma.entitlement.findUniqueOrThrow({ where: { id: a0.entitlementId } });
    const lang = (await this.prisma.user.findUnique({ where: { id: actor.id }, select: { language: true } }))?.language ?? 'en';
    if (a0.status === 'IN_PROGRESS') throw new ConflictException('exam already started: use resume');
    if (a0.status !== 'READY') throw new ConflictException({ error: 'not_ready', status: a0.status, consent: !!a0.consentAt, device: (a0.deviceCheck as any)?.ok ?? false, identity: (a0.idCheck as any)?.status });
    if (!hasLearningAccess(ent, new Date())) throw new ForbiddenException('entitlement not active');
    const now = new Date(); if (now < s.startsAt || now.getTime() > s.endsAt.getTime() - 60_000) throw new ConflictException('the exam window is not open');
    const bank = await this.bankItems(v.programmeId); const paper = buildPaper(exam.blueprint as any, bank, a0.id, exam.shuffle);
    if (paper.shortfalls.length) throw new HttpException({ error: 'exam_misconfigured', shortfalls: paper.shortfalls }, 503);
    const token = randomBytes(24).toString('hex'); const deadline = deadlineFor(now, exam.durationMin, a0.extraTimePercent, s.endsAt);
    const a = await this.prisma.$transaction(async (tx) => {
      const r = await tx.examAttempt.updateMany({ where: { id: a0.id, status: 'READY' }, data: { status: 'IN_PROGRESS', startedAt: now, deadlineAt: deadline, paper: paper.items as any, sessionTokenHash: tokenHash(token), watermark: watermarkFor(a0.id) } });
      if (!r.count) throw new ConflictException('exam already started');
      await tx.examQuestion.updateMany({ where: { id: { in: paper.items.map((i) => i.questionId) } }, data: { usedCount: { increment: 1 } } });
      await this.appendEvent(tx, a0.id, 'START', { deadline: deadline.toISOString(), questions: paper.items.length, extraTimePercent: a0.extraTimePercent });
      return tx.examAttempt.findUniqueOrThrow({ where: { id: a0.id } });
    });
    return { attemptId: a.id, sessionToken: token, serverTime: now.toISOString(), deadlineAt: deadline.toISOString(), watermark: a.watermark, questions: await this.questionsFor(paper.items, lang) };
  }

  /** Reconnect: same paper, saved answers, server-authoritative remaining time; rotating the token logs out any other window. */
  async resume(attemptId: string, actor: Actor, deviceId?: string) {
    const a0 = await this.mustOwn(attemptId, actor);
    if (a0.status !== 'IN_PROGRESS') throw new ConflictException(`attempt is ${a0.status}`);
    if (!accepting(a0.deadlineAt!, new Date())) throw new ConflictException('time is up');
    const lang = (await this.prisma.user.findUnique({ where: { id: actor.id }, select: { language: true } }))?.language ?? 'en';
    const token = randomBytes(24).toString('hex');
    const a = await this.prisma.$transaction(async (tx) => {
      const u = await tx.examAttempt.update({ where: { id: a0.id }, data: { sessionTokenHash: tokenHash(token), sessionSwitches: { increment: 1 } } });
      await this.appendEvent(tx, a0.id, 'RESUME', { deviceId: deviceId ?? null, switches: u.sessionSwitches });
      await this.raiseSignalIncidents(tx, u.id, u.sessionSwitches);
      return u;
    });
    const now = new Date();
    return { attemptId: a.id, sessionToken: token, serverTime: now.toISOString(), deadlineAt: a.deadlineAt, remainingMs: Math.max(0, a.deadlineAt!.getTime() - now.getTime()), watermark: a.watermark, saveSeq: a.saveSeq, answers: a.answers, questions: await this.questionsFor(a.paper as any, lang) };
  }

  async saveAnswers(attemptId: string, actor: Actor, token: string | undefined, b: { answers: Record<string, unknown>; seq: number }) {
    const a = await this.mustOwn(attemptId, actor);
    if (a.status !== 'IN_PROGRESS') throw new ConflictException(`attempt is ${a.status}`);
    this.checkSession(a, token);
    const now = new Date(); if (!accepting(a.deadlineAt!, now)) throw new ConflictException('time is up');
    if (!Number.isInteger(b.seq) || b.seq < 1 || !b.answers || typeof b.answers !== 'object') throw new BadRequestException('seq (positive integer) and answers required');
    const ids = new Set((a.paper as unknown as PaperItem[]).map((i) => i.questionId));
    if (Object.keys(b.answers).some((k) => !ids.has(k))) throw new BadRequestException('answers reference questions that are not on your paper');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ExamAttempt" WHERE id = ${a.id} FOR UPDATE`;
      const cur = await tx.examAttempt.findUniqueOrThrow({ where: { id: a.id } });
      if (b.seq <= cur.saveSeq) return { saved: false, saveSeq: cur.saveSeq, remainingMs: Math.max(0, cur.deadlineAt!.getTime() - now.getTime()), serverTime: now.toISOString() }; // stale or duplicate autosave: idempotent
      const merged = { ...(cur.answers as object), ...b.answers };
      await tx.examAttempt.update({ where: { id: a.id }, data: { answers: merged as any, saveSeq: b.seq, lastSavedAt: now } });
      await this.appendEvent(tx, a.id, 'SAVE', { seq: b.seq, answersHash: answersHash(merged), answered: Object.keys(merged).length });
      return { saved: true, saveSeq: b.seq, remainingMs: Math.max(0, cur.deadlineAt!.getTime() - now.getTime()), serverTime: now.toISOString() };
    });
  }

  async signal(attemptId: string, actor: Actor, token: string | undefined, kind: string) {
    if (!SIGNALS.includes(kind)) throw new BadRequestException(`kind must be one of ${SIGNALS.join(',')}`);
    const a = await this.mustOwn(attemptId, actor);
    if (a.status !== 'IN_PROGRESS') throw new ConflictException(`attempt is ${a.status}`);
    this.checkSession(a, token);
    return this.prisma.$transaction(async (tx) => {
      await this.appendEvent(tx, a.id, 'SIGNAL', { kind });
      const counts: any = { sessionSwitches: a.sessionSwitches };
      for (const k of SIGNALS) counts[k] = await tx.examEvent.count({ where: { attemptId: a.id, type: 'SIGNAL', payload: { path: ['kind'], equals: k } } });
      await this.raiseSignalIncidents(tx, a.id, a.sessionSwitches, counts);
      return { ok: true };
    });
  }

  /** Platform-detected signals become SYSTEM incidents for human review once thresholds are crossed (one per type/severity). */
  private async raiseSignalIncidents(tx: Prisma.TransactionClient, attemptId: string, switches: number, counts?: any) {
    const c = counts ?? { sessionSwitches: switches };
    for (const i of signalIncidents({ ...c, sessionSwitches: switches })) {
      const dup = await tx.incident.findFirst({ where: { attemptId, source: 'SYSTEM', type: i.type, severity: i.severity } });
      if (!dup) await tx.incident.create({ data: { attemptId, source: 'SYSTEM', type: i.type, severity: i.severity, occurredAt: new Date(), detail: { counts: c } as any } });
    }
  }

  async submit(attemptId: string, actor: Actor, token: string | undefined) {
    const a = await this.mustOwn(attemptId, actor);
    if (a.status === 'SUBMITTED') return this.receipt(a.id);
    if (a.status !== 'IN_PROGRESS') throw new ConflictException(`attempt is ${a.status}`);
    this.checkSession(a, token);
    if (!accepting(a.deadlineAt!, new Date())) throw new ConflictException('time is up; your saved answers were submitted automatically');
    return this.finalize(a.id, false);
  }

  /** Freeze answers, score objectively, write the immutable receipt, and decide whether the result is held. */
  async finalize(attemptId: string, auto: boolean) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ExamAttempt" WHERE id = ${attemptId} FOR UPDATE`;
      const a = await tx.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (a.status === 'SUBMITTED') return this.receiptOf(tx, attemptId);
      const exam = await tx.examDefinition.findUniqueOrThrow({ where: { id: a.examId } }); const s = await tx.examSession.findUniqueOrThrow({ where: { id: a.sessionId } });
      const items = a.paper as unknown as PaperItem[];
      const keys = new Map((await tx.examQuestion.findMany({ where: { id: { in: items.map((i) => i.questionId) } } })).map((q) => [q.id, { type: q.type, answer: q.answer, tolerance: q.tolerance, points: q.points, tag: q.tag } as QKey]));
      const sc = scoreAttempt(items, keys, a.answers as any); const hash = answersHash(a.answers); const code = receiptCode(secret(), a.id, hash); const now = new Date();
      const incidents = await tx.incident.findMany({ where: { attemptId } });
      const state = resultStateFor({ submitted: true, mode: s.mode as any, proctorFinal: a.proctorReportFinal, reportWaived: false, incidentStatuses: incidents.map((i) => i.status), outcome: a.outcome });
      await tx.examSubmission.create({ data: { attemptId, receiptCode: code, answersHash: hash, answers: a.answers as any, submittedAt: now } });
      await tx.examAttempt.update({ where: { id: attemptId }, data: { status: 'SUBMITTED', submittedAt: now, autoSubmitted: auto, score: sc as any, passed: sc.percent >= exam.passPercent, resultState: state, sessionTokenHash: null } });
      await this.appendEvent(tx, attemptId, auto ? 'AUTO_SUBMIT' : 'SUBMIT', { answersHash: hash, receipt: code });
      await this.notes.notify(tx, a.learnerId, 'exam.submitted', { attemptId, receiptCode: code });
      return { receiptCode: code, submittedAt: now, autoSubmitted: auto, answered: Object.keys(a.answers as object).length };
    });
  }
  private async receiptOf(tx: Db, attemptId: string) { const r = await tx.examSubmission.findUniqueOrThrow({ where: { attemptId } }); const a = await tx.examAttempt.findUniqueOrThrow({ where: { id: attemptId } }); return { receiptCode: r.receiptCode, submittedAt: r.submittedAt, autoSubmitted: a.autoSubmitted, answered: Object.keys(r.answers as object).length }; }
  receipt(attemptId: string) { return this.receiptOf(this.prisma, attemptId); }

  /** Time-expired attempts are submitted with whatever was autosaved (never lost, never extended). */
  async autoSubmitExpired(now = new Date()) {
    const stale = await this.prisma.examAttempt.findMany({ where: { status: 'IN_PROGRESS', deadlineAt: { lt: new Date(now.getTime() - 10_000) } }, take: 500 });
    for (const a of stale) await this.finalize(a.id, true).catch(() => undefined);
    return stale.length;
  }
}

@Controller('v1')
export class ExamsController {
  constructor(private svc: ExamsService, private prisma: PrismaService, private audit: AuditService, private config: ConfigService) {}

  // ---- exam administration --------------------------------------------------------------------------------------------------------------
  @Post('exams/bank/:programmeId/questions') @Roles(...EXAM_ADMIN) addQ(@Param('programmeId') p: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { questions: 'array' }); return this.svc.addQuestions(p, b.questions, a); }
  @Get('exams/bank/:programmeId/coverage') @Roles(...EXAM_ADMIN)
  async coverage(@Param('programmeId') p: string) { const g = await this.prisma.examQuestion.groupBy({ by: ['tag', 'difficulty'], where: { programmeId: p, status: 'ACTIVE' }, _count: true }); return g.map((x) => ({ tag: x.tag, difficulty: x.difficulty, count: x._count })); }
  @Post('exams/bank/questions/:id/retire') @Roles(...EXAM_ADMIN)
  async retireQ(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    await this.svc.assertNotFrozen(); need(b, { reason: 'string' });
    return this.prisma.$transaction(async (tx) => { const q = await tx.examQuestion.update({ where: { id }, data: { status: 'RETIRED' } }); await this.audit.record(tx, { actor: a, action: 'exam.bank_question_retired', objectType: 'ExamQuestion', objectId: id, reason: b.reason }); return { id: q.id }; });
  }
  @Post('exams') @Roles(...EXAM_ADMIN) create(@Body() b: any, @CurrentActor() a: Actor) { need(b, { versionId: 'string', code: 'string', durationMin: 'number' }); return this.svc.createExam(b, a); }
  @Post('exams/:id/publish') @Roles(...EXAM_ADMIN) publish(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.publishExam(id, a); }
  @Post('exams/:id/sessions') @Roles(...EXAM_ADMIN) session(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { startsAt: 'string', endsAt: 'string', mode: 'string', capacity: 'number' }); return this.svc.createSession(id, b, a); }
  @Get('exams/:id/sessions') @Roles(...EXAM_ADMIN, 'ACADEMIC_ADMIN', 'AUDITOR') sessions(@Param('id') id: string) { return this.prisma.examSession.findMany({ where: { examId: id }, orderBy: { startsAt: 'asc' } }); }

  @Post('exams/accommodations') @Roles(...EXAM_ADMIN)
  async accommodation(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { learnerId: 'string', type: 'string', reason: 'string' });
    if (!['EXTRA_TIME', 'BREAKS', 'ASSISTIVE'].includes(b.type) || !Number.isInteger(b.extraTimePercent ?? 0) || (b.extraTimePercent ?? 0) < 0 || (b.extraTimePercent ?? 0) > 100) throw new BadRequestException('type EXTRA_TIME|BREAKS|ASSISTIVE; extraTimePercent 0..100');
    if (!(await this.prisma.user.count({ where: { id: String(b.learnerId), roles: { some: { role: 'LEARNER' } } } }))) throw new NotFoundException('no such learner');
    if (b.examId && !(await this.prisma.examDefinition.count({ where: { id: String(b.examId) } }))) throw new NotFoundException('no such exam');
    return this.prisma.$transaction(async (tx) => { const x = await tx.examAccommodation.create({ data: { learnerId: b.learnerId, examId: b.examId ?? null, type: b.type, extraTimePercent: b.extraTimePercent ?? 0, reason: b.reason, approvedById: a.id } }); await this.audit.record(tx, { actor: a, action: 'exam.accommodation_granted', objectType: 'ExamAccommodation', objectId: x.id, after: { learnerId: b.learnerId, type: b.type, extraTimePercent: b.extraTimePercent ?? 0 }, reason: b.reason }); return x; });
  }

  // ---- read models for the staff console ------------------------------------------------------------------------------------------------
  /** Everything needed to start defining an exam: whether changes are frozen, and the published course versions an exam can be defined on. */
  @Get('exam-ops/setup') @Roles(...EXAM_ADMIN, 'ACADEMIC_ADMIN')
  async setup() {
    const versions = await this.prisma.programmeVersion.findMany({ where: { state: 'PUBLISHED' }, orderBy: [{ publishedAt: 'desc' }], include: { programme: { select: { id: true, code: true, title: true } } } });
    return { changeFrozen: !!(await this.config.get<boolean>('exam.change_freeze')), versions: versions.map((v) => ({ versionId: v.id, programmeId: v.programme.id, code: v.programme.code, title: v.programme.title, version: v.version })) };
  }
  /** One exam as defined, with whether its blueprint can be satisfied by the question bank as it stands (what publishing will check). */
  @Get('exam-ops/exams/:id') @Roles(...EXAM_ADMIN, 'ACADEMIC_ADMIN', 'AUDITOR', 'FACULTY_REVIEWER', 'PLATFORM_ADMIN')
  async examDetail(@Param('id') id: string) {
    const e = await this.prisma.examDefinition.findUnique({ where: { id } }); if (!e) throw new NotFoundException();
    const v = await this.prisma.programmeVersion.findUniqueOrThrow({ where: { id: e.versionId }, include: { programme: { select: { id: true, code: true, title: true } } } });
    const people = new Map((await this.prisma.user.findMany({ where: { id: { in: [e.createdById, ...(e.approvedById ? [e.approvedById] : [])] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const check = validateBlueprint(e.blueprint as any, await this.svc.bankItems(v.programmeId));
    return { id: e.id, code: e.code, title: e.title, status: e.status, durationMin: e.durationMin, passPercent: e.passPercent, maxAttempts: e.maxAttempts, cooldownDays: e.cooldownDays, shuffle: e.shuffle, eligibility: e.eligibility, blueprint: e.blueprint, proctoring: e.proctoring, publishedAt: e.publishedAt,
      programme: { id: v.programme.id, code: v.programme.code, title: v.programme.title, version: v.version }, createdById: e.createdById, createdByName: people.get(e.createdById) ?? null, approvedByName: e.approvedById ? people.get(e.approvedById) ?? null : null, blueprintCheck: check, changeFrozen: !!(await this.config.get<boolean>('exam.change_freeze')) };
  }
  /** The bank's questions with their answers (exam administrators only: this is the answer key). */
  @Get('exams/bank/:programmeId/questions') @Roles(...EXAM_ADMIN)
  bankList(@Param('programmeId') p: string, @Res({ passthrough: true }) res: any, @Query('tag') tag?: string, @Query('status') status?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return paged(res, limit, cursor, (a) => this.prisma.examQuestion.findMany({ where: { programmeId: p, status: status ?? 'ACTIVE', ...(tag && { tag }) }, orderBy: [{ tag: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { id: true, tag: true, difficulty: true, type: true, text: true, options: true, answer: true, tolerance: true, points: true, status: true, usedCount: true, createdAt: true }, ...a }));
  }
  @Get('exams/accommodations') @Roles(...EXAM_ADMIN)
  async accommodations(@Query('learnerId') learnerId?: string, @Query('examId') examId?: string, @Query('active') active?: string) {
    const rows = await this.prisma.examAccommodation.findMany({ where: { ...(learnerId && { learnerId }), ...(examId && { examId }), ...(active !== undefined && { active: active === 'true' }) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.learnerId, r.approvedById]))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, learnerName: names.get(r.learnerId)?.name ?? null, learnerEmail: names.get(r.learnerId)?.email ?? null, approvedByName: names.get(r.approvedById)?.name ?? null }));
  }
  @Post('exams/accommodations/:id/deactivate') @Roles(...EXAM_ADMIN)
  async deactivateAccommodation(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { reason: 'string' }); if (!b.reason.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => { const x = await tx.examAccommodation.findUnique({ where: { id } }); if (!x) throw new NotFoundException(); if (!x.active) throw new ConflictException('already withdrawn'); await tx.examAccommodation.update({ where: { id }, data: { active: false } }); await this.audit.record(tx, { actor: a, action: 'exam.accommodation_withdrawn', objectType: 'ExamAccommodation', objectId: id, after: { learnerId: x.learnerId, type: x.type }, reason: b.reason }); return { ok: true }; });
  }
  @Get('exams/:id/eligibility-overrides') @Roles(...RELEASERS, 'AUDITOR')
  async overrides(@Param('id') id: string) {
    const rows = await this.prisma.eligibilityOverride.findMany({ where: { examId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.learnerId, r.approvedById]))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, learnerName: names.get(r.learnerId)?.name ?? null, learnerEmail: names.get(r.learnerId)?.email ?? null, approvedByName: names.get(r.approvedById)?.name ?? null }));
  }

  @Post('exams/:id/eligibility-overrides') @Roles(...RELEASERS)
  async override(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { learnerId: 'string', reason: 'string' });
    if (!(await this.prisma.examDefinition.count({ where: { id } }))) throw new NotFoundException('no such exam');
    if (!(await this.prisma.user.count({ where: { id: b.learnerId, roles: { some: { role: 'LEARNER' } } } }))) throw new NotFoundException('no such learner');
    return this.prisma.$transaction(async (tx) => { const o = await tx.eligibilityOverride.create({ data: { examId: id, learnerId: b.learnerId, reason: b.reason, approvedById: a.id } }); await this.audit.record(tx, { actor: a, action: 'exam.eligibility_override', objectType: 'ExamDefinition', objectId: id, after: { learnerId: b.learnerId }, reason: b.reason }); return o; });
  }

  @Post('exams/integrity-cases/:submissionId/resolve') @Roles(...RELEASERS)
  async resolveIntegrity(@Param('submissionId') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { reason: 'string' });
    return this.prisma.$transaction(async (tx) => { const sg = await tx.submissionGrade.findUnique({ where: { submissionId: id } }); if (!sg || sg.integrityOutcome !== 'CONFIRMED_CONCERN') throw new NotFoundException('no open integrity case'); await tx.submissionGrade.update({ where: { submissionId: id }, data: { integrityOutcome: 'RESOLVED' } }); await this.audit.record(tx, { actor: a, action: 'integrity.case_resolved', objectType: 'Submission', objectId: id, reason: b.reason }); return { ok: true }; });
  }

  // ---- learner -----------------------------------------------------------------------------------------------------------------------------
  @Get('me/exams') @Roles('LEARNER')
  async mine(@CurrentActor() a: Actor) {
    const ents = await this.prisma.entitlement.findMany({ where: { learnerId: a.id } });
    const exams = await this.prisma.examDefinition.findMany({ where: { versionId: { in: ents.map((e) => e.versionId) }, status: 'PUBLISHED' } });
    return Promise.all(exams.map(async (e) => { const el = await this.svc.eligibility(a.id, e as any);
      const regs = await this.prisma.examRegistration.findMany({ where: { examId: e.id, learnerId: a.id, status: 'REGISTERED' } });
      const sessions = await this.prisma.examSession.findMany({ where: { examId: e.id, status: 'SCHEDULED', endsAt: { gt: new Date() } }, orderBy: { startsAt: 'asc' } });
      const attempts = await this.prisma.examAttempt.findMany({ where: { examId: e.id, learnerId: a.id }, orderBy: { attemptNo: 'asc' }, select: { id: true, attemptNo: true, status: true, resultState: true } });
      return { examId: e.id, code: e.code, title: e.title, durationMin: e.durationMin, mode: (e.proctoring as any).mode, passPercent: e.passPercent, eligibility: { eligible: el.eligible, overridden: el.overridden, checks: el.checks.map((c) => ({ key: c.key, ok: c.ok, detail: c.detail })) },
        consent: { text: CONSENT_TEXT, hash: consentHashFor(e.code) }, sessions: sessions.map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, mode: s.mode, centre: s.centre, registered: regs.some((r) => r.sessionId === s.id) })), attempts: attempts.map((x) => ({ id: x.id, attemptNo: x.attemptNo, status: x.status, result: x.resultState === 'RELEASED' ? 'RELEASED' : x.status === 'SUBMITTED' ? 'PENDING' : null })) }; }));
  }
  @Post('exams/:id/register') @Roles('LEARNER') register(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { sessionId: 'string' }); return this.svc.register(id, b.sessionId, a); }
  @Post('exam-sessions/:id/unregister') @Roles('LEARNER') unregister(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.unregister(id, a); }
  @Post('exam-sessions/:id/check-in') @Roles('LEARNER') checkIn(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.checkIn(id, a, b ?? {}); }
  @Post('exam-attempts/:id/device-check') @Roles('LEARNER') device(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.deviceCheck(id, a, b?.device ?? b); }
  @Post('exam-attempts/:id/start') @Roles('LEARNER') start(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.start(id, a); }
  @Post('exam-attempts/:id/resume') @Roles('LEARNER') resume(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.resume(id, a, b?.deviceId); }
  @Put('exam-attempts/:id/answers') @Roles('LEARNER') answers(@Param('id') id: string, @Headers('x-exam-session') t: string | undefined, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.saveAnswers(id, a, t, b ?? {}); }
  @Post('exam-attempts/:id/signals') @Roles('LEARNER') signal(@Param('id') id: string, @Headers('x-exam-session') t: string | undefined, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.signal(id, a, t, b?.kind); }
  @Post('exam-attempts/:id/submit') @Roles('LEARNER') submit(@Param('id') id: string, @Headers('x-exam-session') t: string | undefined, @CurrentActor() a: Actor) { return this.svc.submit(id, a, t); }

  /** Programme completion dashboard (PRD): internal eligibility and exam status; certificates are issued by an external service later. */
  @Get('me/completion') @Roles('LEARNER')
  async completion(@Query('entitlementId') entitlementId: string | undefined, @CurrentActor() a: Actor) {
    const ent = await this.prisma.entitlement.findFirst({ where: { learnerId: a.id, ...(entitlementId && { id: entitlementId }) } });
    if (!ent) throw new NotFoundException();
    const st = await (this.svc as any).prog.state(this.prisma, ent); const mand = st.rows.filter((r: any) => r.topic.mandatory);
    const exams = await this.prisma.examDefinition.findMany({ where: { versionId: ent.versionId, status: 'PUBLISHED' } });
    const att = await this.prisma.examAttempt.findMany({ where: { learnerId: a.id, examId: { in: exams.map((e) => e.id) }, resultState: 'RELEASED' } });
    const labs = await this.prisma.labActivity.findMany({ where: { versionId: ent.versionId, mandatory: true } }); const done = new Set(await (this.svc as any).labs.completedCodes(a.id, ent.versionId));
    const examRows = exams.map((e) => ({ code: e.code, passed: att.some((x) => x.examId === e.id && x.passed === true && x.outcome !== 'INVALIDATED') }));
    const topicsDone = mand.every((r: any) => r.complete), labsDone = labs.every((l) => done.has(l.code)), examsDone = examRows.every((e) => e.passed);
    return { topics: { complete: topicsDone, percent: mand.length ? Math.round((mand.filter((r: any) => r.complete).length / mand.length) * 100) : 0 }, labs: { complete: labsDone, outstanding: labs.filter((l) => !done.has(l.code)).map((l) => l.code) }, exams: examRows, programmeComplete: topicsDone && labsDone && examsDone && exams.length > 0 };
  }
}
