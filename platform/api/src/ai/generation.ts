import { newTrace, runWithTrace } from '../platform/trace';
import { IntegrityService } from '../ops/integrity';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DoubtService } from '../doubts/doubts';
import { GradingService, Requeue } from '../grading/grading';
import { ExamOpsService } from '../exams/ops';
import { PrivacyService } from '../privacy/privacy';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor } from '../common/auth';
import { AuditService } from '../audit';
import { AuthoringService } from '../authoring';
import { ConfigService } from './config';
import { GatewayService, RunResult } from './gateway';
import { PromptRegistry, referencesBlock, render } from './prompts';
import { SCHEMAS } from './schemas';
import { TranscodeService } from '../media/transcode';
import { blocking, checkContent, checkCurriculum, ContentOut, CurriculumOut, Finding, judgeFindings, translationFindings } from './quality';

export interface Ref { id: string; title?: string; text: string }
class JobFailure extends Error { constructor(public code: string, msg: string, public detail?: unknown) { super(msg); } }

const asActor = (id: string): Actor => ({ id, roles: ['AI_GENERATED'] });
const j = (v: unknown) => JSON.stringify(v, null, 1);
const STRUCTURAL = new Set(['structure', 'assessment']);
/** The exact brief shape sent to the model: shared by production jobs and prompt evaluation so evals test what ships. */
export const briefJson = (b: any) => j({ title: b.title, discipline: b.discipline, audience: b.audience, durationType: b.durationType, totalHours: b.hours, outcomes: b.outcomes, prerequisites: b.prerequisites ?? [], languages: b.languages ?? ['en'], assessmentPolicy: b.assessmentPolicy, constraints: b.constraints });

@Injectable()
export class GenerationService {
  private log = new Logger('generation');
  constructor(private prisma: PrismaService, private gw: GatewayService, private prompts: PromptRegistry, private config: ConfigService, private authoring: AuthoringService, private audit: AuditService) {}

  // ---- model call helper (accumulates cost on the job) ----------------------------------------------------
  private async call<T>(job: { id: string; requestedById: string }, key: string, useCase: Parameters<GatewayService['run']>[0]['useCase'], vars: Record<string, string>, extraUser = '') {
    const p = await this.prompts.resolve(key);
    const r = await this.gw.run<T>({ useCase, system: p.system, user: render(p.user, vars) + extraUser, schema: SCHEMAS[p.schemaName], schemaName: p.schemaName, promptKey: key, promptVersion: p.version, jobId: job.id, actorId: job.requestedById });
    await this.prisma.generationJob.update({ where: { id: job.id }, data: { costUsd: { increment: r.costUsd } } });
    return { ...r, prompt: p };
  }

  private async saveFindings(tx: Prisma.TransactionClient, versionId: string, topicId: string | null, jobId: string, fs: Finding[]) {
    await tx.qualityFinding.updateMany({ where: { versionId, topicId, current: true }, data: { current: false } }); // superseded by the new run
    if (fs.length) await tx.qualityFinding.createMany({ data: fs.map((f) => ({ versionId, topicId, jobId, gate: f.gate, severity: f.severity, blocking: f.severity === 'FAIL', message: f.message, evidence: { sceneId: f.sceneId, ...(f.evidence ?? {}) } as any })) });
  }

