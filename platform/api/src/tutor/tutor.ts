import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, Injectable, Logger, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, ReadDb } from '../common/prisma.service';
import { Actor, CurrentActor, Roles } from '../common/auth';
import { need } from '../common/http';
import { ConfigService } from '../ai/config';
import { GatewayService } from '../ai/gateway';
import { PromptRegistry, referencesBlock, render } from '../ai/prompts';
import { SCHEMAS } from '../ai/schemas';
import { DEFAULT_PROHIBITED, devanagariRatio, hasInjection } from '../ai/quality';
import { GRADED_REFUSAL, groundedness, isGradedQuestion, REFUSAL_DEFAULT, search, tokenize, UNAVAILABLE } from '../ai/retrieval';
import { ProgressionService } from '../learning';
import { hasLearningAccess } from '../domain/entitlement';
import { DoubtService } from '../doubts/doubts';
import { PrivacyService } from '../privacy/privacy';
import { ChunkMeta, TutorIndexService } from './tutor-index';

export const GROUND_MIN = 0.35;
type Lang = 'en' | 'hi';
type Status = 'ANSWERED' | 'UNSUPPORTED' | 'REFUSED' | 'UNAVAILABLE';
export interface Citation { n: number; title: string; kind: string; topicId: string | null; ref: string; snippet: string }
export interface PipelineIn {
  versionId: string; programmeId: string; allowedTopics: Set<string>; topicId?: string | null; topicTitle?: string; language: Lang; question: string;
  history: { role: string; content: string }[]; quizTexts: string[]; actorId: string; prompt?: { system: string; user: string; key: string; version: number; schemaName: string };
}
export interface PipelineOut { status: Status; answer: string; confidence?: string; citations: Citation[]; retrieved: { chunks: { id: string; ref: string; score: number }[]; withheldAnswer?: string }; groundedness?: number; safetyFlags: string[]; needsTeacher: boolean; provider?: string; model?: string; promptVersion?: number; costUsd: number }

const msg = (m: { en: string; hi: string }, l: Lang) => m[l];
const snippet = (s: string) => (s.length > 180 ? s.slice(0, 177) + '...' : s);

@Injectable()
export class TutorService {
  private log = new Logger('tutor');
  constructor(private prisma: PrismaService, private index: TutorIndexService, private gw: GatewayService, private prompts: PromptRegistry, private config: ConfigService, private prog: ProgressionService, private doubts: DoubtService, private privacy: PrivacyService) {}

