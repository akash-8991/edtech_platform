import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor } from '../common/auth';
import { AuditService } from '../audit';
import { ConfigService } from '../ai/config';
import { GatewayService } from '../ai/gateway';
import { PromptRegistry, render } from '../ai/prompts';
import { SCHEMAS } from '../ai/schemas';
import { shingles } from '../ai/quality';
import { NotificationsService } from '../notifications';
import { ProgressionService } from '../learning';
import { StorageService } from '../storage';
import { canonical } from '../domain/audit-chain';
import { AiDim, AiOut, aggregateSamples, applyPenalty, calibrate, computeScore, injectionAttempt, latePenalty, matchProhibited, normalizePolicy, Policy, PolicyDefaults, routeModeration, similarity, timingFlag, validateAiOutput, verifyEvidence, wordCount } from '../domain/grading';
import { extractSubmission, Extracted } from './extract';
import { SANDBOX, SandboxProvider, SandboxResult } from './sandbox';

/** Thrown to put a grading job back on the queue (model unavailable): learners are never stuck on an outage. */
export class Requeue extends Error { constructor(public delayMs: number, msg: string) { super(msg); } }
export class GradingInvalid extends Error { constructor(public issues: string[]) { super(`grader output invalid: ${issues.join('; ')}`); } }

const j = (v: unknown) => JSON.stringify(v, null, 1);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const AI_FLAGS = new Set(['off_topic', 'possible_copying', 'incomplete', 'language_mismatch', 'suspicious']);
const asActor = (id: string | null, roles: string[] = ['AI_GENERATED']): Actor => ({ id: id ?? 'system', roles });
export const learnerRef = (learnerId: string, submissionId: string) => sha(learnerId + submissionId).slice(0, 8); // moderators compare work, not identities