  // ---- CURRICULUM -----------------------------------------------------------------------------------------
  async curriculum(job: { id: string; requestedById: string; input: any }) {
    const b = job.input;
    const tools = await this.config.get<string[]>('productivity_tools');
    const vars = { brief: briefJson(b), tools: j(tools), references: referencesBlock(b.references ?? []) };
    let r = await this.call<CurriculumOut>(job, 'curriculum', 'curriculum', vars);
    let findings = checkCurriculum(r.json, { hours: b.hours });
    if (findings.some(blocking)) { // one automated repair pass, then stop: never persist an invalid structure
      const fb = `\n\nYour previous output failed validation:\n- ${findings.filter(blocking).map((f) => f.message).join('\n- ')}\nReturn a corrected, complete curriculum.`;
      r = await this.call<CurriculumOut>(job, 'curriculum', 'curriculum', vars, fb);
      findings = checkCurriculum(r.json, { hours: b.hours });
    }
    if (findings.some(blocking)) throw new JobFailure('validation_failed', 'curriculum failed validation after repair', findings);

    const c = r.json;
    const lessonPlans = Object.fromEntries(c.modules.flatMap((m: any) => m.topics.map((t: any) => [t.title, { lesson_plan: t.lesson_plan, assessment_notes: t.assessment_notes }])));
    const provenance = { source: 'ai', generator: 'curriculum', jobId: job.id, provider: r.provider, model: r.model, promptKey: r.prompt.key, promptVersion: r.prompt.version, promptHash: r.prompt.hash,
      generatedAt: new Date().toISOString(), references: (b.references ?? []).map((x: Ref) => ({ id: x.id, title: x.title, sha256: createHash('sha256').update(x.text).digest('hex') })), brief: { title: b.title, hours: b.hours }, lessonPlans };
    const prog = b.programme;
    const existing = await this.prisma.programme.findUnique({ where: { code: prog.code } });
    if (!existing) {
      await this.prisma.$transaction(async (tx) => {
        const p = await tx.programme.create({ data: { code: prog.code, title: prog.title ?? b.title, discipline: prog.discipline ?? b.discipline } });
        await this.audit.record(tx, { actor: asActor(job.requestedById), action: 'programme.created', objectType: 'Programme', objectId: p.id, after: { code: p.code, via: 'ai_curriculum', jobId: job.id } });
      });
    }
    const v = await this.authoring.createVersion(prog.code, { hours: b.hours, outcomes: c.outcomes, languages: b.languages, provenance,
      modules: c.modules.map((m) => ({ title: m.title, topics: m.topics.map((t) => ({ title: t.title, hours: t.hours, outcomes: t.outcomes, prerequisites: t.prerequisites, mandatory: t.mandatory })) })) }, asActor(job.requestedById));
    await this.prisma.$transaction(async (tx) => {
      await this.saveFindings(tx, v.id, null, job.id, findings);
      await this.audit.record(tx, { actor: asActor(job.requestedById), action: 'ai.curriculum_generated', objectType: 'ProgrammeVersion', objectId: v.id, after: { jobId: job.id, model: r.model, provider: r.provider, promptVersion: r.prompt.version } });
    });
    return { versionId: v.id, modules: c.modules.length, topics: c.modules.reduce((s, m) => s + m.topics.length, 0), findings: findings.length, assumptions: (c as any).assumptions ?? [] };
  }