  // ---- the grounded-answer pipeline (shared by live answers and the benchmark) -------------------------------------------
  async run(i: PipelineIn): Promise<PipelineOut> {
    const base: PipelineOut = { status: 'UNSUPPORTED', answer: '', citations: [], retrieved: { chunks: [] }, safetyFlags: [], needsTeacher: false, costUsd: 0 };
    // 1) assessment integrity: never answer graded questions
    if (isGradedQuestion(i.question, i.quizTexts)) return { ...base, status: 'REFUSED', answer: msg(GRADED_REFUSAL, i.language), safetyFlags: ['graded_question'] };

    // 2) strict retrieval: this course version (+ programme FAQs), and only topics the learner has unlocked
    const { ix, meta } = await this.index.load(i.versionId, i.programmeId);
    const allow = (c: { id: string }) => { const m = meta.get(c.id)!; return (m.kind === 'FAQ' ? m.programmeId === i.programmeId : m.versionId === i.versionId) && (!m.topicId || i.allowedTopics.has(m.topicId)); };
    const hits = search(ix, i.question, 6, { allow, queryEmbedding: await this.index.embedQuery(i.question) });
    const minRel = await this.config.get<number>('tutor.min_relevance');
    base.retrieved = { chunks: hits.map((h) => ({ id: h.id, ref: meta.get(h.id)!.ref, score: Math.round(h.score * 1000) / 1000 })) };
    const usable = hits.filter((h) => h.score >= minRel);
    // 3) no-answer path: not enough evidence -> do not call the model at all
    if (!usable.length) return { ...base, answer: msg(REFUSAL_DEFAULT, i.language), needsTeacher: true };

    const sources = usable.map((h, k) => ({ id: `S${k + 1}`, meta: meta.get(h.id) as ChunkMeta }));
    const p = i.prompt ?? { ...(await this.prompts.resolve('tutor')) };
    try {
      const r = await this.gw.run<{ answer: string; used_source_ids: string[]; confidence: 'low' | 'medium' | 'high'; needs_teacher: boolean }>({
        useCase: 'tutor', system: p.system, schema: SCHEMAS[p.schemaName], schemaName: p.schemaName, promptKey: p.key, promptVersion: (p as any).version, actorId: i.actorId,
        user: render(p.user, { language: i.language === 'hi' ? 'Hindi (Devanagari)' : 'English', topic: i.topicTitle ?? 'not specified',
          history: i.history.slice(-6).map((m) => `${m.role === 'LEARNER' ? 'Learner' : 'Tutor'}: ${m.content.slice(0, 600)}`).join('\n') || 'none',
          sources: referencesBlock(sources.map((s) => ({ id: s.id, title: s.meta.title, text: s.meta.text }))), question: i.question.replace(/<\/?learner_question>/gi, '[tag]') }) });
      const out: PipelineOut = { ...base, costUsd: r.costUsd, provider: r.provider, model: r.model, promptVersion: (p as any).version, needsTeacher: !!r.json.needs_teacher };
      // 4) citation validation: only ids we supplied, mapped back to real chunks
      const used = [...new Set((r.json.used_source_ids ?? []).filter((x) => sources.some((s) => s.id === x)))];
      if (used.length !== (r.json.used_source_ids ?? []).length) out.safetyFlags.push('invalid_citation');
      const cited = sources.filter((s) => used.includes(s.id));
      out.citations = cited.map((s, n) => ({ n: n + 1, title: s.meta.title, kind: s.meta.kind, topicId: s.meta.topicId, ref: s.meta.ref, snippet: snippet(s.meta.text) }));
      // 5) refusal conditions: no valid citation, model says it can't, or low confidence
      if (!cited.length || r.json.needs_teacher || r.json.confidence === 'low') return { ...out, status: 'UNSUPPORTED', answer: msg(REFUSAL_DEFAULT, i.language), citations: [], needsTeacher: true, retrieved: { ...base.retrieved, withheldAnswer: r.json.answer } };
      // 6) output safety (before anything else is trusted)
      const extra = await this.config.get<string[]>('ai.prohibited_terms');
      const low = r.json.answer.toLowerCase();
      if ([...DEFAULT_PROHIBITED, ...extra].some((t) => low.includes(t.toLowerCase())) || hasInjection(r.json.answer))
        return { ...out, status: 'REFUSED', answer: msg(REFUSAL_DEFAULT, i.language), citations: [], safetyFlags: [...out.safetyFlags, 'unsafe_output'], needsTeacher: true, retrieved: { ...base.retrieved, withheldAnswer: r.json.answer } };
      // 7) groundedness (same-script only: a Hindi answer over English sources cannot be compared lexically)
      const srcText = cited.map((s) => s.meta.text);
      const sameScript = (devanagariRatio(r.json.answer) > 0.5) === (devanagariRatio(srcText.join(' ')) > 0.5);
      if (sameScript) {
        out.groundedness = Math.round(groundedness(r.json.answer, srcText) * 100) / 100;
        if (out.groundedness < GROUND_MIN) return { ...out, status: 'UNSUPPORTED', answer: msg(REFUSAL_DEFAULT, i.language), citations: [], needsTeacher: true, safetyFlags: [...out.safetyFlags, 'low_groundedness'], retrieved: { ...base.retrieved, withheldAnswer: r.json.answer } };
      } else out.safetyFlags.push('groundedness_unchecked');
      return { ...out, status: 'ANSWERED', answer: r.json.answer, confidence: (out.groundedness ?? 1) < 0.6 ? 'medium' : r.json.confidence };
    } catch (e: any) {
      // AI down / off / limited: learning continues; offer search results and escalation (TRD resilience)
      if (!(e instanceof HttpException) && e?.name !== 'Error') this.log.warn(String(e));
      const fb = sources.slice(0, 3).map((s, n) => ({ n: n + 1, title: s.meta.title, kind: s.meta.kind, topicId: s.meta.topicId, ref: s.meta.ref, snippet: snippet(s.meta.text) }));
      return { ...base, status: 'UNAVAILABLE', answer: msg(UNAVAILABLE, i.language), citations: fb, safetyFlags: ['ai_unavailable'], needsTeacher: true };
    }
  }

