import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Injectable, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor, Roles } from './common/auth';
import { need } from './common/http';
import { AuditService } from './audit';
import { NotificationsService } from './notifications';
import { readBody, ScanProvider, SCANNER, StorageService } from './storage';
import { hasLearningAccess } from './domain/entitlement';
import { normalizePolicy, latePenalty } from './domain/grading';
import { canonical } from './domain/audit-chain';
import { ConfigService } from './ai/config';
import { acceptHeartbeat, attemptsRemaining, gradeQuiz, mergeRanges, Range, topicComplete, unlockedSet, videoComplete } from './domain/progression';

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class ProgressionService {
  constructor(private prisma: PrismaService, private notes: NotificationsService) {}

  // Published course structure is immutable, so it is cached per version. Only PUBLISHED/RETIRED versions are ever cached (a DRAFT can change).
  private struct = new Map<string, { at: number; topics: any[] }>();
  static STRUCT_TTL_MS = Number(process.env.STRUCT_CACHE_MS ?? 600_000);
  private async structure(db: Db, versionId: string) {
    const hit = this.struct.get(versionId); if (hit && Date.now() - hit.at < ProgressionService.STRUCT_TTL_MS) return hit.topics;
    const v = await db.programmeVersion.findUnique({ where: { id: versionId }, select: { state: true } });
    const topics = await db.topic.findMany({
      where: { module: { versionId } }, orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }],
      include: { quiz: { select: { id: true, maxAttempts: true, passPercent: true } }, assignment: { select: { id: true } }, assets: { select: { id: true, kind: true, durationSec: true, interactions: true } } },
    });
    if (v && ['PUBLISHED', 'RETIRED'].includes(v.state) && ProgressionService.STRUCT_TTL_MS > 0) { this.struct.set(versionId, { at: Date.now(), topics }); if (this.struct.size > 200) this.struct.delete(this.struct.keys().next().value!); }
    return topics;
  }

  /** Full per-topic state for an entitlement. Gating is computed here, never trusted from clients. */
  async state(db: Db, ent: { id: string; versionId: string }) {
    const [topics, progressRows, overrides] = await Promise.all([this.structure(db, ent.versionId), db.topicProgress.findMany({ where: { entitlementId: ent.id } }), db.progressionOverride.findMany({ where: { entitlementId: ent.id } })]);
    const progress = new Map(progressRows.map((p) => [p.topicId, p]));
    const rows = topics.map((t) => {
      const p = progress.get(t.id);
      const hasVideo = t.assets.some((a: any) => a.kind === 'VIDEO');
      const has = { quiz: !!t.quiz, assignment: !!t.assignment };
      const prog = { videoDone: (p?.videoDone ?? false) || !hasVideo, quizPassed: p?.quizPassed ?? false, assignmentSubmitted: p?.assignmentSubmitted ?? false };
      return { topic: t, p, has, prog, complete: topicComplete(prog, has),
        extraAttempts: overrides.filter((o) => o.topicId === t.id && o.type === 'EXTRA_QUIZ_ATTEMPTS').reduce((s, o) => s + o.value, 0),
        overrideUnlocked: overrides.some((o) => o.topicId === t.id && o.type === 'UNLOCK_TOPIC') };
    });
    const unlocked = unlockedSet(rows.map((r) => ({ topicId: r.topic.id, mandatory: r.topic.mandatory, complete: r.complete, overrideUnlocked: r.overrideUnlocked })));
    return { rows, unlocked };
  }

  /** Resolve the learner's entitlement + topic and enforce: published, entitled, active (not paused/expired), unlocked. */
  /** Quiz questions carry answer keys, so they are loaded only by the quiz endpoints that need them. */
  async context(db: Db, learnerId: string, topicId: string, requireUnlocked = true, withQuestions = false) {
    const topic = await db.topic.findUnique({ where: { id: topicId }, include: { module: { include: { version: true } }, quiz: withQuestions ? { include: { questions: { orderBy: { position: 'asc' } } } } : { include: { _count: { select: { questions: true } } } }, assignment: true, assets: true } }) as any;
    if (!topic || !['PUBLISHED', 'RETIRED'].includes(topic.module.version.state)) throw new NotFoundException();
    const ent = await db.entitlement.findUnique({ where: { learnerId_versionId: { learnerId, versionId: topic.module.versionId } } });
    if (!ent) throw new ForbiddenException('no entitlement');
    if (!hasLearningAccess(ent, new Date())) throw new ForbiddenException('entitlement not active');
    const st = await this.state(db, ent);
    if (requireUnlocked && !st.unlocked.has(topicId)) throw new ForbiddenException('topic locked');
    return { topic, ent, st, row: st.rows.find((r) => r.topic.id === topicId)! };
  }

  async lockProgress(tx: Prisma.TransactionClient, entitlementId: string, topicId: string) {
    await tx.topicProgress.upsert({ where: { entitlementId_topicId: { entitlementId, topicId } }, update: {}, create: { entitlementId, topicId } });
    await tx.$queryRaw`SELECT id FROM "TopicProgress" WHERE "entitlementId" = ${entitlementId} AND "topicId" = ${topicId} FOR UPDATE`;
    return tx.topicProgress.findUniqueOrThrow({ where: { entitlementId_topicId: { entitlementId, topicId } } });
  }

  /** Re-derive completion from facts; emit notifications on transitions. Called inside the writing transaction. */
  async recompute(tx: Prisma.TransactionClient, ent: { id: string; versionId: string; learnerId: string }, topicId: string) {
    const p = await tx.topicProgress.findUniqueOrThrow({ where: { entitlementId_topicId: { entitlementId: ent.id, topicId } } });
    const t = await tx.topic.findUniqueOrThrow({ where: { id: topicId }, include: { quiz: { select: { id: true } }, assignment: { select: { id: true } }, assets: true } });
    const ranges = p.videoRanges as Record<string, Range[]>, resp = p.responses as Record<string, Record<string, unknown>>;
    const videos = t.assets.filter((a) => a.kind === 'VIDEO');
    const videoDone = p.videoDone || videos.some((a) => videoComplete(ranges[a.id] ?? [], a.durationSec ?? 0, a.interactions as any[], Object.keys(resp[a.id] ?? {})));
    const complete = topicComplete({ videoDone: videoDone || !videos.length, quizPassed: p.quizPassed, assignmentSubmitted: p.assignmentSubmitted }, { quiz: !!t.quiz, assignment: !!t.assignment });
    const newlyComplete = complete && !p.completedAt;
    await tx.topicProgress.update({ where: { id: p.id }, data: { videoDone, ...(newlyComplete && { completedAt: new Date() }) } });
    if (newlyComplete) {
      await this.notes.notify(tx, ent.learnerId, 'topic.completed', { topicId, title: t.title });
      const st = await this.state(tx, ent);
      const i = st.rows.findIndex((r) => r.topic.id === topicId);
      const next = st.rows[i + 1];
      if (next) await this.notes.notify(tx, ent.learnerId, 'topic.unlocked', { topicId: next.topic.id, title: next.topic.title });
      else if (st.rows.every((r) => r.complete || !r.topic.mandatory)) await this.notes.notify(tx, ent.learnerId, 'programme.completed', { versionId: ent.versionId });
    }
  }
}