  // ---- TOPIC CONTENT (script/storyboard + quiz + assignment, EN then HI) ----------------------------------------
  async generateTopic(job: { id: string; requestedById: string; input: any }, opts: { persist: boolean } = { persist: true }) {
    const b = job.input;
    const topic = await this.prisma.topic.findUnique({ where: { id: b.topicId }, include: { module: { include: { version: { include: { programme: true } } } } } });
    if (!topic) throw new JobFailure('not_found', 'topic not found');
    const version = topic.module.version;
    if (opts.persist && version.state !== 'DRAFT') throw new JobFailure('not_draft', `version is ${version.state}`);
    const langs: string[] = b.languages ?? (version.languages as string[]);
    const refs: Ref[] = b.references ?? [];
    const glossary = await this.config.get<Record<string, string>>('ai.glossary');
    const prohibited = await this.config.get<string[]>('ai.prohibited_terms');
    const lesson = ((version.provenance as any)?.lessonPlans ?? {})[topic.title] ?? {};
    const outcomes = topic.outcomes as string[];
    const refBlock = referencesBlock(refs);
    const base = { topic: j({ title: topic.title, outcomes, hours: topic.hours, programme: version.programme.title }), lessonPlan: j(lesson), glossary: j(glossary), instruction: b.instruction ?? 'none', references: refBlock };

    const ctx = { languages: langs, refIds: refs.map((r) => r.id), refTexts: refs.map((r) => r.text), glossary, prohibited, outcomes };
    const merge = (en: any, hi?: any): ContentOut => ({ scenes: en.scenes.map((s: any) => ({ ...s, narration_hi: hi?.scenes?.find((x: any) => x.id === s.id)?.narration_hi })), quiz: en.quiz, assignment: en.assignment });

    // 1) English content, with one repair pass for structural defects
    let en = (await this.call<any>(job, 'topic_content', 'topic_content', base)).json;
    let first = checkContent(merge(en), { ...ctx, languages: ['en'] }).filter((f) => blocking(f) && STRUCTURAL.has(f.gate));
    if (first.length) {
      en = (await this.call<any>(job, 'topic_content', 'topic_content', base, `\n\nYour previous output failed validation:\n- ${first.map((f) => f.message).join('\n- ')}\nReturn the corrected, complete lesson.`)).json;
    }
    // 2) Hindi translation + fidelity judge
    let hi: any, trFindings: Finding[] = [];
    if (langs.includes('hi')) {
      const tr = await this.call<any>(job, 'translation', 'translation', { glossary: j(glossary), content: j({ scenes: en.scenes.map((s: any) => ({ id: s.id, narration: s.narration_en, on_screen_text: s.on_screen_text, audio_description: s.audio_description, interaction_prompts: s.interactions.map((i: any) => i.prompt) })), quiz: en.quiz.map((q: any) => ({ text: q.text, options: q.options, rationale: q.rationale })), assignment_instructions: en.assignment.instructions }) });
      hi = tr.json;
      const pairs = en.scenes.map((s: any) => ({ scene_id: s.id, en: s.narration_en, hi: hi.scenes.find((x: any) => x.id === s.id)?.narration_hi ?? '' }));
      const jt = await this.call<any>(job, 'judge_translation', 'judge', { pairs: j(pairs) });
      trFindings = translationFindings(jt.json);
    }
    // 3) Grounding judge against the supplied references (unsupported claims block until a human resolves them)
    let judge: Finding[] = [];
    if (refs.length) {
      const jc = await this.call<any>(job, 'judge_content', 'judge', { content: j(en.scenes.map((s: any) => ({ scene_id: s.id, narration: s.narration_en, on_screen_text: s.on_screen_text }))), references: refBlock });
      judge = judgeFindings(jc.json);
    } else judge = [{ gate: 'citations', severity: 'WARN', message: 'no references supplied: content is ungrounded and needs full human fact-check' }];

    const content = merge(en, hi);
    const findings = [...checkContent(content, ctx), ...trFindings, ...judge];
    const manifest = this.toManifest(topic, langs, glossary, content, hi);
    const summary = { scenes: content.scenes.length, questions: content.quiz.length, findings: findings.length, blocking: findings.filter(blocking).length };
    if (!opts.persist) return { findings, manifest, summary };

    const last = await this.prisma.generationJob.findUnique({ where: { id: job.id } });
    if (last?.status === 'CANCELLED') throw new JobFailure('cancelled', 'cancelled before persist');
    const gen = (await this.prisma.aiCall.findFirst({ where: { jobId: job.id, useCase: 'topic_content' }, orderBy: { createdAt: 'desc' } }));
    const prov = { source: 'ai', jobId: job.id, provider: gen?.provider, model: gen?.model, promptKey: 'topic_content', generatedAt: new Date().toISOString(), references: refs.map((r) => r.id), languages: langs };
    const rev = await this.prisma.$transaction(async (tx) => {
      const v = await tx.programmeVersion.findUniqueOrThrow({ where: { id: version.id } });
      if (v.state !== 'DRAFT') throw new JobFailure('not_draft', `version became ${v.state}`);
      const old = await tx.quiz.findUnique({ where: { topicId: topic.id } });
      if (old) { await tx.question.deleteMany({ where: { quizId: old.id } }); await tx.quiz.delete({ where: { id: old.id } }); }
      await tx.quiz.create({ data: { topicId: topic.id, questions: { create: content.quiz.map((q: any, i: number) => ({
        position: i + 1, type: q.type, text: q.text, options: q.options, answer: q.type === 'NUMERIC' ? q.answer_number : q.type === 'MCQ_SINGLE' ? q.answer_indexes[0] : q.answer_indexes,
        tolerance: q.tolerance ?? 0, points: q.points || 1, rationale: q.rationale, i18n: hi?.quiz?.[i] ? { hi: { text: hi.quiz[i].text_hi, options: hi.quiz[i].options_hi, rationale: hi.quiz[i].rationale_hi } } : {} })) } } });
      const asg = { instructions: content.assignment.instructions, rubric: { criteria: content.assignment.rubric }, i18n: hi?.assignment_instructions_hi ? { hi: { instructions: hi.assignment_instructions_hi } } : {} };
      await tx.assignment.upsert({ where: { topicId: topic.id }, update: asg, create: { topicId: topic.id, ...asg } });
      const rev = ((await tx.scriptManifest.aggregate({ _max: { rev: true }, where: { topicId: topic.id } }))._max.rev ?? 0) + 1;
      await tx.scriptManifest.create({ data: { topicId: topic.id, rev, manifest: manifest as any, provenance: prov, jobId: job.id } });
      await this.saveFindings(tx, version.id, topic.id, job.id, findings);
      await this.audit.record(tx, { actor: asActor(job.requestedById), action: 'ai.topic_content_generated', objectType: 'Topic', objectId: topic.id, after: { jobId: job.id, rev, ...summary } });
      return rev;
    });
    return { topicId: topic.id, manifestRev: rev, ...summary };
  }