  // ---- live Q&A -------------------------------------------------------------------------------------------------------
  private async entitlementFor(learnerId: string, entitlementId?: string, conv?: { entitlementId: string } | null) {
    const id = conv?.entitlementId ?? entitlementId;
    if (id) { const e = await this.prisma.entitlement.findFirst({ where: { id, learnerId } }); if (!e) throw new NotFoundException(); return e; }
    const active = (await this.prisma.entitlement.findMany({ where: { learnerId } })).filter((e) => hasLearningAccess(e, new Date()));
    if (!active.length) throw new ForbiddenException('entitlement not active');
    if (active.length > 1) throw new BadRequestException('entitlementId required when you have several active entitlements');
    return active[0];
  }

  async ask(a: Actor, b: { question: string; topicId?: string; conversationId?: string; entitlementId?: string }) {
    if (!(await this.privacy.hasConsent(a.id, 'AI_TUTOR'))) throw new ForbiddenException({ error: 'consent_required', purpose: 'AI_TUTOR', message: 'Please review and accept the AI tutor notice to use the tutor' });
    const q = (b.question ?? '').trim();
    if (q.length < 3 || q.length > 2000) throw new BadRequestException('question must be 3..2000 characters');
    const perMin = await this.config.get<number>('tutor.per_minute');
    if ((await this.prisma.tutorMessage.count({ where: { learnerId: a.id, role: 'LEARNER', createdAt: { gte: new Date(Date.now() - 60_000) } } })) >= perMin) throw new HttpException({ error: 'tutor_rate_limited', message: `max ${perMin} questions per minute` }, 429);

    const conv = b.conversationId ? await this.prisma.tutorConversation.findFirst({ where: { id: b.conversationId, learnerId: a.id } }) : null;
    if (b.conversationId && !conv) throw new NotFoundException('conversation');
    const ent = await this.entitlementFor(a.id, b.entitlementId, conv);
    if (!hasLearningAccess(ent, new Date())) throw new ForbiddenException('entitlement not active');
    const st = await this.prog.state(this.prisma, ent);
    const topicId = b.topicId ?? conv?.topicId ?? null;
    if (topicId && !st.unlocked.has(topicId)) throw new ForbiddenException('topic locked');
    const v = await this.prisma.programmeVersion.findUniqueOrThrow({ where: { id: ent.versionId } });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: a.id }, select: { language: true } });
    const language: Lang = user.language === 'hi' ? 'hi' : 'en';
    const topic = topicId ? st.rows.find((r) => r.topic.id === topicId)?.topic : undefined;
    if (topicId && !topic) throw new BadRequestException('topic not in your course');

    const ungraded = st.rows.filter((r) => r.has.quiz && !r.prog.quizPassed).map((r) => r.topic.id);
    const qs = ungraded.length ? await this.prisma.question.findMany({ where: { quiz: { topicId: { in: ungraded } } }, select: { text: true, i18n: true } }) : [];
    const history = conv ? await this.prisma.tutorMessage.findMany({ where: { conversationId: conv.id, learnerId: a.id }, orderBy: { createdAt: 'desc' }, take: 6 }) : [];

    const out = await this.run({ versionId: ent.versionId, programmeId: v.programmeId, allowedTopics: new Set(st.unlocked), topicId, topicTitle: topic?.title, language, question: q,
      history: history.reverse().map((m) => ({ role: m.role, content: m.content })), quizTexts: qs.flatMap((x) => [x.text, (x.i18n as any)?.hi?.text].filter(Boolean)), actorId: a.id });

    const saved = await this.prisma.$transaction(async (tx) => {
      const c = conv ?? await tx.tutorConversation.create({ data: { learnerId: a.id, entitlementId: ent.id, versionId: ent.versionId, topicId } });
      await tx.tutorMessage.create({ data: { conversationId: c.id, learnerId: a.id, role: 'LEARNER', content: q, topicId } });
      const m = await tx.tutorMessage.create({ data: { conversationId: c.id, learnerId: a.id, role: 'TUTOR', content: out.answer, status: out.status, confidence: out.confidence, citations: out.citations as any, retrieved: out.retrieved as any,
        groundedness: out.groundedness, safetyFlags: out.safetyFlags, provider: out.provider, model: out.model, promptVersion: out.promptVersion, costUsd: out.costUsd, topicId } });
      const streak = out.status === 'UNSUPPORTED' ? c.unsupportedStreak + 1 : out.status === 'ANSWERED' ? 0 : c.unsupportedStreak;
      const uc = await tx.tutorConversation.update({ where: { id: c.id }, data: { unsupportedStreak: streak } });
      return { c: uc, m };
    });

    // TUT-004: automatic escalation (repeated unsupported answers, or the model asked for a teacher after a refusal)
    let escalation: { suggested: boolean; ticketId?: string } = { suggested: out.needsTeacher || out.status === 'UNAVAILABLE' };
    if (escalation.suggested && !saved.c.ticketId && (await this.config.get<boolean>('tutor.auto_escalate')) && out.status !== 'REFUSED' && out.status !== 'UNAVAILABLE' && saved.c.unsupportedStreak >= 2) {
      try { const t = await this.escalate(a, saved.c.id, { auto: true }); escalation = { suggested: true, ticketId: t.id }; } catch (e: any) { this.log.warn(`auto-escalation failed: ${e?.message}`); }
    }
    return { conversationId: saved.c.id, messageId: saved.m.id, status: out.status, answer: out.answer, confidence: out.confidence ?? null, citations: out.citations, escalation };
  }

  async escalate(a: Actor, conversationId: string, o: { auto?: boolean; note?: string; category?: string } = {}) {
    const c = await this.prisma.tutorConversation.findFirst({ where: { id: conversationId, learnerId: a.id } });
    if (!c) throw new NotFoundException();
    if (c.ticketId) { const t = await this.prisma.doubtTicket.findUnique({ where: { id: c.ticketId } }); if (t && !['RESOLVED', 'CLOSED'].includes(t.status)) throw new ConflictException({ error: 'already_escalated', ticketId: t.id }); }
    const ent = await this.prisma.entitlement.findUniqueOrThrow({ where: { id: c.entitlementId } });
    if (!hasLearningAccess(ent, new Date())) throw new ForbiddenException('entitlement not active');
    const lastQ = await this.prisma.tutorMessage.findFirst({ where: { conversationId, role: 'LEARNER' }, orderBy: { createdAt: 'desc' } });
    const bundle = await this.doubts.contextBundle(this.prisma, a.id, ent, c.topicId, conversationId);
    const t = await this.doubts.create({ learnerId: a.id, entitlement: ent, topicId: c.topicId, category: o.category ?? 'CONTENT', subject: (lastQ?.content ?? 'Tutor escalation').slice(0, 120), blocked: false,
      body: `${lastQ?.content ?? ''}${o.note ? `\n\nLearner note: ${o.note}` : ''}`.trim(), source: o.auto ? 'AUTO' : 'TUTOR', conversationId, contextBundle: bundle, actor: a });
    await this.prisma.tutorConversation.update({ where: { id: conversationId }, data: { ticketId: t.id } });
    return t;
  }

  // ---- benchmark against golden Q&A (PRD: grounded >=85%, unsupported <2%) --------------------------------------------------
  async benchmark(a: Actor, versionId: string, cases: { question: string; expect: 'answerable' | 'unsupported'; mustCite?: string; language?: Lang }[], promptId?: string) {
    if (!cases?.length || cases.length > 100) throw new BadRequestException('1..100 cases');
    const v = await this.prisma.programmeVersion.findUnique({ where: { id: versionId } });
    if (!v || !['PUBLISHED', 'RETIRED'].includes(v.state)) throw new BadRequestException('benchmark needs a published version');
    let prompt: PipelineIn['prompt'];
    if (promptId) { const p = await this.prisma.promptTemplate.findUnique({ where: { id: promptId } }); if (!p || p.key !== 'tutor') throw new BadRequestException('promptId must be a tutor prompt'); prompt = { system: p.system, user: p.user, key: 'tutor', version: p.version, schemaName: p.schemaName }; }
    const topics = new Set((await this.prisma.topic.findMany({ where: { module: { versionId } }, select: { id: true } })).map((t) => t.id));
    const rows: { question: string; expect: string; status: string; cited: boolean | null; pass: boolean }[] = [];
    for (const c of cases) {
      const o = await this.run({ versionId, programmeId: v.programmeId, allowedTopics: topics, language: c.language ?? 'en', question: c.question, history: [], quizTexts: [], actorId: a.id, prompt });
      const answered = o.status === 'ANSWERED';
      const cited = answered && c.mustCite ? o.citations.some((x) => x.ref.includes(c.mustCite!) || x.snippet.toLowerCase().includes(c.mustCite!.toLowerCase())) : null;
      rows.push({ question: c.question, expect: c.expect, status: o.status, cited, pass: c.expect === 'answerable' ? answered && cited !== false : !answered });
    }
    const ans = rows.filter((r) => r.expect === 'answerable'), uns = rows.filter((r) => r.expect === 'unsupported');
    const groundedAnswerRate = ans.length ? ans.filter((r) => r.status === 'ANSWERED').length / ans.length : null;
    const unsupportedAnswerRate = uns.length ? uns.filter((r) => r.status === 'ANSWERED').length / uns.length : null;
    const cc = ans.filter((r) => r.status === 'ANSWERED' && r.cited !== null);
    const citationCorrectness = cc.length ? cc.filter((r) => r.cited).length / cc.length : null;
    const pass = (groundedAnswerRate ?? 1) >= 0.85 && (unsupportedAnswerRate ?? 0) < 0.02 && (citationCorrectness ?? 1) >= 0.85;
    if (promptId) await this.prisma.promptTemplate.update({ where: { id: promptId }, data: { evalScore: pass ? 1 : (groundedAnswerRate ?? 0) * 0.5, evalReport: { groundedAnswerRate, unsupportedAnswerRate, citationCorrectness, rows } as any } });
    return { pass, groundedAnswerRate, unsupportedAnswerRate, citationCorrectness, thresholds: { groundedAnswerRate: 0.85, unsupportedAnswerRate: 0.02, citationCorrectness: 0.85 }, rows };
  }
}