const EXT = /\.(pdf|txt|md|png|jpe?g|zip|ipynb|py|csv|docx?|mp4|mp3)$/i;

@Controller('v1')
export class LearningController {
  constructor(private prisma: PrismaService, private prog: ProgressionService, private audit: AuditService, private notes: NotificationsService, private storage: StorageService, @Inject(SCANNER) private scanner: ScanProvider, private config: ConfigService) {}

  @Get('me/entitlements/:id/progress') @Roles('LEARNER')
  async progress(@Param('id') id: string, @CurrentActor() a: Actor) {
    const ent = await this.prisma.entitlement.findFirst({ where: { id, learnerId: a.id } });
    if (!ent) throw new NotFoundException();
    const st = await this.prog.state(this.prisma, ent);
    const mand = st.rows.filter((r) => r.topic.mandatory);
    const done = mand.filter((r) => r.complete).length;
    const attempts = await this.prisma.quizAttempt.groupBy({ by: ['topicId'], where: { entitlementId: id, status: 'SUBMITTED' }, _count: true });
    const used = new Map(attempts.map((x) => [x.topicId, x._count]));
    const grades = await this.prisma.submissionGrade.findMany({ where: { entitlementId: id }, orderBy: { createdAt: 'desc' } });
    const lastGrade = new Map<string, (typeof grades)[number]>(); grades.forEach((g) => { if (!lastGrade.has(g.topicId)) lastGrade.set(g.topicId, g); });
    return { entitlementId: id, percentComplete: mand.length ? Math.round((done / mand.length) * 100) : 0,
      topics: st.rows.map((r) => ({ topicId: r.topic.id, title: r.topic.title, unlocked: st.unlocked.has(r.topic.id), videoDone: r.prog.videoDone, quizPassed: r.prog.quizPassed,
        assignmentSubmitted: r.prog.assignmentSubmitted, assignmentState: lastGrade.get(r.topic.id)?.state ?? null, complete: r.complete, resumeSec: r.p?.resumeSec ?? 0,
        quizAttemptsRemaining: r.topic.quiz ? attemptsRemaining(r.topic.quiz.maxAttempts, used.get(r.topic.id) ?? 0, r.extraAttempts) : null })) };
  }