  /** video_engine manifest format: scenes with per-language narration and branch maps. */
  private toManifest(topic: any, langs: string[], glossary: Record<string, string>, c: ContentOut, hi: any) {
    return { topic_id: topic.id, title: topic.title, languages: langs, glossary, outcomes: topic.outcomes,
      scenes: c.scenes.map((s) => ({ id: s.id, type: s.type, narration: { en: s.narration_en, ...(s.narration_hi ? { hi: s.narration_hi } : {}) },
        on_screen_text: s.on_screen_text, audio_description: s.audio_description, visual_prompt: s.visual_prompt, reference_image: null, duration_sec: s.duration_sec, sources: s.sources,
        interactions: s.interactions.map((i) => ({ kind: i.kind, at_sec: i.at_sec, prompt: i.prompt, branches: Object.fromEntries(i.options.map((o, k) => [o, i.branch_targets[k]]).filter(([, t]) => t)) })) })) };
  }

  // ---- golden-set evaluation of a prompt draft ---------------------------------------------------------------------
  async evaluatePrompt(promptId: string, actor: Actor, cases: any[]) {
    const p = await this.prisma.promptTemplate.findUnique({ where: { id: promptId } });
    if (!p) throw new NotFoundException();
    const results: { name: string; pass: boolean; detail: string }[] = [];
    for (const c of cases) {
      try {
        if (p.key === 'curriculum') {
          const b = c.brief; const tools = await this.config.get<string[]>('productivity_tools');
          const r: RunResult<CurriculumOut> = await this.gw.run({ useCase: 'evaluation', system: p.system, user: render(p.user, { brief: briefJson(b), tools: j(tools), references: '' }), schema: SCHEMAS.curriculum, schemaName: 'curriculum', promptKey: p.key, promptVersion: p.version, actorId: actor.id });
          const bad = checkCurriculum(r.json, { hours: c.expect.hours }).filter(blocking);
          results.push({ name: c.name, pass: !bad.length, detail: bad.map((f) => f.message).join('; ') });
        } else if (p.key === 'topic_content') {
          const glossary = await this.config.get<Record<string, string>>('ai.glossary');
          const refs: Ref[] = c.references;
          const r: RunResult<any> = await this.gw.run({ useCase: 'evaluation', system: p.system, user: render(p.user, { topic: j(c.topic), lessonPlan: '{}', glossary: j(glossary), instruction: 'none', references: referencesBlock(refs) }), schema: SCHEMAS.topic_content, schemaName: 'topic_content', promptKey: p.key, promptVersion: p.version, actorId: actor.id });
          const content: ContentOut = { scenes: r.json.scenes, quiz: r.json.quiz, assignment: r.json.assignment };
          const bad = checkContent(content, { languages: ['en'], refIds: refs.map((x) => x.id), refTexts: refs.map((x) => x.text), glossary: {}, prohibited: [], outcomes: c.topic.outcomes }).filter(blocking);
          results.push({ name: c.name, pass: !bad.length, detail: bad.map((f) => f.message).join('; ') });
        } else throw new BadRequestException(`no golden set for prompt key ${p.key}; only curriculum and topic_content prompts are promotable`);
      } catch (e: any) { if (e instanceof BadRequestException) throw e; results.push({ name: c.name, pass: false, detail: `error: ${e?.message ?? e}` }); }
    }
    const score = results.filter((x) => x.pass).length / (results.length || 1);
    await this.prisma.promptTemplate.update({ where: { id: promptId }, data: { evalScore: score, evalReport: results as any } });
    return { score, results };
  }
}