export interface HumanDim { id: string; score: number; rationale?: string }
type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class GradingService {
  private log = new Logger('grading');
  constructor(private prisma: PrismaService, private gw: GatewayService, private prompts: PromptRegistry, private config: ConfigService, private audit: AuditService, private notes: NotificationsService,
    private prog: ProgressionService, private storage: StorageService, @Inject(SANDBOX) private sandbox: SandboxProvider) {}

  async defaults(): Promise<PolicyDefaults> {
    return { confidenceThreshold: await this.config.get<number>('grading.default_confidence_threshold'), sampleRate: await this.config.get<number>('grading.sample_rate'), appealWindowDays: await this.config.get<number>('grading.appeal_window_days') };
  }
  async policyFor(a: { policy: unknown; rubric: unknown }): Promise<Policy> { return normalizePolicy(a.policy, a.rubric, await this.defaults()); }

  private async extensionHours(db: Db, entitlementId: string, topicId: string) {
    return (await db.progressionOverride.findMany({ where: { entitlementId, topicId, type: 'DEADLINE_EXTENSION' } })).reduce((s, o) => s + o.value, 0);
  }

  // ---- AI evaluation (shared by live grading and the benchmark) ---------------------------------------------------------
  async evaluate(i: { policy: Policy; instructions: string; extracted: Extracted; language: 'en' | 'hi'; actorId: string; jobId?: string; automated: object; prompt?: { system: string; user: string; key: string; version: number; hash: string; schemaName: string } }) {
    const p = i.prompt ?? await this.prompts.resolve('grader');
    const rubric = i.policy.dimensions.map((d) => ({ id: d.id, name: d.name, weight: d.weight, scale: `${d.min}..${d.max}`, levels: d.levels, evidenceRequired: !!d.evidenceRequired }));
    const sub = i.extracted.text.replace(/<\/?untrusted_submission/gi, '[tag]');
    const user = render(p.user, { language: i.language === 'hi' ? 'Hindi (Devanagari)' : 'English', disclose: String(i.policy.discloseAnswerGuide), assignment: i.instructions, rubric: j(rubric), reference: i.policy.referenceEvidence ?? 'none provided', automated: j(i.automated), submission: sub });
    const samples: AiOut[] = []; let cost = 0, meta = { provider: '', model: '' };
    for (let n = 0; n < i.policy.samples; n++) {
      let out: AiOut | undefined, issues: string[] = [], extra = '';
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        const r = await this.gw.run<AiOut>({ useCase: 'grading', system: p.system, user: user + extra, schema: SCHEMAS[p.schemaName], schemaName: p.schemaName, promptKey: p.key, promptVersion: p.version, jobId: i.jobId, actorId: i.actorId });
        cost += r.costUsd; meta = { provider: r.provider, model: r.model };
        issues = validateAiOutput(i.policy, r.json);
        if (!issues.length) out = r.json; else extra = `\n\nYour previous output was invalid:\n- ${issues.join('\n- ')}\nReturn a corrected, complete grading.`;
      }
      if (!out) throw new GradingInvalid(issues);
      samples.push(out);
    }
    return { ...aggregateSamples(i.policy, samples), cost, ...meta, promptKey: p.key, promptVersion: p.version, promptHash: p.hash, samples: samples.length };
  }

  /** Dimension scores derived from executed tests replace the model's score for those dimensions (objective beats opinion). */
  private applyTests(policy: Policy, dims: AiDim[], tests: SandboxResult | null) {
    const notes: string[] = []; const out = dims.map((d) => ({ ...d, source: 'ai' as 'ai' | 'tests' }));
    if (!tests?.ran) return { dims: out, notes };
    for (const d of policy.dimensions) {
      const rel = tests.results.filter((t) => t.dimension === d.id); if (!rel.length) continue;
      const ratio = rel.filter((t) => t.passed).length / rel.length;
      const tScore = Math.round((d.min + ratio * (d.max - d.min)) * 2) / 2;
      const cur = out.find((x) => x.id === d.id)!;
      if (Math.abs(cur.score - tScore) > 0.25 * (d.max - d.min)) notes.push(`ai_test_disagreement:${d.id}`);
      cur.score = tScore; cur.source = 'tests'; cur.evidence = [...cur.evidence, { quote: `${rel.filter((t) => t.passed).length}/${rel.length} automated tests passed`, location: 'tests', verified: true }];
    }
    return { dims: out, notes };
  }

  // ---- the grading job -----------------------------------------------------------------------------------------------------
  async grade(job: { id: string; attempts: number; input: any }) {
    const sub = await this.prisma.submission.findUniqueOrThrow({ where: { id: job.input.submissionId } });
    const sg0 = await this.prisma.submissionGrade.findUniqueOrThrow({ where: { submissionId: sub.id } });
    if (sg0.state !== 'PENDING_AI') return { skipped: sg0.state }; // idempotent
    const asg = await this.prisma.assignment.findUniqueOrThrow({ where: { id: sub.assignmentId }, include: { topic: true } });
    const policy = await this.policyFor(asg);
    const lang = ((await this.prisma.user.findUnique({ where: { id: sub.learnerId }, select: { language: true } }))?.language === 'hi' ? 'hi' : 'en') as 'en' | 'hi';
    const content = sub.content as { text?: string; files?: { key: string; name: string; checksum?: string }[] };

    // 1) deterministic extraction (what the grader and moderators will see)
    const flags: string[] = []; const files: { name: string; data: Buffer }[] = [];
    for (const f of content.files ?? []) {
      try {
        if (!f.key.startsWith(`submissions/${sub.learnerId}/`)) { flags.push('file_not_owned'); continue; }
        const data = await this.storage.get(f.key);
        if (f.checksum && sha256buf(data) !== f.checksum) flags.push('file_tampered'); else files.push({ name: f.name, data });
      } catch { flags.push('file_missing'); }
    }
    const ex = extractSubmission(content.text ?? '', files);
    const unparsed = ex.files.some((f) => !f.parsed) || (content.files ?? []).length > files.length || ex.truncated;
    await this.prisma.submissionArtifact.upsert({ where: { submissionId: sub.id }, update: {}, create: { submissionId: sub.id, text: ex.text, textHash: sha(ex.text), files: ex.files as any } });

    // 2) integrity indicators (flags force human review; they never change a score or accuse)
    const thr = await this.config.get<number>('grading.similarity_threshold');
    const others = await this.prisma.$queryRaw<{ id: string; text: string }[]>(Prisma.sql`
      SELECT s.id, a.text FROM "SubmissionArtifact" a JOIN "Submission" s ON s.id = a."submissionId"
      WHERE s."assignmentId" = ${sub.assignmentId} AND s."learnerId" <> ${sub.learnerId} ORDER BY s."createdAt" DESC LIMIT 500`);
    const matches = others.map((o) => ({ id: o.id, score: similarity(ex.text, o.text) })).filter((m) => m.score >= thr).sort((a, b) => b.score - a.score).slice(0, 5);
    if (matches.length) flags.push('similarity');
    if (policy.referenceEvidence && similarity(ex.text, policy.referenceEvidence) >= thr) flags.push('matches_reference');
    if (matchProhibited(ex.text, policy.prohibitedPatterns).length) flags.push('prohibited_pattern');
    if (injectionAttempt(ex.text)) flags.push('grader_injection_attempt');
    const quiz = await this.prisma.quizAttempt.findFirst({ where: { entitlementId: sub.entitlementId, topicId: sub.topicId, passed: true }, orderBy: { submittedAt: 'desc' } });
    const tf = timingFlag(wordCount(ex.text), quiz?.submittedAt ? (sub.createdAt.getTime() - quiz.submittedAt.getTime()) / 1000 : null, policy.minSecondsExpected); if (tf) flags.push(tf);

    // 3) code: run tests in the sandbox only if one is configured; otherwise a human must look
    let tests: SandboxResult | null = null; let testsNotRun = false;
    if (policy.codeTests) {
      if (this.sandbox.enabled && ex.codeFiles.length) {
        try { tests = await this.sandbox.run({ language: policy.codeTests.language, files: ex.codeFiles.map((c) => ({ path: c.path.replace(/^.*!\//, ''), content: c.content })), entry: policy.codeTests.entry, tests: policy.codeTests.tests, timeoutMs: policy.codeTests.timeoutMs }); } catch (e: any) { this.log.warn(`sandbox failed: ${e?.message}`); }
      }
      testsNotRun = !tests?.ran;
    }

    // 4) AI evaluation; outage => requeue with backoff, then hand to a human (TRD: grading queues)
    let ai: Awaited<ReturnType<GradingService['evaluate']>> | null = null; let invalid = false; let unavailable = false;
    try {
      ai = await this.evaluate({ policy, instructions: asg.instructions, extracted: ex, language: lang, actorId: sub.learnerId, jobId: job.id, automated: { tests: tests ? tests.results.map((t) => ({ name: t.name, passed: t.passed, dimension: t.dimension })) : 'not run', unparsed_files: ex.files.filter((f) => !f.parsed).map((f) => f.name), integrity_signals_for_context_only: flags } });
    } catch (e: any) {
      if (e instanceof GradingInvalid) invalid = true;
      else {
        const max = await this.config.get<number>('grading.max_ai_attempts');
        if (job.attempts < max) throw new Requeue(Math.min(3600_000, 60_000 * 2 ** job.attempts), `model unavailable: ${e?.message ?? e}`);
        unavailable = true;
      }
    }

    // 5) scoring, evidence, calibration, routing
    const ext = await this.extensionHours(this.prisma, sub.entitlementId, sub.topicId);
    const late = latePenalty(policy.lateRule, sub.createdAt, ext);
    let record: Prisma.GradeRecordUncheckedCreateInput | null = null; let routing: ReturnType<typeof routeModeration>;
    const common = { integrityFlags: flags.map((f) => `${f}`), unparsed, testsNotRun, sampleRoll: Math.random() };
    if (ai) {
      const { dims, notes } = this.applyTests(policy, ai.dims, tests);
      // quotes must appear in the learner's work; evidence produced by executed tests is already authoritative
      const checked = dims.map((d) => ({ ...d, evidence: [...verifyEvidence(ex.text, d.evidence.filter((e) => e.location !== 'tests')), ...d.evidence.filter((e) => e.location === 'tests')] }));
      const allEv = checked.flatMap((d) => d.evidence); const evRatio = allEv.length ? allEv.filter((e) => e.verified).length / allEv.length : 0;
      const evidenceMissing = policy.dimensions.filter((d) => d.evidenceRequired && !checked.find((x) => x.id === d.id)!.evidence.some((e) => e.verified)).map((d) => d.id);
      const confidence = calibrate({ modelConfidence: Math.min(ai.overallConfidence, ...ai.dims.map((d) => d.confidence)), evidenceRatio: allEv.length ? evRatio : 1, unstable: ai.unstable, unparsed });
      const sc = computeScore(policy, checked.map((d) => ({ id: d.id, score: d.score })));
      const fin = applyPenalty(sc.rawPercent, late.penaltyPercent); const passed = fin >= policy.passPercent && !sc.disqualified.length;
      const aiFlags = ai.flags.filter((f) => AI_FLAGS.has(f)).map((f) => `ai_${f}`);
      const leak = policy.referenceEvidence && !policy.discloseAnswerGuide && [...shingles(`${ai.feedback} ${checked.map((d) => d.rationale).join(' ')}`, 8)].some((s) => shingles(policy.referenceEvidence!, 8).has(s));
      routing = routeModeration({ p: policy, confidence, rawPercent: sc.rawPercent, finalPercent: fin, dimScores: sc.perDimension, ...common, integrityFlags: [...flags, ...notes, ...aiFlags, ...(leak ? ['reference_leak'] : [])], evidenceMissing, unstable: ai.unstable, invalid: false, aiUnavailable: false, disqualified: sc.disqualified });
      record = { submissionId: sub.id, seq: 1, kind: 'AI', dimensions: checked.map((d) => ({ id: d.id, score: d.score, max: policy.dimensions.find((x) => x.id === d.id)!.max, rationale: d.rationale, evidence: d.evidence, confidence: d.confidence, source: d.source })) as any,
        rawPercent: sc.rawPercent, latePenaltyPercent: late.penaltyPercent, finalPercent: fin, passed, confidence, flags: routing.reasons as any, feedback: ai.feedback, provider: ai.provider, model: ai.model, promptKey: ai.promptKey, promptVersion: ai.promptVersion, promptHash: ai.promptHash, samples: ai.samples, costUsd: ai.cost };
    } else {
      routing = routeModeration({ p: policy, confidence: 0, rawPercent: 0, finalPercent: 0, dimScores: [], ...common, evidenceMissing: [], unstable: false, invalid, aiUnavailable: unavailable, disqualified: [] });
      routing.reasons = routing.reasons.filter((r) => r !== 'borderline');
    }

    // 6) persist atomically: record, state, task, unlock, notification
    return this.prisma.$transaction(async (tx) => {
      const sg = await tx.submissionGrade.findUniqueOrThrow({ where: { submissionId: sub.id } });
      if (sg.state !== 'PENDING_AI') return { skipped: sg.state };
      for (const m of matches) await tx.similarityMatch.create({ data: { submissionId: sub.id, otherSubmissionId: m.id, kind: 'CROSS_LEARNER', score: m.score } });
      if (tests) await tx.submissionArtifact.update({ where: { submissionId: sub.id }, data: { testResults: tests as any } });
      const rec = record ? await tx.gradeRecord.create({ data: record }) : null;
      const blocking = routing.blocking;
      const now = new Date();
      await tx.submissionGrade.update({ where: { submissionId: sub.id }, data: { state: blocking ? 'MODERATION_REQUIRED' : 'GRADED', currentSeq: rec?.seq ?? null, aiPercent: rec?.rawPercent ?? null, aiAttempts: job.attempts, moderationReasons: routing.reasons as any,
        ...(!blocking && rec ? { finalPercent: rec.finalPercent, passed: rec.passed, releasedAt: now, appealDeadline: new Date(now.getTime() + policy.appealWindowDays * 86_400_000) } : {}) } });
      if (blocking) await tx.moderationTask.create({ data: { submissionId: sub.id, kind: 'BLOCKING', reasons: routing.reasons as any } });
      else if (routing.sample) await tx.moderationTask.create({ data: { submissionId: sub.id, kind: 'SAMPLE', reasons: ['random_quality_sample'] } });
      await this.audit.record(tx, { actor: asActor(null), action: 'grade.ai_graded', objectType: 'Submission', objectId: sub.id, after: { state: blocking ? 'MODERATION_REQUIRED' : 'GRADED', percent: rec?.finalPercent ?? null, confidence: rec?.confidence ?? null, reasons: routing.reasons, model: rec?.model } });
      if (blocking) await this.notes.notify(tx, sub.learnerId, 'assignment.under_review', { submissionId: sub.id, topicId: sub.topicId });
      else if (rec) { await this.notes.notify(tx, sub.learnerId, 'assignment.graded', { submissionId: sub.id, topicId: sub.topicId, percent: rec.finalPercent, passed: rec.passed }); await this.maybeUnlock(tx, sub, policy, rec.passed, false); }
      return { state: blocking ? 'MODERATION_REQUIRED' : 'GRADED', reasons: routing.reasons, percent: rec?.finalPercent ?? null };
    });
  }

  /** Unlock rule (ASN-002): SUBMISSION unlocks at submit; AI_SCORE when an accepted AI/human grade passes; MODERATED_SCORE only for human grades. */
  async maybeUnlock(tx: Prisma.TransactionClient, sub: { entitlementId: string; topicId: string; learnerId: string }, policy: Policy, passed: boolean, human: boolean) {
    if (!passed || !(policy.unlockOn === 'AI_SCORE' || (policy.unlockOn === 'MODERATED_SCORE' && human))) return;
    await this.setAssignmentCondition(tx, sub);
  }
  async setAssignmentCondition(tx: Prisma.TransactionClient, sub: { entitlementId: string; topicId: string; learnerId: string }) {
    const ent = await tx.entitlement.findUniqueOrThrow({ where: { id: sub.entitlementId } });
    await this.prog.lockProgress(tx, ent.id, sub.topicId);
    await tx.topicProgress.update({ where: { entitlementId_topicId: { entitlementId: ent.id, topicId: sub.topicId } }, data: { assignmentSubmitted: true } }); // monotonic: never re-locked
    await this.prog.recompute(tx, ent, sub.topicId);
  }

  // ---- human grading: moderation, appeals, overrides --------------------------------------------------------------------------
  /** Validate and score a human grade; carries the original late penalty so a human cannot silently waive it. */
  private async humanRecord(tx: Prisma.TransactionClient, sub: any, policy: Policy, actor: Actor, kind: 'MODERATED' | 'APPEAL' | 'OVERRIDE', dims: HumanDim[], feedback: string, reason: string, seq: number) {
    const ids = new Set(policy.dimensions.map((d) => d.id));
    if (!Array.isArray(dims) || dims.length !== ids.size || dims.some((d) => !ids.has(d.id)) || new Set(dims.map((d) => d.id)).size !== ids.size) throw new BadRequestException('dimensions must contain every rubric dimension exactly once');
    for (const d of dims) { const pd = policy.dimensions.find((x) => x.id === d.id)!; if (!Number.isFinite(d.score) || d.score < pd.min || d.score > pd.max || (d.score * 2) % 1 !== 0) throw new BadRequestException(`${d.id}: score must be ${pd.min}..${pd.max} in 0.5 steps`); }
    if (!reason?.trim()) throw new BadRequestException('reason required');
    const sc = computeScore(policy, dims); const late = latePenalty(policy.lateRule, sub.createdAt, await this.extensionHours(tx, sub.entitlementId, sub.topicId));
    const fin = applyPenalty(sc.rawPercent, late.penaltyPercent);
    return tx.gradeRecord.create({ data: { submissionId: sub.id, seq, kind, dimensions: dims.map((d) => ({ id: d.id, score: d.score, max: policy.dimensions.find((x) => x.id === d.id)!.max, rationale: d.rationale ?? '', evidence: [], confidence: 1, source: 'human' })) as any,
      rawPercent: sc.rawPercent, latePenaltyPercent: late.penaltyPercent, finalPercent: fin, passed: fin >= policy.passPercent && !sc.disqualified.length, feedback: feedback ?? '', createdById: actor.id, reason } });
  }

  private async taskContext(tx: Prisma.TransactionClient, taskId: string, actor: Actor, requireClaim = true) {
    const t = await tx.moderationTask.findUnique({ where: { id: taskId } });
    if (!t) throw new NotFoundException();
    if (requireClaim && (t.status !== 'CLAIMED' || t.claimedById !== actor.id)) throw new ConflictException('claim the task first');
    const sub = await tx.submission.findUniqueOrThrow({ where: { id: t.submissionId } });
    const sg = await tx.submissionGrade.findUniqueOrThrow({ where: { submissionId: sub.id } });
    const asg = await tx.assignment.findUniqueOrThrow({ where: { id: sub.assignmentId } });
    return { t, sub, sg, policy: await this.policyFor(asg) };
  }

  async claim(taskId: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.moderationTask.findUnique({ where: { id: taskId } });
      if (!t) throw new NotFoundException();
      if (t.excludedModeratorId === actor.id) throw new ForbiddenException('conflict of interest: you graded this submission originally');
      const r = await tx.moderationTask.updateMany({ where: { id: taskId, status: 'OPEN' }, data: { status: 'CLAIMED', claimedById: actor.id } });
      if (!r.count) throw new ConflictException('task already claimed or done');
      return { ok: true };
    });
  }

  async decide(taskId: string, actor: Actor, b: { dimensions: HumanDim[]; feedback?: string; reason: string; integrityOutcome?: string; outcome?: string; confirmAi?: boolean }) {
    return this.prisma.$transaction(async (tx) => {
      const { t, sub, sg, policy } = await this.taskContext(tx, taskId, actor);
      const prev = sg.currentSeq ? await tx.gradeRecord.findUnique({ where: { submissionId_seq: { submissionId: sub.id, seq: sg.currentSeq } } }) : null;
      let dims = b.dimensions;
      if (b.confirmAi) { if (!prev || prev.kind !== 'AI') throw new ConflictException('no AI grade to confirm'); dims = (prev.dimensions as any[]).map((d) => ({ id: d.id, score: d.score, rationale: d.rationale })); }
      const integrityReasons = (t.reasons as string[]).filter((r) => r.startsWith('integrity:'));
      if (t.kind === 'BLOCKING' && integrityReasons.length && !['CLEARED', 'CONFIRMED_CONCERN'].includes(b.integrityOutcome ?? '')) throw new BadRequestException('integrityOutcome CLEARED|CONFIRMED_CONCERN is required: a human must decide on integrity flags');
      if (t.kind === 'APPEAL' && !['UPHELD', 'ADJUSTED'].includes(b.outcome ?? '')) throw new BadRequestException('outcome UPHELD|ADJUSTED required for appeals');
      const kind = t.kind === 'APPEAL' ? 'APPEAL' : 'MODERATED';
      const seq = (await tx.gradeRecord.aggregate({ _max: { seq: true }, where: { submissionId: sub.id } }))._max.seq ?? 0;
      const rec = await this.humanRecord(tx, sub, policy, actor, kind, dims, b.feedback ?? prev?.feedback ?? '', b.reason, seq + 1);
      if (t.kind === 'APPEAL' && b.outcome === 'UPHELD' && prev && Math.abs(prev.rawPercent - rec.rawPercent) > 0.01) throw new ConflictException('UPHELD means the grade is unchanged; use ADJUSTED');
      const now = new Date();
      const state = t.kind === 'APPEAL' ? 'FINAL' : 'GRADED';
      await tx.submissionGrade.update({ where: { submissionId: sub.id }, data: { state, currentSeq: rec.seq, finalPercent: rec.finalPercent, passed: rec.passed, humanPercent: rec.rawPercent, ...(b.integrityOutcome ? { integrityOutcome: b.integrityOutcome } : {}),
        ...(t.kind === 'BLOCKING' ? { releasedAt: now, appealDeadline: new Date(now.getTime() + policy.appealWindowDays * 86_400_000) } : {}) } });
      await tx.moderationTask.update({ where: { id: t.id }, data: { status: 'DONE', completedAt: now, outcome: b.outcome ?? (b.confirmAi ? 'CONFIRMED_AI' : prev && Math.abs(prev.rawPercent - rec.rawPercent) > 0.01 ? 'ADJUSTED' : 'CONFIRMED') } });
      await this.audit.record(tx, { actor, action: t.kind === 'APPEAL' ? 'grade.appeal_decided' : 'grade.moderated', objectType: 'Submission', objectId: sub.id, before: { percent: prev?.finalPercent ?? null, kind: prev?.kind ?? null }, after: { percent: rec.finalPercent, passed: rec.passed, integrityOutcome: b.integrityOutcome ?? null, outcome: b.outcome ?? null }, reason: b.reason });
      if (b.integrityOutcome === 'CONFIRMED_CONCERN') {
        await this.audit.record(tx, { actor, action: 'integrity.concern_confirmed', objectType: 'Submission', objectId: sub.id, reason: b.reason });
        for (const u of await tx.userRole.findMany({ where: { role: 'ACADEMIC_ADMIN' }, select: { userId: true }, distinct: ['userId'] })) await this.notes.notify(tx, u.userId, 'integrity.concern_confirmed', { submissionId: sub.id });
      }
      await this.notes.notify(tx, sub.learnerId, t.kind === 'APPEAL' ? 'assignment.appeal_decided' : 'assignment.graded', { submissionId: sub.id, topicId: sub.topicId, percent: rec.finalPercent, passed: rec.passed });
      await this.maybeUnlock(tx, sub, policy, rec.passed, true);
      return { state, finalPercent: rec.finalPercent, passed: rec.passed, seq: rec.seq };
    });
  }

  async appeal(submissionId: string, actor: Actor, reason: string) {
    if (!reason || reason.trim().length < 20) throw new BadRequestException('explain your appeal in at least 20 characters');
    return this.prisma.$transaction(async (tx) => {
      const sg = await tx.submissionGrade.findFirst({ where: { submissionId, learnerId: actor.id } });
      if (!sg) throw new NotFoundException();
      if (sg.state !== 'GRADED') throw new ConflictException(sg.state === 'APPEALED' || sg.appealCount > 0 ? 'this grade has already been appealed' : `a grade in state ${sg.state} cannot be appealed`);
      if (sg.appealCount > 0) throw new ConflictException('this grade has already been appealed');
      if (!sg.appealDeadline || sg.appealDeadline < new Date()) throw new ConflictException('appeal window has closed');
      const lastHuman = await tx.gradeRecord.findFirst({ where: { submissionId, kind: 'MODERATED' }, orderBy: { seq: 'desc' } });
      await tx.submissionGrade.update({ where: { submissionId }, data: { state: 'APPEALED', appealCount: { increment: 1 } } });
      const t = await tx.moderationTask.create({ data: { submissionId, kind: 'APPEAL', reasons: [`appeal: ${reason.trim().slice(0, 1000)}`] as any, excludedModeratorId: lastHuman?.createdById ?? null } });
      await this.audit.record(tx, { actor, action: 'grade.appealed', objectType: 'Submission', objectId: submissionId, reason });
      return { taskId: t.id, state: 'APPEALED' };
    });
  }

  // Maker-checker overrides (build prompt: grading overrides need two people and an immutable trail)
  async proposeOverride(submissionId: string, actor: Actor, b: { dimensions: HumanDim[]; feedback?: string; reason: string }) {
    return this.prisma.$transaction(async (tx) => {
      const { sub, sg, policy } = await this.byWithPolicy(tx, submissionId);
      if (sg.state === 'PENDING_AI') throw new ConflictException('not graded yet');
      // validate now so a bad proposal fails early
      const ids = new Set(policy.dimensions.map((d) => d.id));
      if (!Array.isArray(b.dimensions) || b.dimensions.length !== ids.size || b.dimensions.some((d) => !ids.has(d.id))) throw new BadRequestException('dimensions must contain every rubric dimension exactly once');
      if (!b.reason?.trim()) throw new BadRequestException('reason required');
      const o = await tx.gradeOverride.create({ data: { submissionId, proposedById: actor.id, dimensions: b.dimensions as any, feedback: b.feedback ?? '', reason: b.reason } });
      await this.audit.record(tx, { actor, action: 'grade.override_proposed', objectType: 'Submission', objectId: submissionId, after: { overrideId: o.id }, reason: b.reason });
      void sub; return o;
    });
  }
  private async byWithPolicy(tx: Prisma.TransactionClient, submissionId: string) {
    const sub = await tx.submission.findUnique({ where: { id: submissionId } });
    if (!sub) throw new NotFoundException();
    const sg = await tx.submissionGrade.findUniqueOrThrow({ where: { submissionId } });
    return { sub, sg, policy: await this.policyFor(await tx.assignment.findUniqueOrThrow({ where: { id: sub.assignmentId } })) };
  }
  async decideOverride(id: string, actor: Actor, decision: string, reason?: string) {
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new BadRequestException('decision APPROVE|REJECT');
    if (decision === 'REJECT' && !reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.gradeOverride.findUnique({ where: { id } });
      if (!o) throw new NotFoundException();
      if (o.status !== 'PENDING') throw new ConflictException(`override is ${o.status}`);
      if (o.proposedById === actor.id) throw new ConflictException('segregation of duties: the proposer cannot approve their own override');
      const { sub, sg, policy } = await this.byWithPolicy(tx, o.submissionId);
      let out: any = { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
      if (decision === 'APPROVE') {
        const seq = (await tx.gradeRecord.aggregate({ _max: { seq: true }, where: { submissionId: sub.id } }))._max.seq ?? 0;
        const prev = sg.currentSeq ? await tx.gradeRecord.findUnique({ where: { submissionId_seq: { submissionId: sub.id, seq: sg.currentSeq } } }) : null;
        const rec = await this.humanRecord(tx, sub, policy, { id: o.proposedById, roles: ['ASSESSMENT_ADMIN'] }, 'OVERRIDE', o.dimensions as any, o.feedback, `${o.reason} (approved by ${actor.id})`, seq + 1);
        await tx.submissionGrade.update({ where: { submissionId: sub.id }, data: { currentSeq: rec.seq, finalPercent: rec.finalPercent, passed: rec.passed, humanPercent: rec.rawPercent, releasedAt: sg.releasedAt ?? new Date(), state: sg.state === 'MODERATION_REQUIRED' || sg.state === 'APPEALED' ? 'FINAL' : sg.state } });
        await tx.moderationTask.updateMany({ where: { submissionId: sub.id, status: { in: ['OPEN', 'CLAIMED'] } }, data: { status: 'DONE', completedAt: new Date(), outcome: 'OVERRIDDEN' } });
        await this.notes.notify(tx, sub.learnerId, 'assignment.graded', { submissionId: sub.id, topicId: sub.topicId, percent: rec.finalPercent, passed: rec.passed });
        await this.maybeUnlock(tx, sub, policy, rec.passed, true);
        out = { ...out, finalPercent: rec.finalPercent, passed: rec.passed, before: prev?.finalPercent ?? null };
      }
      await tx.gradeOverride.update({ where: { id }, data: { status: out.status, decidedById: actor.id, decisionReason: reason, decidedAt: new Date() } });
      await this.audit.record(tx, { actor, action: `grade.override_${decision === 'APPROVE' ? 'approved' : 'rejected'}`, objectType: 'Submission', objectId: o.submissionId, before: { percent: out.before ?? null }, after: { percent: out.finalPercent ?? null }, reason: reason ?? o.reason });
      return out;
    });
  }

  /** Appeal windows close; submissions stuck forever never exist. */
  async sweep(now = new Date()) {
    const r = await this.prisma.submissionGrade.updateMany({ where: { state: 'GRADED', appealDeadline: { lt: now } }, data: { state: 'FINAL' } });
    return { finalised: r.count };
  }

  // ---- learner-facing view: hides AI output while a human is still deciding, and every integrity signal always ------------------
  async learnerView(sg: any, policy: Policy) {
    const base = { submissionId: sg.submissionId, topicId: sg.topicId, state: sg.state };
    if (sg.state === 'PENDING_AI') return { ...base, message: 'Your submission is being evaluated.' };
    if (sg.state === 'MODERATION_REQUIRED') return { ...base, message: 'Your submission is being reviewed by a teacher.' };
    const rec = await this.prisma.gradeRecord.findUnique({ where: { submissionId_seq: { submissionId: sg.submissionId, seq: sg.currentSeq } } });
    if (!rec) return { ...base, message: 'Your submission is being reviewed by a teacher.' };
    const dims = (rec.dimensions as any[]).map((d) => ({ id: d.id, name: policy.dimensions.find((x) => x.id === d.id)?.name, score: d.score, max: d.max, rationale: d.rationale, evidence: (d.evidence ?? []).filter((e: any) => e.verified && e.location !== 'tests').map((e: any) => ({ quote: e.quote, location: e.location })) }));
    return { ...base, finalPercent: rec.finalPercent, rawPercent: rec.rawPercent, latePenaltyPercent: rec.latePenaltyPercent, passed: rec.passed, passMark: policy.passPercent, dimensions: dims, feedback: rec.feedback,
      gradedBy: rec.kind === 'AI' ? 'AI (automated)' : 'Teacher', appeal: { eligible: sg.state === 'GRADED' && sg.appealCount === 0 && !!sg.appealDeadline && sg.appealDeadline > new Date(), deadline: sg.appealDeadline, appealed: sg.appealCount > 0 } };
  }
}

function sha256buf(b: Buffer) { return createHash('sha256').update(b).digest('hex'); }
export { canonical };