  @Get('topics/:id') @Roles('LEARNER')
  async topic(@Param('id') id: string, @CurrentActor() a: Actor) {
    const { topic, row } = await this.prog.context(this.prisma, a.id, id);
    const lang = (await this.prisma.user.findUnique({ where: { id: a.id }, select: { language: true } }))?.language ?? 'en';
    return { id: topic.id, title: topic.title, outcomes: topic.outcomes,
      assets: topic.assets.map((x: any) => ({ id: x.id, kind: x.kind, language: x.language, durationSec: x.durationSec })),
      quiz: topic.quiz && { passPercent: topic.quiz.passPercent, maxAttempts: topic.quiz.maxAttempts, questions: topic.quiz.questions?.length ?? topic.quiz._count?.questions ?? 0 },
      assignment: topic.assignment && { rubricDimensions: normalizePolicy(topic.assignment.policy, topic.assignment.rubric, { confidenceThreshold: 0.8, sampleRate: 0, appealWindowDays: 7 }).dimensions.map((d) => ({ id: d.id, name: d.name, weight: d.weight, scale: [d.min, d.max], levels: d.levels })), instructions: (topic.assignment.i18n as any)?.[lang]?.instructions ?? topic.assignment.instructions, rubric: topic.assignment.rubric, maxSubmissions: topic.assignment.maxSubmissions },
      progress: row.prog };
  }