// ---- Worker: DB-backed queue, safe across multiple API instances (FOR UPDATE SKIP LOCKED) ----------------------------
@Injectable()
export class JobWorker implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('job-worker'); private timer?: NodeJS.Timeout; private busy = 0; private lastSweep = 0; private lastExamSweep = 0; private lastPrivacy = 0; private lastRetention = 0; private lastIntegrity = 0;
  constructor(private prisma: PrismaService, private gen: GenerationService, @Optional() private doubts?: DoubtService, @Optional() private grading?: GradingService, @Optional() private examOps?: ExamOpsService, @Optional() private privacy?: PrivacyService, @Optional() private integrity?: IntegrityService, @Optional() private transcode?: TranscodeService) {}

  onModuleInit() {
    // PROCESS_ROLE=api serves HTTP only; =worker (src/worker.ts) runs the queue and sweeps; =all (default, dev/small pilots) does both.
    if (process.env.AI_WORKER === '0' || process.env.NODE_ENV === 'test' || process.env.PROCESS_ROLE === 'api') return;
    this.timer = setInterval(() => void this.tick(), Number(process.env.AI_WORKER_POLL_MS ?? 2000));
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private tick() { return runWithTrace(newTrace({ correlationId: 'worker-tick' }), () => this.tickInner()); }
  private async tickInner() {
    const max = Number(process.env.AI_WORKER_CONCURRENCY ?? 3);
    while (this.busy < max && (await this.runOnce())) { /* keep claiming until empty or at capacity */ }
    if (this.examOps && Date.now() - this.lastExamSweep > 15_000) { this.lastExamSweep = Date.now(); await this.examOps.sweep().catch((e) => this.log.warn(`exam sweep failed: ${e?.message}`)); } // time-critical: every 15s
    if (this.privacy && Date.now() - this.lastPrivacy > 30_000) { this.lastPrivacy = Date.now(); await this.privacy.process().catch((e) => this.log.warn(`privacy processing failed: ${e?.message}`)); if (Date.now() - this.lastRetention > 24 * 3600_000) { this.lastRetention = Date.now(); await this.privacy.retention(false).catch((e) => this.log.warn(`retention failed: ${e?.message}`)); } }
    if (this.integrity && Date.now() - this.lastIntegrity > Number(process.env.INTEGRITY_CHECK_HOURS ?? 6) * 3_600_000) { this.lastIntegrity = Date.now(); await this.integrity.runScheduled().catch((e) => this.log.warn(`integrity check errored: ${e?.message}`)); }
    if (this.doubts && Date.now() - this.lastSweep > 60_000) { this.lastSweep = Date.now(); await this.doubts.sweep().catch((e) => this.log.warn(`doubt sweep failed: ${e?.message}`)); }
  }

  /** Claim and run one job. Returns false if the queue was empty. */
  runOnce(): Promise<boolean> { return runWithTrace(newTrace({ correlationId: 'worker-job' }), () => this.runOnceInner()); } // each claimed job is its own trace
  private async runOnceInner(): Promise<boolean> {
    // All times come from the app (UTC instants), never from SQL now(): Prisma stores timestamp-without-tz in UTC; SQL now() or a bare
    // Date parameter is compared in the DB session's local timezone, making delayed jobs look overdue. Convert explicitly.
    const now = new Date(), stale = new Date(now.getTime() - 15 * 60_000);
    // recover jobs stuck RUNNING (worker crashed): requeue up to 3 attempts, then fail
    await this.prisma.$executeRaw`UPDATE "GenerationJob" SET status='QUEUED' WHERE status='RUNNING' AND "startedAt" < (${stale} AT TIME ZONE 'UTC') AND attempts < 3`;
    await this.prisma.$executeRaw`UPDATE "GenerationJob" SET status='FAILED', error='worker lost after 3 attempts', "finishedAt"=(${now} AT TIME ZONE 'UTC') WHERE status='RUNNING' AND "startedAt" < (${stale} AT TIME ZONE 'UTC') AND attempts >= 3`;
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "GenerationJob" SET status='RUNNING', "startedAt"=(${now} AT TIME ZONE 'UTC'), attempts=attempts+1
      WHERE id = (SELECT id FROM "GenerationJob" WHERE status='QUEUED' AND ("runAfter" IS NULL OR "runAfter" <= (${now} AT TIME ZONE 'UTC')) ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`;
    if (!claimed.length) return false;
    this.busy++;
    try {
      const job = await this.prisma.generationJob.findUniqueOrThrow({ where: { id: claimed[0].id } });
      try {
        const result = job.kind === 'CURRICULUM' ? await this.gen.curriculum(job as any) : job.kind === 'GRADE_SUBMISSION' ? await this.grading!.grade(job as any) : job.kind === 'TRANSCODE' ? await this.transcode!.run(job as any) : await this.gen.generateTopic(job as any);
        await this.prisma.generationJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'SUCCEEDED', result: result as any, finishedAt: new Date(), versionId: (result as any).versionId ?? undefined } });
      } catch (e: any) {
        if (e instanceof Requeue) { // model unavailable: wait and retry instead of failing the learner's grade
          await this.prisma.generationJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'QUEUED', runAfter: new Date(Date.now() + e.delayMs), error: e.message.slice(0, 300) } });
          return true;
        }
        const detail = e instanceof JobFailure ? { code: e.code, detail: e.detail } : e?.getResponse?.() ?? {};
        this.log.warn(`job ${job.id} failed: ${e?.message}`);
        await this.prisma.generationJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: e instanceof JobFailure && e.code === 'cancelled' ? 'CANCELLED' : 'FAILED', error: String(e?.message ?? e).slice(0, 500), result: detail as any, finishedAt: new Date() } });
      }
    } finally { this.busy--; }
    return true;
  }
}
