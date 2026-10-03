import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { PrismaService, ReadDb } from '../common/prisma.service';
import { Actor, CurrentActor, Roles } from '../common/auth';
import { need } from '../common/http';
import { AuditService } from '../audit';
import { ConfigService } from '../ai/config';
import { computeScore, normalizePolicy, validatePolicy } from '../domain/grading';
import { extractSubmission } from './extract';
import { GradingService, learnerRef } from './grading';

const MODERATE = ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN'];
const ADMINS = ['ASSESSMENT_ADMIN', 'ACADEMIC_ADMIN'];
const OVERSEE = [...ADMINS, 'AUDITOR', 'PLATFORM_ADMIN'];
const WRITERS = ['ACADEMIC_ADMIN', 'CONTENT_AUTHOR'];

@Controller('v1')
export class GradingController {
  constructor(private svc: GradingService, private prisma: PrismaService, private read: ReadDb, private audit: AuditService, private config: ConfigService) {}

  // ---- learner ---------------------------------------------------------------------------------------------------------------
  @Get('me/submissions') @Roles('LEARNER')
  async mine(@Query('topicId') topicId: string | undefined, @CurrentActor() a: Actor) {
    const rows = await this.prisma.submissionGrade.findMany({ where: { learnerId: a.id, ...(topicId && { topicId }) }, orderBy: { createdAt: 'desc' }, take: 100 });
    const subs = new Map((await this.prisma.submission.findMany({ where: { id: { in: rows.map((r) => r.submissionId) } }, select: { id: true, attemptNo: true, createdAt: true } })).map((s) => [s.id, s]));
    return rows.map((r) => ({ submissionId: r.submissionId, topicId: r.topicId, attemptNo: subs.get(r.submissionId)?.attemptNo, submittedAt: subs.get(r.submissionId)?.createdAt, state: r.state,
      ...(['GRADED', 'FINAL'].includes(r.state) ? { finalPercent: r.finalPercent, passed: r.passed } : {}) }));
  }

  @Get('me/submissions/:id') @Roles('LEARNER')
  async mineOne(@Param('id') id: string, @CurrentActor() a: Actor) {
    const sg = await this.prisma.submissionGrade.findFirst({ where: { submissionId: id, learnerId: a.id } });
    if (!sg) throw new NotFoundException();
    const asg = await this.prisma.assignment.findUniqueOrThrow({ where: { id: sg.assignmentId } });
    return this.svc.learnerView(sg, await this.svc.policyFor(asg));
  }

  @Post('me/submissions/:id/appeal') @Roles('LEARNER')
  appeal(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.appeal(id, a, b?.reason); }

  // ---- rubric / policy authoring (ASN-002) -----------------------------------------------------------------------------------------
  @Get('authoring/topics/:id/assignment-policy') @Roles(...WRITERS, 'FACULTY_REVIEWER', 'ASSESSMENT_ADMIN', 'AUDITOR')
  async getPolicy(@Param('id') id: string) {
    const a = await this.prisma.assignment.findUnique({ where: { topicId: id } });
    if (!a) throw new NotFoundException('no assignment on this topic');
    const p = await this.svc.policyFor(a); return { policy: p, issues: validatePolicy(p) };
  }