const OVERSEE = ['ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'AUDITOR', 'SUPER_ADMIN', 'SUPPORT_OPERATOR'];

@Controller('v1')
export class TutorController {
  constructor(private svc: TutorService, private prisma: PrismaService, private index: TutorIndexService) {}

  @Post('tutor/ask') @Roles('LEARNER') ask(@Body() b: any, @CurrentActor() a: Actor) { need(b, { question: 'string' }); return this.svc.ask(a, b); }

  @Get('tutor/conversations') @Roles('LEARNER')
  async list(@CurrentActor() a: Actor) { return this.prisma.tutorConversation.findMany({ where: { learnerId: a.id }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, topicId: true, ticketId: true, createdAt: true, updatedAt: true } }); }

  @Get('tutor/conversations/:id') @Roles('LEARNER')
  async one(@Param('id') id: string, @CurrentActor() a: Actor) {
    const c = await this.prisma.tutorConversation.findFirst({ where: { id, learnerId: a.id } });
    if (!c) throw new NotFoundException();
    const ms = await this.prisma.tutorMessage.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });
    return { id, ticketId: c.ticketId, messages: ms.map((m) => ({ id: m.id, role: m.role, content: m.content, status: m.status, confidence: m.confidence, citations: m.citations, helpful: m.helpful, at: m.createdAt })) };
  }

  @Post('tutor/messages/:id/feedback') @Roles('LEARNER')
  async feedback(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { helpful: 'boolean' });
    const r = await this.prisma.tutorMessage.updateMany({ where: { id, learnerId: a.id, role: 'TUTOR' }, data: { helpful: b.helpful, feedback: typeof b.comment === 'string' ? b.comment.slice(0, 1000) : null } });
    if (!r.count) throw new NotFoundException();
    return { ok: true };
  }

  @Post('tutor/conversations/:id/escalate') @Roles('LEARNER')
  async escalate(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    const t = await this.svc.escalate(a, id, { note: b?.note, category: b?.category });
    return { ticketId: t.id, status: t.status, priority: t.priority };
  }

  @Post('tutor/index/:versionId') @Roles('ACADEMIC_ADMIN', 'PLATFORM_ADMIN') reindex(@Param('versionId') v: string) { return this.index.build(v); }
  @Get('tutor/index/:versionId') @Roles('ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'AUDITOR') stats(@Param('versionId') v: string) { return this.index.stats(v); }
  @Post('tutor/benchmark') @Roles('ACADEMIC_ADMIN', 'PLATFORM_ADMIN')
  bench(@Body() b: any, @CurrentActor() a: Actor) { need(b, { versionId: 'string', cases: 'array' }); return this.svc.benchmark(a, b.versionId, b.cases, b.promptId); }
}

