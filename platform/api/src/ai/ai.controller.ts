import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, Roles } from '../common/auth';
import { need } from '../common/http';
import { AuditService } from '../audit';
import { ConfigService, CONFIG_KEYS } from './config';
import { GenerationService } from './generation';
import { PromptRegistry } from './prompts';

const GEN = ['CONTENT_AUTHOR', 'ACADEMIC_ADMIN'];
const ADMIN = ['PLATFORM_ADMIN', 'SUPER_ADMIN'];
const OVERSEE = ['ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'AUDITOR', 'SUPER_ADMIN'];
// Only judgement-type findings can be waived by faculty; structural/assessment defects must be fixed or regenerated.
const WAIVABLE = ['factual_consistency', 'citations', 'safety', 'bias', 'copyright', 'originality', 'language', 'accessibility'];
const golden = (n: string) => JSON.parse(readFileSync(join(__dirname, 'golden', n), 'utf8'));

function refs(b: any) {
  const r = b?.references ?? [];
  if (!Array.isArray(r) || r.some((x: any) => typeof x?.id !== 'string' || typeof x?.text !== 'string')) throw new BadRequestException('references must be [{id, title?, text}]');
  if (r.reduce((s: number, x: any) => s + x.text.length, 0) > 400_000) throw new BadRequestException('references too large (max 400k chars)');
  if (new Set(r.map((x: any) => x.id)).size !== r.length) throw new BadRequestException('duplicate reference ids');
  return r;
}

@Controller('v1')
export class AiController {
  constructor(private prisma: PrismaService, private gen: GenerationService, private prompts: PromptRegistry, private config: ConfigService, private audit: AuditService) {}

  // ---- jobs --------------------------------------------------------------------------------------------------
  @Post('ai/curriculum-jobs') @HttpCode(202) @Roles(...GEN)
  async curriculumJob(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { programme: 'object', title: 'string', discipline: 'string', audience: 'string', durationType: 'string', hours: 'number', outcomes: 'array' });
    need(b.programme, { code: 'string' });
    if (!['M12', 'M18'].includes(b.durationType) || !Number.isInteger(b.hours) || b.hours < 1 || b.hours > 5000) throw new BadRequestException('durationType M12|M18 and integer hours 1..5000');
    const languages = b.languages ?? ['en'];
    if (!Array.isArray(languages) || languages.some((l: string) => !['en', 'hi'].includes(l)) || !languages.includes('en')) throw new BadRequestException('languages must include en; allowed en,hi');
    const input = { ...b, languages, prerequisites: b.prerequisites ?? [], assessmentPolicy: b.assessmentPolicy ?? 'quiz and assignment per topic', references: refs(b) };
    const job = await this.prisma.generationJob.create({ data: { kind: 'CURRICULUM', input, requestedById: a.id } });
    return { jobId: job.id, status: job.status };
  }

  @Post('ai/topic-jobs') @HttpCode(202) @Roles(...GEN)
  async topicJob(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { topicId: 'string' });
    const t = await this.prisma.topic.findUnique({ where: { id: b.topicId }, include: { module: { include: { version: true } } } });
    if (!t) throw new NotFoundException('topic');
    const v = t.module.version;
    if (v.state !== 'DRAFT') throw new ConflictException(`version is ${v.state}; regenerate into a new draft (clone) instead`);
    if (v.authorId !== a.id && !a.roles.includes('ACADEMIC_ADMIN')) throw new ForbiddenException();
    if (b.languages && (!Array.isArray(b.languages) || b.languages.some((l: string) => !['en', 'hi'].includes(l)))) throw new BadRequestException('languages en|hi');
    const job = await this.prisma.generationJob.create({ data: { kind: 'TOPIC_CONTENT', input: { topicId: b.topicId, languages: b.languages, instruction: b.instruction, references: refs(b) }, requestedById: a.id, versionId: v.id, topicId: t.id } });
    return { jobId: job.id, status: job.status };
  }

  @Get('ai/jobs/:id') @Roles(...GEN, ...OVERSEE)
  async job(@Param('id') id: string, @CurrentActor() a: Actor) {
    const j = await this.prisma.generationJob.findUnique({ where: { id } });
    if (!j || (j.requestedById !== a.id && !a.roles.some((r) => OVERSEE.includes(r)))) throw new NotFoundException();
    const { input, ...rest } = j; // inputs may carry large reference texts; omit from the status view
    return { ...rest, inputSummary: { kind: j.kind, references: (input as any)?.references?.length ?? 0 } };
  }

  @Get('ai/jobs') @Roles(...GEN, ...OVERSEE)
  async jobs(@Query('status') status: string | undefined, @CurrentActor() a: Actor) {
    const all = a.roles.some((r) => OVERSEE.includes(r));
    return (await this.prisma.generationJob.findMany({ where: { ...(status && { status: status as any }), ...(!all && { requestedById: a.id }) }, orderBy: { createdAt: 'desc' }, take: 100 }))
      .map(({ input, ...r }) => r);
  }

  @Post('ai/jobs/:id/cancel') @Roles(...GEN, 'ACADEMIC_ADMIN')
  async cancel(@Param('id') id: string, @CurrentActor() a: Actor) {
    const r = await this.prisma.generationJob.updateMany({ where: { id, status: 'QUEUED', ...(!a.roles.includes('ACADEMIC_ADMIN') && { requestedById: a.id }) }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    if (!r.count) throw new ConflictException('only your queued jobs can be cancelled');
    return { ok: true };
  }

  // ---- quality findings ----------------------------------------------------------------------------------------
  @Get('ai/quality') @Roles(...GEN, 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', ...OVERSEE)
  async quality(@Query('versionId') versionId: string) {
    if (!versionId) throw new BadRequestException('versionId required');
    const rows = await this.prisma.qualityFinding.findMany({ where: { versionId, current: true }, orderBy: [{ blocking: 'desc' }, { createdAt: 'asc' }] });
    return { open: rows.filter((r) => r.blocking && !r.resolvedAt).length, findings: rows };
  }

  @Post('ai/quality/:id/resolve') @Roles('FACULTY_REVIEWER')
  async resolve(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { resolution: 'string' });
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.qualityFinding.findUnique({ where: { id } });
      if (!f || !f.current) throw new NotFoundException();
      if (f.resolvedAt) throw new ConflictException('already resolved');
      if (!WAIVABLE.includes(f.gate)) throw new ConflictException(`"${f.gate}" findings must be fixed or regenerated, not waived`);
      const v = await tx.programmeVersion.findUniqueOrThrow({ where: { id: f.versionId } });
      if (v.authorId === a.id) throw new ConflictException('segregation of duties: author cannot resolve findings on own content');
      const u = await tx.qualityFinding.update({ where: { id }, data: { resolvedById: a.id, resolvedAt: new Date(), resolution: b.resolution } });
      await this.audit.record(tx, { actor: a, action: 'quality.finding_resolved', objectType: 'QualityFinding', objectId: id, before: { gate: f.gate, message: f.message }, reason: b.resolution });
      return u;
    });
  }

  // ---- prompt registry -------------------------------------------------------------------------------------------
  @Get('ai/prompts') @Roles(...ADMIN, 'ACADEMIC_ADMIN', 'AUDITOR')
  list(@Query('key') key?: string) { return this.prisma.promptTemplate.findMany({ where: key ? { key } : {}, orderBy: [{ key: 'asc' }, { version: 'desc' }] }); }

  @Post('ai/prompts/:key') @Roles(...ADMIN, 'ACADEMIC_ADMIN')
  draft(@Param('key') key: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { system: 'string', user: 'string' }); return this.prompts.createDraft(key, b, a); }

  @Post('ai/prompts/:id/evaluate') @Roles(...ADMIN, 'ACADEMIC_ADMIN')
  async evaluate(@Param('id') id: string, @CurrentActor() a: Actor) {
    const p = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    if (p.key === 'grader') throw new BadRequestException('grader prompts are evaluated with POST /v1/grading/benchmark {topicId, cases, promptId}');
    if (p.key === 'tutor') throw new BadRequestException('tutor prompts are evaluated with POST /v1/tutor/benchmark {versionId, cases, promptId}');
    return this.gen.evaluatePrompt(id, a, p.key === 'curriculum' ? golden('curriculum.json') : golden('topic_content.json'));
  }

  @Post('ai/prompts/:id/approve') @Roles('APPROVER_PUBLISHER', ...ADMIN)
  approve(@Param('id') id: string, @CurrentActor() a: Actor) { return this.prompts.approve(id, a); }

  // ---- cost telemetry --------------------------------------------------------------------------------------------
  @Get('ai/usage') @Roles(...OVERSEE)
  async usage(@Query('days') days = '7') {
    const since = new Date(Date.now() - Math.min(90, Math.max(1, Number(days) || 7)) * 86_400_000);
    const rows = await this.prisma.aiCall.groupBy({ by: ['useCase', 'provider', 'model', 'status'], where: { createdAt: { gte: since } }, _count: true, _sum: { costUsd: true, inputTokens: true, outputTokens: true } });
    return { since, rows: rows.map((r) => ({ useCase: r.useCase, provider: r.provider, model: r.model, status: r.status, calls: r._count, costUsd: Math.round((r._sum.costUsd ?? 0) * 1e6) / 1e6, inputTokens: r._sum.inputTokens, outputTokens: r._sum.outputTokens })),
      totalUsd: Math.round(rows.reduce((s, r) => s + (r._sum.costUsd ?? 0), 0) * 1e6) / 1e6 };
  }

  // ---- admin config (kill switch, budget, glossary, prohibited terms, productivity tools) ---------------------------
  @Get('admin/config') @Roles(...ADMIN, 'ACADEMIC_ADMIN')
  async configs() { return Promise.all(Object.entries(CONFIG_KEYS).map(async ([key, d]) => ({ key, doc: d.doc, kind: d.kind, value: await this.config.get(key) }))); }

  @Put('admin/config/:key') @Roles(...ADMIN, 'ACADEMIC_ADMIN')
  async setConfig(@Param('key') key: string, @Body() b: any, @CurrentActor() a: Actor) {
    // the kill switch and budget are platform-level controls
    if (['ai.kill_switch', 'ai.daily_budget_usd'].includes(key) && !a.roles.some((r) => ADMIN.includes(r))) throw new ForbiddenException('platform admin only');
    need(b, { value: b?.value === undefined ? 'string' : typeof b.value === 'object' ? 'object' : (typeof b.value as 'string') });
    return this.config.set(key, b.value, a);
  }
}