  @Put('authoring/topics/:id/assignment-policy') @Roles(...WRITERS, 'ASSESSMENT_ADMIN')
  async setPolicy(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const asg = await tx.assignment.findUnique({ where: { topicId: id }, include: { topic: { include: { module: { include: { version: true } } } } } });
      if (!asg) throw new NotFoundException('no assignment on this topic');
      const v = asg.topic.module.version;
      if (v.state !== 'DRAFT') throw new ConflictException(`version is ${v.state}; policy is frozen`);
      if (v.authorId !== a.id && !a.roles.some((r) => ADMINS.includes(r))) throw new ForbiddenException();
      const p = normalizePolicy({ ...(asg.policy as object), ...(b ?? {}) }, asg.rubric, await this.svc.defaults());
      const issues = validatePolicy(p);
      if (issues.length) throw new BadRequestException({ error: 'invalid_policy', issues });
      await tx.assignment.update({ where: { id: asg.id }, data: { policy: p as any } }); // stored fully-resolved: version-pinned, defaults frozen
      await this.audit.record(tx, { actor: a, action: 'assignment.policy_set', objectType: 'Assignment', objectId: asg.id, after: { unlockOn: p.unlockOn, passPercent: p.passPercent, dims: p.dimensions.map((d) => d.id), highStakes: p.highStakes } });
      return { policy: { ...p, referenceEvidence: p.referenceEvidence ? '[set]' : undefined } };
    });
  }

  // ---- moderation queue (ASN-004) -------------------------------------------------------------------------------------------------------
  @Get('moderation/queue') @Roles(...MODERATE, ...OVERSEE)
  async queue(@Query('kind') kind: string | undefined, @Query('status') status: string | undefined, @Query('mine') mine: string | undefined, @CurrentActor() a: Actor) {
    const rows = await this.prisma.moderationTask.findMany({ where: { ...(kind && { kind }), status: status ?? 'OPEN', ...(mine === 'true' && { claimedById: a.id }), ...(!a.roles.some((r) => OVERSEE.includes(r)) ? { OR: [{ excludedModeratorId: null }, { excludedModeratorId: { not: a.id } }] } : {}) }, orderBy: { createdAt: 'asc' }, take: 200 });
    const sgs = new Map((await this.prisma.submissionGrade.findMany({ where: { submissionId: { in: rows.map((r) => r.submissionId) } } })).map((s) => [s.submissionId, s]));
    return rows.map((t) => ({ taskId: t.id, kind: t.kind, status: t.status, reasons: t.reasons, ageMinutes: Math.round((Date.now() - t.createdAt.getTime()) / 60_000), submissionId: t.submissionId, learnerRef: learnerRef(sgs.get(t.submissionId)!.learnerId, t.submissionId), aiPercent: sgs.get(t.submissionId)?.aiPercent ?? null, claimedById: t.claimedById }));
  }

  @Post('moderation/tasks/:id/claim') @Roles(...MODERATE) claim(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.claim(id, a); }

  @Post('moderation/tasks/:id/release') @Roles(...MODERATE)
  async release(@Param('id') id: string, @CurrentActor() a: Actor) {
    const r = await this.prisma.moderationTask.updateMany({ where: { id, claimedById: a.id, status: 'CLAIMED' }, data: { status: 'OPEN', claimedById: null } });
    if (!r.count) throw new ConflictException('not your claimed task'); return { ok: true };
  }

  /** The case file: what the learner submitted, what the AI saw and said, every signal, and the history. Identities are pseudonymous. */
  @Get('moderation/tasks/:id') @Roles(...MODERATE, 'ASSESSMENT_ADMIN')
  async task(@Param('id') id: string, @CurrentActor() a: Actor) {
    const t = await this.prisma.moderationTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    if (t.claimedById !== a.id && !a.roles.includes('ASSESSMENT_ADMIN')) throw new ForbiddenException('claim the task to open the case file');
    if (t.excludedModeratorId === a.id) throw new ForbiddenException('conflict of interest');
    const [sub, sg] = await Promise.all([this.prisma.submission.findUniqueOrThrow({ where: { id: t.submissionId } }), this.prisma.submissionGrade.findUniqueOrThrow({ where: { submissionId: t.submissionId } })]);
    const asg = await this.prisma.assignment.findUniqueOrThrow({ where: { id: sub.assignmentId } });
    const [art, records, matches] = await Promise.all([this.prisma.submissionArtifact.findUnique({ where: { submissionId: sub.id } }),
      this.prisma.gradeRecord.findMany({ where: { submissionId: sub.id }, orderBy: { seq: 'asc' } }), this.prisma.similarityMatch.findMany({ where: { submissionId: sub.id }, orderBy: { score: 'desc' } })]);
    const others = await this.prisma.submissionArtifact.findMany({ where: { submissionId: { in: matches.map((m) => m.otherSubmissionId!).filter(Boolean) } } });
    return { task: t, learnerRef: learnerRef(sg.learnerId, sub.id), attemptNo: sub.attemptNo, submittedAt: sub.createdAt, assignment: { instructions: asg.instructions }, policy: await this.svc.policyFor(asg),
      submission: { text: art?.text ?? '', files: art?.files ?? [], contentHash: sub.contentHash, testResults: art?.testResults ?? null }, state: sg.state, reasons: sg.moderationReasons,
      records: records.map((r) => ({ seq: r.seq, kind: r.kind, dimensions: r.dimensions, rawPercent: r.rawPercent, latePenaltyPercent: r.latePenaltyPercent, finalPercent: r.finalPercent, passed: r.passed, confidence: r.confidence, flags: r.flags, feedback: r.feedback, model: r.model, promptVersion: r.promptVersion, samples: r.samples, createdById: r.createdById, reason: r.reason, at: r.createdAt })),
      similarity: matches.map((m) => ({ score: m.score, otherRef: learnerRef(m.otherSubmissionId ?? '', m.otherSubmissionId ?? ''), excerpt: (others.find((o) => o.submissionId === m.otherSubmissionId)?.text ?? '').slice(0, 600) })) };
  }

  @Post('moderation/tasks/:id/decide') @Roles(...MODERATE)
  decide(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { reason: 'string' }); return this.svc.decide(id, a, b); }

  // ---- overrides (maker-checker), manual completion, history, sweep --------------------------------------------------------------------------
  @Post('grading/submissions/:id/overrides') @Roles(...ADMINS)
  propose(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { dimensions: 'array', reason: 'string' }); return this.svc.proposeOverride(id, a, b); }
  @Post('grading/overrides/:id/decide') @Roles(...ADMINS)
  decideOv(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { decision: 'string' }); return this.svc.decideOverride(id, a, b.decision, b.reason); }
  /** Overrides with who proposed and decided them and what grade each concerns (newest first). `status` may list several, comma separated. */
  @Get('grading/overrides') @Roles(...OVERSEE)
  async overrides(@Query('status') status?: string) {
    const rows = await this.prisma.gradeOverride.findMany({ where: status ? { status: { in: status.split(',') } } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
    const subs = new Map((await this.prisma.submission.findMany({ where: { id: { in: rows.map((r) => r.submissionId) } }, select: { id: true, topicId: true, learnerId: true, attemptNo: true } })).map((x) => [x.id, x]));
    const topics = new Map((await this.prisma.topic.findMany({ where: { id: { in: [...new Set([...subs.values()].map((x) => x.topicId))] } }, select: { id: true, title: true } })).map((t) => [t.id, t.title]));
    const grades = new Map((await this.prisma.submissionGrade.findMany({ where: { submissionId: { in: rows.map((r) => r.submissionId) } }, select: { submissionId: true, finalPercent: true } })).map((g) => [g.submissionId, g.finalPercent]));
    const ids = [...new Set(rows.flatMap((r) => [r.proposedById, ...(r.decidedById ? [r.decidedById] : []), ...(subs.get(r.submissionId) ? [subs.get(r.submissionId)!.learnerId] : [])]))];
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => { const s = subs.get(r.submissionId); return { id: r.id, submissionId: r.submissionId, status: r.status, reason: r.reason, decisionReason: r.decisionReason, createdAt: r.createdAt, decidedAt: r.decidedAt, proposedById: r.proposedById, proposedByName: names.get(r.proposedById) ?? null, decidedByName: r.decidedById ? names.get(r.decidedById) ?? null : null, topic: s ? topics.get(s.topicId) ?? null : null, learnerName: s ? names.get(s.learnerId) ?? null : null, attemptNo: s?.attemptNo ?? null, currentPercent: grades.get(r.submissionId) ?? null }; });
  }
  @Get('grading/overrides/:id') @Roles(...OVERSEE) overrideCase(@Param('id') id: string) { return this.svc.overrideCase(id); }

  /** Find a learner's graded work, to review its history or propose an override. A learner is required: this is not a browse-everything list. */
  @Get('grading/submissions') @Roles(...OVERSEE)
  async findSubmissions(@Query('learnerId') learnerId: string) {
    if (!learnerId) throw new BadRequestException('learnerId required');
    const grades = await this.prisma.submissionGrade.findMany({ where: { learnerId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const subs = new Map((await this.prisma.submission.findMany({ where: { id: { in: grades.map((g) => g.submissionId) } }, select: { id: true, attemptNo: true, createdAt: true } })).map((s) => [s.id, s]));
    const topics = new Map((await this.prisma.topic.findMany({ where: { id: { in: [...new Set(grades.map((g) => g.topicId))] } }, select: { id: true, title: true, module: { select: { version: { select: { programme: { select: { code: true, title: true } } } } } } } })).map((t) => [t.id, t]));
    return grades.map((g) => { const t = topics.get(g.topicId); return { submissionId: g.submissionId, topic: t?.title ?? null, programme: t ? `${t.module.version.programme.title} (${t.module.version.programme.code})` : null, attemptNo: subs.get(g.submissionId)?.attemptNo ?? null, submittedAt: subs.get(g.submissionId)?.createdAt ?? null, state: g.state, finalPercent: g.finalPercent, passed: g.passed }; });
  }

  /** MANUAL unlock rule: an authorised person marks the assignment condition satisfied. Always audited with a reason. */
  @Post('grading/submissions/:id/complete') @Roles(...ADMINS)
  async complete(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { reason: 'string' });
    return this.prisma.$transaction(async (tx) => {
      const sub = await tx.submission.findUnique({ where: { id } });
      if (!sub) throw new NotFoundException();
      await this.svc.setAssignmentCondition(tx, sub);
      await this.audit.record(tx, { actor: a, action: 'assignment.manually_completed', objectType: 'Submission', objectId: id, reason: b.reason });
      return { ok: true };
    });
  }

  @Get('grading/submissions/:id/history') @Roles(...OVERSEE, 'FACULTY_REVIEWER')
  async history(@Param('id') id: string) {
    const sub = await this.prisma.submission.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException();
    const asgn = await this.prisma.assignment.findUniqueOrThrow({ where: { id: sub.assignmentId } }); const policy = await this.svc.policyFor(asgn);
    const topic = await this.prisma.topic.findUnique({ where: { id: sub.topicId }, select: { title: true } }); const learner = await this.prisma.user.findUnique({ where: { id: sub.learnerId }, select: { name: true } });
    return { submission: { id, attemptNo: sub.attemptNo, submittedAt: sub.createdAt, contentHash: sub.contentHash, topic: topic?.title ?? null, learnerName: learner?.name ?? null }, policy: { passPercent: policy.passPercent, unlockOn: policy.unlockOn, dimensions: policy.dimensions.map((d) => ({ id: d.id, name: d.name, min: d.min, max: d.max, weight: d.weight })) }, grade: await this.prisma.submissionGrade.findUnique({ where: { submissionId: id } }),
      records: await this.prisma.gradeRecord.findMany({ where: { submissionId: id }, orderBy: { seq: 'asc' } }), tasks: await this.prisma.moderationTask.findMany({ where: { submissionId: id }, orderBy: { createdAt: 'asc' } }), overrides: await this.prisma.gradeOverride.findMany({ where: { submissionId: id } }) };
  }

  @Post('grading/sweep') @Roles(...ADMINS) sweep() { return this.svc.sweep(); }

  // ---- grader benchmark vs human scores (TRD: human agreement study; Gate: agreement within tolerance) ------------------------------------------------
  @Post('grading/benchmark') @Roles(...ADMINS)
  async benchmark(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { topicId: 'string', cases: 'array' });
    if (!b.cases.length || b.cases.length > 50) throw new BadRequestException('1..50 cases');
    const asg = await this.prisma.assignment.findUnique({ where: { topicId: b.topicId } });
    if (!asg) throw new NotFoundException('assignment');
    const policy = await this.svc.policyFor(asg);
    let prompt: any;
    if (b.promptId) { const p = await this.prisma.promptTemplate.findUnique({ where: { id: b.promptId } }); if (!p || p.key !== 'grader') throw new BadRequestException('promptId must be a grader prompt'); prompt = { system: p.system, user: p.user, key: 'grader', version: p.version, hash: p.hash, schemaName: p.schemaName }; }
    const tol = await this.config.get<number>('grading.agreement_tolerance_pct'), minAgree = await this.config.get<number>('grading.min_agreement');
    const rows: { name: string; ai: number | null; human: number; diff: number | null; agree: boolean; error?: string; perDimension?: Record<string, number> }[] = [];
    const dimErr = new Map<string, number[]>();
    for (const c of b.cases) {
      const human = computeScore(policy, policy.dimensions.map((d) => ({ id: d.id, score: Number(c.human?.[d.id]) })));
      try {
        const r = await this.svc.evaluate({ policy, instructions: asg.instructions, extracted: extractSubmission(String(c.text ?? ''), []), language: c.language === 'hi' ? 'hi' : 'en', actorId: a.id, automated: { tests: 'not run' }, prompt });
        const ai = computeScore(policy, r.dims.map((d) => ({ id: d.id, score: d.score })));
        const diff = Math.round((ai.rawPercent - human.rawPercent) * 100) / 100;
        const per: Record<string, number> = {};
        for (const d of policy.dimensions) { const e = Math.abs(((r.dims.find((x) => x.id === d.id)!.score - Number(c.human[d.id])) / (d.max - d.min)) * 100); per[d.id] = e; dimErr.set(d.id, [...(dimErr.get(d.id) ?? []), e]); }
        rows.push({ name: c.name ?? `case ${rows.length + 1}`, ai: ai.rawPercent, human: human.rawPercent, diff, agree: Math.abs(diff) <= tol, perDimension: per });
      } catch (e: any) { rows.push({ name: c.name ?? `case ${rows.length + 1}`, ai: null, human: human.rawPercent, diff: null, agree: false, error: String(e?.message ?? e).slice(0, 200) }); }
    }
    const ok = rows.filter((r) => r.diff !== null);
    const agreement = rows.filter((r) => r.agree).length / rows.length;
    const mae = ok.length ? ok.reduce((s, r) => s + Math.abs(r.diff!), 0) / ok.length : null;
    const bias = ok.length ? ok.reduce((s, r) => s + r.diff!, 0) / ok.length : null;
    const pass = agreement >= minAgree;
    if (b.promptId) await this.prisma.promptTemplate.update({ where: { id: b.promptId }, data: { evalScore: pass ? 1 : agreement * 0.5, evalReport: { agreement, mae, bias, rows } as any } });
    const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
    return { pass, agreement: r2(agreement), tolerancePct: tol, minAgreement: minAgree, meanAbsErrorPct: r2(mae), biasPct: r2(bias), perDimensionMAE: Object.fromEntries([...dimErr].map(([k, v]) => [k, r2(v.reduce((s, x) => s + x, 0) / v.length)])), rows };
  }

  // ---- analytics (BRD: score distributions, rubric reliability, AI-human variance, similarity flags, appeals) -------------------------------------------
  @Get('reports/grading') @Roles(...OVERSEE)
  async report(@Query('versionId') versionId?: string, @Query('days') days = '30') {
    return this.read.run(async (db) => {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, Number(days) || 30)) * 86_400_000);
    const sgs = await db.submissionGrade.findMany({ where: { createdAt: { gte: since }, ...(versionId && { versionId }) }, take: 10_000 });
    const tol = await this.config.get<number>('grading.agreement_tolerance_pct');
    const ids = sgs.map((s) => s.submissionId);
    const recs = await db.gradeRecord.findMany({ where: { submissionId: { in: ids } }, orderBy: [{ submissionId: 'asc' }, { seq: 'asc' }] });
    const bySub = new Map<string, typeof recs>(); recs.forEach((r) => bySub.set(r.submissionId, [...(bySub.get(r.submissionId) ?? []), r]));
    const pairs = sgs.filter((s) => s.aiPercent !== null && s.humanPercent !== null);
    const diffs = pairs.map((s) => s.humanPercent! - s.aiPercent!);
    const dim = new Map<string, number[]>();
    for (const s of pairs) { const rs = bySub.get(s.submissionId) ?? []; const ai = rs.find((r) => r.kind === 'AI'); const hu = [...rs].reverse().find((r) => r.kind !== 'AI'); if (!ai || !hu) continue;
      for (const d of ai.dimensions as any[]) { const h = (hu.dimensions as any[]).find((x) => x.id === d.id); if (h) dim.set(d.id, [...(dim.get(d.id) ?? []), Math.abs(((d.score - h.score) / d.max) * 100)]); } }
    const mod = sgs.filter((s) => (s.moderationReasons as string[]).length > 0);
    const reasons = new Map<string, number>(); mod.forEach((s) => (s.moderationReasons as string[]).forEach((r) => { const k = r.split(':')[0] === 'integrity' ? r : r.split(':')[0]; reasons.set(k, (reasons.get(k) ?? 0) + 1); }));
    const appealed = sgs.filter((s) => s.appealCount > 0); const appealRecs = appealed.map((s) => (bySub.get(s.submissionId) ?? []).filter((r) => r.kind !== 'AI'));
    const overturned = appealed.filter((s, i) => { const r = appealRecs[i]; return r.length >= 2 && Math.abs(r[r.length - 1].rawPercent - r[r.length - 2].rawPercent) > 0.01; }).length;
    const finals = sgs.filter((s) => s.finalPercent !== null); const buckets = Array.from({ length: 10 }, (_, i) => finals.filter((s) => Math.min(9, Math.floor(s.finalPercent! / 10)) === i).length);
    const open = await db.moderationTask.findMany({ where: { status: { in: ['OPEN', 'CLAIMED'] } }, orderBy: { createdAt: 'asc' }, take: 500 });
    const pending = sgs.filter((s) => s.state === 'PENDING_AI');
    const r2 = (x: number) => Math.round(x * 100) / 100; const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const aiRecs = recs.filter((r) => r.kind === 'AI');
    const byModel = new Map<string, number>(); aiRecs.forEach((r) => { const k = `${r.model}@prompt${r.promptVersion}`; byModel.set(k, (byModel.get(k) ?? 0) + 1); });
    return { since, submissions: sgs.length, byState: Object.fromEntries(['PENDING_AI', 'MODERATION_REQUIRED', 'GRADED', 'APPEALED', 'FINAL'].map((k) => [k, sgs.filter((s) => s.state === k).length])),
      moderationRate: sgs.length ? r2(mod.length / sgs.length) : null, moderationReasons: Object.fromEntries(reasons),
      aiHumanAgreement: { pairs: pairs.length, tolerancePct: tol, agreementRate: pairs.length ? r2(diffs.filter((d) => Math.abs(d) <= tol).length / pairs.length) : null, meanAbsDiffPct: avg(diffs.map(Math.abs)), humanMinusAiBiasPct: avg(diffs), perDimensionMAEPct: Object.fromEntries([...dim].map(([k, v]) => [k, avg(v)])) },
      appeals: { appealed: appealed.length, rate: sgs.length ? r2(appealed.length / sgs.length) : null, overturned, overturnRate: appealed.length ? r2(overturned / appealed.length) : null },
      integrity: { flaggedSubmissions: sgs.filter((s) => (s.moderationReasons as string[]).some((r) => r.startsWith('integrity:'))).length, confirmedConcerns: sgs.filter((s) => s.integrityOutcome === 'CONFIRMED_CONCERN').length, cleared: sgs.filter((s) => s.integrityOutcome === 'CLEARED').length },
      scoreDistribution: buckets.map((n, i) => ({ range: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`, count: n })), avgAiConfidence: avg(aiRecs.map((r) => r.confidence ?? 0)), graderVersions: Object.fromEntries(byModel), costUsd: r2(aiRecs.reduce((s, r) => s + r.costUsd, 0) * 1e4) / 1e4,
      backlog: { pendingAi: pending.length, oldestPendingMinutes: pending.length ? Math.round((Date.now() - Math.min(...pending.map((p) => p.createdAt.getTime()))) / 60_000) : 0, openModeration: open.length, oldestModerationMinutes: open.length ? Math.round((Date.now() - open[0].createdAt.getTime()) / 60_000) : 0 } };
  });
  }
}