// ---- analytics (BRD: questions, grounded rate, refusal/escalation, top unresolved concepts, SLA, satisfaction) -------------------
@Controller('v1/reports')
export class AnalyticsController {
  constructor(private prisma: PrismaService, private read: ReadDb) {}

  @Get('tutor') @Roles(...OVERSEE)
  async tutor(@Query('versionId') versionId?: string, @Query('days') days = '30') {
    return this.read.run(async (db) => {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, Number(days) || 30)) * 86_400_000);
    const ver = versionId ? Prisma.sql`AND c."versionId" = ${versionId}` : Prisma.empty;
    const by = await db.$queryRaw<{ status: string | null; n: number }[]>(Prisma.sql`SELECT m.status, count(*)::int AS n FROM "TutorMessage" m JOIN "TutorConversation" c ON c.id = m."conversationId" WHERE m.role = 'TUTOR' AND m."createdAt" >= (${since} AT TIME ZONE 'UTC') ${ver} GROUP BY m.status`);
    const fb = await db.$queryRaw<{ helpful: boolean; n: number }[]>(Prisma.sql`SELECT m.helpful, count(*)::int AS n FROM "TutorMessage" m JOIN "TutorConversation" c ON c.id = m."conversationId" WHERE m.role = 'TUTOR' AND m.helpful IS NOT NULL AND m."createdAt" >= (${since} AT TIME ZONE 'UTC') ${ver} GROUP BY m.helpful`);
    const unresolved = await db.$queryRaw<{ q: string; topicId: string | null }[]>(Prisma.sql`
      SELECT l.content AS q, t."topicId" FROM "TutorMessage" t JOIN "TutorConversation" c ON c.id = t."conversationId"
      JOIN LATERAL (SELECT content FROM "TutorMessage" WHERE "conversationId" = t."conversationId" AND role = 'LEARNER' AND "createdAt" <= t."createdAt" ORDER BY "createdAt" DESC LIMIT 1) l ON true
      WHERE t.role = 'TUTOR' AND t.status = 'UNSUPPORTED' AND t."createdAt" >= (${since} AT TIME ZONE 'UTC') ${ver} LIMIT 1000`);
    const escalated = await db.doubtTicket.count({ where: { source: { in: ['TUTOR', 'AUTO'] }, createdAt: { gte: since }, ...(versionId && { versionId }) } });
    const n = (s: string) => by.find((x) => x.status === s)?.n ?? 0, total = by.reduce((s, x) => s + x.n, 0);
    const freq = new Map<string, number>(); unresolved.forEach((u) => new Set(tokenize(u.q)).forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1)));
    const byTopic = new Map<string, number>(); unresolved.forEach((u) => u.topicId && byTopic.set(u.topicId, (byTopic.get(u.topicId) ?? 0) + 1));
    const up = fb.find((x) => x.helpful)?.n ?? 0, down = fb.find((x) => !x.helpful)?.n ?? 0;
    return { since, questions: total, byStatus: Object.fromEntries(by.map((x) => [x.status ?? 'NONE', x.n])), groundedAnswerRate: total ? n('ANSWERED') / total : null, refusalRate: total ? (n('REFUSED') + n('UNSUPPORTED')) / total : null,
      escalatedTickets: escalated, helpfulRate: up + down ? up / (up + down) : null,
      topUnresolvedTerms: [...freq].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([term, count]) => ({ term, count })), topUnresolvedTopics: [...byTopic].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([topicId, count]) => ({ topicId, count })) };
  });
  }

  @Get('doubts') @Roles(...OVERSEE)
  async doubts(@Query('versionId') versionId?: string, @Query('days') days = '30') {
    return this.read.run(async (db) => {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, Number(days) || 30)) * 86_400_000);
    const ts = await db.doubtTicket.findMany({ where: { createdAt: { gte: since }, ...(versionId && { versionId }) }, take: 5000 });
    const responded = ts.filter((t) => t.firstResponseAt), onTime = responded.filter((t) => t.firstResponseAt! <= t.firstResponseDueAt);
    const breached = ts.filter((t) => t.slaBreachedAt || (t.firstResponseAt && t.firstResponseAt > t.firstResponseDueAt));
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const rated = ts.filter((t) => t.rating !== null);
    const teachers = new Map<string, { teacherId: string; assigned: number; resolved: number; breaches: number; ratings: number[] }>();
    for (const t of ts.filter((x) => x.assignedTeacherId)) { const e = teachers.get(t.assignedTeacherId!) ?? { teacherId: t.assignedTeacherId!, assigned: 0, resolved: 0, breaches: 0, ratings: [] }; e.assigned++; if (t.resolvedAt || t.status === 'CLOSED') e.resolved++; if (t.slaBreachedAt) e.breaches++; if (t.rating !== null) e.ratings.push(t.rating); teachers.set(t.assignedTeacherId!, e); }
    const names = new Map((await db.user.findMany({ where: { id: { in: [...teachers.keys()] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return { since, tickets: ts.length, open: ts.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length, unassigned: ts.filter((t) => !t.assignedTeacherId && t.status === 'NEW').length,
      slaCompliance: responded.length + breached.length ? onTime.length / (responded.length + ts.filter((t) => !t.firstResponseAt && t.slaBreachedAt).length) : null,
      avgFirstResponseMinutes: avg(responded.map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / 60_000)), avgResolutionHours: avg(ts.filter((t) => t.resolvedAt).map((t) => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3_600_000)),
      avgRating: avg(rated.map((t) => t.rating!)), reopenRate: ts.length ? ts.filter((t) => t.reopenCount > 0).length / ts.length : null,
      bySource: Object.fromEntries(['MANUAL', 'TUTOR', 'AUTO'].map((s) => [s, ts.filter((t) => t.source === s).length])), byCategory: Object.fromEntries(['CONTENT', 'ASSIGNMENT', 'QUIZ', 'TECHNICAL', 'OTHER'].map((s) => [s, ts.filter((t) => t.category === s).length])),
      teachers: [...teachers.values()].map((t) => ({ teacherId: t.teacherId, name: names.get(t.teacherId), assigned: t.assigned, resolved: t.resolved, breaches: t.breaches, avgRating: avg(t.ratings) })) };
  });
  }
}