  // ---- Learning events (batchable, offline-safe, idempotent) ---------------------------------------------
  @Post('learning-events') @Roles('LEARNER')
  async events(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { events: 'array' });
    if (b.events.length > 200) throw new BadRequestException('max 200 events per batch');
    const results: ({ eventId: string; status: string; reason?: string } | undefined)[] = new Array(b.events.length);
    const groups = new Map<string, { i: number; e: any; at: Date }[]>();
    b.events.forEach((e: any, i: number) => { // cheap validation first; only well-formed events reach the database
      const eventId = e?.eventId;
      if (typeof eventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(eventId) || typeof e.topicId !== 'string' || !['VIDEO_HEARTBEAT', 'INTERACTION_RESPONSE', 'VIDEO_POSITION'].includes(e.type) || isNaN(Date.parse(e.occurredAt))) return void (results[i] = { eventId, status: 'rejected', reason: 'malformed' });
      const at = new Date(e.occurredAt); if (at.getTime() > Date.now() + 5 * 60_000) return void (results[i] = { eventId, status: 'rejected', reason: 'future_timestamp' });
      groups.set(e.topicId, [...(groups.get(e.topicId) ?? []), { i, e, at }]);
    });
    // One transaction per topic (not per event): a 4-heartbeat batch costs ~8 queries instead of ~60. Topics are independent rows, so groups run concurrently.
    await Promise.all([...groups].map(async ([topicId, evs]) => { const out = await this.ingestTopic(topicId, evs.map((x) => ({ e: x.e, at: x.at })), a); evs.forEach((x, k) => (results[x.i] = out[k])); }));
    return { results };
  }

  private async ingestTopic(topicId: string, evs: { e: any; at: Date }[], a: Actor): Promise<{ eventId: string; status: string; reason?: string }[]> {
    const reject = (reason: string) => evs.map((x) => ({ eventId: x.e.eventId, status: 'rejected', reason }));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const topic = await tx.topic.findUnique({ where: { id: topicId }, include: { module: { select: { versionId: true } }, assets: true } });
        if (!topic) return reject('unknown_topic');
        const ent = await tx.entitlement.findUnique({ where: { learnerId_versionId: { learnerId: a.id, versionId: topic.module.versionId } } });
        if (!ent || ent.status === 'REVOKED') return reject('no_access');
        // Unlocking is monotonic and every code path that creates a progress row first proves the topic was unlocked, so an existing row
        // is proof; only a learner's FIRST event on a topic pays for the full gating computation.
        const existed = await tx.topicProgress.findUnique({ where: { entitlementId_topicId: { entitlementId: ent.id, topicId } }, select: { id: true } });
        if (!existed && !(await this.prog.state(tx, ent)).unlocked.has(topicId)) return reject('topic_locked');
        const p0 = await this.prog.lockProgress(tx, ent.id, topicId);
        const seen = new Set((await tx.learningEvent.findMany({ where: { eventId: { in: evs.map((x) => x.e.eventId) } }, select: { eventId: true } })).map((x) => x.eventId));
        const ranges: Record<string, Range[]> = { ...(p0.videoRanges as any) }, responses: Record<string, Record<string, unknown>> = { ...(p0.responses as any) };
        let resume = { assetId: p0.resumeAssetId, sec: p0.resumeSec, at: p0.resumeAt }; let changed = false;
        const out: { eventId: string; status: string; reason?: string }[] = []; const accepted: any[] = [];
        for (const { e, at } of evs) {
          const eventId = e.eventId as string;
          if (at >= ent.endAt || at < ent.startAt) { out.push({ eventId, status: 'rejected', reason: 'no_access' }); continue; } // offline events count if they happened inside the entitlement window
          const asset = topic.assets.find((x) => x.id === e.payload?.assetId && x.kind === 'VIDEO');
          if (!asset) { out.push({ eventId, status: 'rejected', reason: 'unknown_asset' }); continue; }
          if (e.type === 'VIDEO_HEARTBEAT') {
            const r = acceptHeartbeat(Number(e.payload.from), Number(e.payload.to), asset.durationSec ?? 0);
            if (!r) { out.push({ eventId, status: 'rejected', reason: 'implausible_range' }); continue; }
            if (seen.has(eventId)) { out.push({ eventId, status: 'duplicate' }); continue; }
            ranges[asset.id] = mergeRanges([...(ranges[asset.id] ?? []), r]); changed = true;
          } else if (e.type === 'INTERACTION_RESPONSE') {
            if (!(asset.interactions as any[]).some((i) => i.id === e.payload.interactionId)) { out.push({ eventId, status: 'rejected', reason: 'unknown_interaction' }); continue; }
            if (seen.has(eventId)) { out.push({ eventId, status: 'duplicate' }); continue; }
            responses[asset.id] = { ...(responses[asset.id] ?? {}), [e.payload.interactionId]: e.payload.response ?? true }; changed = true;
          } else {
            if (seen.has(eventId)) { out.push({ eventId, status: 'duplicate' }); continue; }
            if (!resume.at || at > resume.at) { resume = { assetId: asset.id, sec: Math.max(0, Math.min(Number(e.payload.sec) || 0, asset.durationSec ?? 0)), at }; changed = true; }
          }
          seen.add(eventId); out.push({ eventId, status: 'accepted' });
          accepted.push({ eventId, learnerId: a.id, entitlementId: ent.id, topicId, type: e.type, payload: e.payload, occurredAt: at, deviceId: e.deviceId, seq: e.seq });
        }
        if (accepted.length) await tx.learningEvent.createMany({ data: accepted, skipDuplicates: true });
        if (changed) {
          await tx.topicProgress.update({ where: { id: p0.id }, data: { videoRanges: ranges as any, responses: responses as any, resumeAssetId: resume.assetId, resumeSec: resume.sec, resumeAt: resume.at } });
          await this.prog.recompute(tx, ent, topicId); // once per batch
        }
        return out;
      }, { timeout: 15_000 });
    } catch { return reject('error'); }
  }

  // ---- Quiz ----------------------------------------------------------------------------------------------
  @Post('topics/:id/quiz/start') @Roles('LEARNER')
  async quizStart(@Param('id') id: string, @CurrentActor() a: Actor) {
    const { topic, ent, row } = await this.prog.context(this.prisma, a.id, id, true, true);
    if (!topic.quiz) throw new NotFoundException('no quiz');
    const lang = (await this.prisma.user.findUnique({ where: { id: a.id }, select: { language: true } }))?.language ?? 'en';
    if (!row.prog.videoDone) throw new ConflictException('complete the video first');
    if (row.prog.quizPassed) throw new ConflictException('quiz already passed');
    return this.prisma.$transaction(async (tx) => {
      await this.prog.lockProgress(tx, ent.id, id);
      const open = await tx.quizAttempt.findFirst({ where: { entitlementId: ent.id, topicId: id, status: 'IN_PROGRESS' } });
      const used = await tx.quizAttempt.count({ where: { entitlementId: ent.id, topicId: id, status: 'SUBMITTED' } });
      if (!open && attemptsRemaining(topic.quiz!.maxAttempts, used, row.extraAttempts) === 0) throw new ConflictException('attempts exhausted: remediation required');
      const attempt = open ?? await tx.quizAttempt.create({ data: { quizId: topic.quiz!.id, topicId: id, learnerId: a.id, entitlementId: ent.id } });
      return { attemptId: attempt.id, passPercent: topic.quiz!.passPercent,
        questions: topic.quiz!.questions.map((q: any) => { const t = (q.i18n as any)?.[lang]; return { id: q.id, type: q.type, text: t?.text ?? q.text, options: t?.options ?? q.options, points: q.points }; }) }; // no answer keys; Hindi if available
    });
  }

  @Post('quiz-attempts/:id/submit') @Roles('LEARNER')
  async quizSubmit(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { answers: 'object' });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "QuizAttempt" WHERE id = ${id} FOR UPDATE`;
      const at = await tx.quizAttempt.findUnique({ where: { id } });
      if (!at || at.learnerId !== a.id) throw new NotFoundException();
      if (at.status !== 'IN_PROGRESS') throw new ConflictException('already submitted');
      const { topic, ent, row } = await this.prog.context(tx, a.id, at.topicId, true, true);
      const quiz = topic.quiz!;
      const lang = (await tx.user.findUnique({ where: { id: a.id }, select: { language: true } }))?.language ?? 'en';
      const g = gradeQuiz(quiz.questions.map((q: any) => ({ id: q.id, type: q.type, answer: q.answer, tolerance: q.tolerance, points: q.points })), b.answers);
      const passed = g.scorePercent >= quiz.passPercent;
      await tx.quizAttempt.update({ where: { id }, data: { status: 'SUBMITTED', answers: b.answers, scorePercent: g.scorePercent, passed, submittedAt: new Date() } });
      await this.prog.lockProgress(tx, ent.id, topic.id);
      if (passed) { await tx.topicProgress.update({ where: { entitlementId_topicId: { entitlementId: ent.id, topicId: topic.id } }, data: { quizPassed: true } }); await this.prog.recompute(tx, ent, topic.id); }
      const used = await tx.quizAttempt.count({ where: { entitlementId: ent.id, topicId: topic.id, status: 'SUBMITTED' } });
      const remaining = attemptsRemaining(quiz.maxAttempts, used, row.extraAttempts);
      if (!passed && remaining === 0) await this.notes.notify(tx, a.id, 'quiz.attempts_exhausted', { topicId: topic.id, title: topic.title });
      // Rationale is revealed only after passing so failed attempts cannot be used to harvest answers.
      return { scorePercent: g.scorePercent, passed, attemptsRemaining: remaining,
        results: g.results.map((r) => ({ questionId: r.questionId, correct: r.correct, ...(passed && { rationale: ((qq: any) => (qq?.i18n as any)?.[lang]?.rationale ?? qq?.rationale)(quiz.questions.find((q: any) => q.id === r.questionId)) }) })) };
    });
  }

  // ---- Assignment ------------------------------------------------------------------------------------------
  @Put('topics/:id/assignment/upload') @Roles('LEARNER')
  async upload(@Param('id') id: string, @Query('name') name: string, @Req() req: any, @CurrentActor() a: Actor) {
    await this.prog.context(this.prisma, a.id, id);
    if (!name || !EXT.test(name) || /[\/\\]/.test(name)) throw new BadRequestException('file name/extension not allowed');
    const data = await readBody(req, 10 * 1024 * 1024);
    if (!data.length) throw new BadRequestException('empty file');
    const scan = await this.scanner.scan(data, name);
    if (scan !== 'CLEAN') throw new BadRequestException('file rejected by malware scan');
    const f = await this.storage.put(`submissions/${a.id}/${randomUUID()}-${name}`, data);
    return { key: f.key, name, size: f.size, checksum: f.checksum, scanStatus: scan };
  }

  @Post('topics/:id/assignment/submit') @Roles('LEARNER')
  async submit(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    const { topic, ent, row } = await this.prog.context(this.prisma, a.id, id);
    if (!topic.assignment) throw new NotFoundException('no assignment');
    if (topic.quiz && !row.prog.quizPassed) throw new ConflictException('pass the quiz first');
    const text = typeof b?.text === 'string' ? b.text.trim() : '';
    const files = Array.isArray(b?.files) ? b.files : [];
    if (!text && !files.length) throw new BadRequestException('text or files required');
    if (files.some((f: any) => typeof f?.key !== 'string' || !f.key.startsWith(`submissions/${a.id}/`))) throw new ForbiddenException('file does not belong to learner');
    const policy = normalizePolicy(topic.assignment.policy, topic.assignment.rubric, { confidenceThreshold: await this.config.get<number>('grading.default_confidence_threshold'), sampleRate: await this.config.get<number>('grading.sample_rate'), appealWindowDays: await this.config.get<number>('grading.appeal_window_days') });
    return this.prisma.$transaction(async (tx) => {
      await this.prog.lockProgress(tx, ent.id, id);
      const ext = (await tx.progressionOverride.findMany({ where: { entitlementId: ent.id, topicId: id, type: 'DEADLINE_EXTENSION' } })).reduce((sum, o) => sum + o.value, 0);
      if (latePenalty(policy.lateRule, new Date(), ext).closed) throw new ConflictException('the submission window for this assignment has closed');
      const n = await tx.submission.count({ where: { assignmentId: topic.assignment!.id, learnerId: a.id } });
      if (n >= topic.assignment!.maxSubmissions) throw new ConflictException('submission limit reached');
      const open = await tx.submissionGrade.count({ where: { learnerId: a.id, topicId: id, state: { in: ['PENDING_AI', 'MODERATION_REQUIRED'] } } });
      if (open) throw new ConflictException('your previous submission is still being evaluated');
      const content = { text, files };
      const s = await tx.submission.create({ data: { assignmentId: topic.assignment!.id, topicId: id, learnerId: a.id, entitlementId: ent.id, attemptNo: n + 1, content, contentHash: createHash('sha256').update(canonical(content)).digest('hex') } });
      await tx.submissionGrade.create({ data: { submissionId: s.id, assignmentId: topic.assignment!.id, topicId: id, learnerId: a.id, entitlementId: ent.id, versionId: ent.versionId } });
      await tx.generationJob.create({ data: { kind: 'GRADE_SUBMISSION', input: { submissionId: s.id }, requestedById: a.id, topicId: id, versionId: ent.versionId } }); // graded asynchronously
      // SUBMISSION unlock rule satisfies the condition now; other rules wait for a grade (ASN-002)
      await tx.topicProgress.update({ where: { entitlementId_topicId: { entitlementId: ent.id, topicId: id } }, data: { assignmentSubmitted: policy.unlockOn === 'SUBMISSION' ? true : undefined } });
      await this.prog.recompute(tx, ent, id);
      return { submissionId: s.id, attemptNo: s.attemptNo, status: 'PENDING_AI', unlockRule: policy.unlockOn };
    });
  }

  // ---- Authorised override (logged) ---------------------------------------------------------------------------
  @Post('entitlements/:id/progression-overrides') @Roles('ACADEMIC_ADMIN', 'PLATFORM_ADMIN')
  async override(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { topicId: 'string', type: 'string', reason: 'string' });
    if (!['UNLOCK_TOPIC', 'EXTRA_QUIZ_ATTEMPTS', 'DEADLINE_EXTENSION'].includes(b.type)) throw new BadRequestException('type');
    const value = b.type === 'UNLOCK_TOPIC' ? 0 : Number(b.value);
    if (b.type === 'EXTRA_QUIZ_ATTEMPTS' && !(Number.isInteger(value) && value >= 1 && value <= 5)) throw new BadRequestException('value 1..5');
    if (b.type === 'DEADLINE_EXTENSION' && !(Number.isInteger(value) && value >= 1 && value <= 720)) throw new BadRequestException('value 1..720 hours');
    return this.prisma.$transaction(async (tx) => {
      const ent = await tx.entitlement.findUnique({ where: { id } });
      if (!ent) throw new NotFoundException();
      const t = await tx.topic.findFirst({ where: { id: b.topicId, module: { versionId: ent.versionId } } });
      if (!t) throw new BadRequestException('topic not in entitlement');
      const o = await tx.progressionOverride.create({ data: { entitlementId: id, topicId: b.topicId, type: b.type, value, reason: b.reason, approvedById: a.id } });
      await this.audit.record(tx, { actor: a, action: `progression.override.${b.type.toLowerCase()}`, objectType: 'Entitlement', objectId: id, after: { topicId: b.topicId, value }, reason: b.reason });
      await this.notes.notify(tx, ent.learnerId, 'progression.override', { topicId: b.topicId, type: b.type });
      return o;
    });
  }
}
