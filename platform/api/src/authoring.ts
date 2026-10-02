import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor, Roles } from './common/auth';
import { need } from './common/http';
import { AuditService } from './audit';
import { defaultPolicy } from './domain/policy';
import { diffVersions } from './domain/diff';
import { accessibilityEnforced, accessibilityReport } from './accessibility';
import { normalizePolicy, validatePolicy } from './domain/grading';
import { authorize, isEditable, State, WorkflowError, WorkflowForbidden } from './domain/workflow';

const AUTHORING = ['CONTENT_AUTHOR', 'ACADEMIC_ADMIN', 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', 'AUDITOR', 'SUPER_ADMIN'];

const tree = (modules: any[], createdById = '') => modules.map((m, i) => ({
  position: i + 1, title: m.title,
  topics: { create: (m.topics ?? []).map((t: any, j: number) => ({
    position: j + 1, title: t.title, hours: t.hours ?? 1, outcomes: t.outcomes ?? [], prerequisites: t.prerequisites ?? [], mandatory: t.mandatory ?? true,
    ...(t.quiz && { quiz: { create: { passPercent: t.quiz.passPercent, maxAttempts: t.quiz.maxAttempts, questions: { create: t.quiz.questions.map((q: any) => ({ position: q.position, type: q.type, text: q.text, options: q.options, answer: q.answer, tolerance: q.tolerance, points: q.points, rationale: q.rationale })) } } } }),
    ...(t.assignment && { assignment: { create: { instructions: t.assignment.instructions, rubric: t.assignment.rubric, maxSubmissions: t.assignment.maxSubmissions, policy: t.assignment.policy ?? {}, i18n: t.assignment.i18n ?? {} } } }),
    ...(t.assets?.length && { assets: { create: t.assets.map((a: any) => ({ kind: a.kind, language: a.language, durationSec: a.durationSec, files: a.files, interactions: a.interactions, provenance: a.provenance, rights: a.rights, createdById: createdById || a.createdById })) } }),
  })) },
}));

/** CUR-003: topic hours must reconcile with the declared programme hours before review. */
export function validateForReview(v: { hours: number; languages?: any; modules: { title?: string; topics: any[] }[] }): string[] {
  const issues: string[] = [];
  const langs: string[] = Array.isArray(v.languages) ? v.languages : ['en'];
  // FRD journey: every mandatory topic needs video (per approved language) -> quiz -> assignment.
  for (const m of v.modules) for (const t of m.topics) {
    if (t.mandatory === false) continue;
    const vids = (t.assets ?? []).filter((a: any) => a.kind === 'VIDEO' && a.files?.master);
    for (const l of langs) if (!vids.some((a: any) => a.language === l)) issues.push(`topic "${t.title}": no ${l} video with master file`);
    if (!t.quiz?.questions?.length) issues.push(`topic "${t.title}": quiz missing`);
    if (!t.assignment) issues.push(`topic "${t.title}": assignment missing`);
    else for (const i of validatePolicy(normalizePolicy(t.assignment.policy, t.assignment.rubric, { confidenceThreshold: 0.8, sampleRate: 0, appealWindowDays: 7 }))) issues.push(`topic "${t.title}": assignment policy: ${i}`);
  }
  const total = v.modules.reduce((s, m) => s + m.topics.reduce((a, t) => a + t.hours, 0), 0);
  if (!v.modules.length) issues.push('no modules');
  if (total !== v.hours) issues.push(`topic hours ${total} != programme hours ${v.hours}`);
  if (v.modules.some((m) => !m.topics.length)) issues.push('module without topics');
  return issues;
}

@Injectable()
export class AuthoringService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async createVersion(code: string, b: any, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const prog = await tx.programme.findUnique({ where: { code } });
      if (!prog) throw new NotFoundException('programme');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${code}))`;
      const last = await tx.programmeVersion.findFirst({ where: { programmeId: prog.id }, orderBy: { version: 'desc' } });
      const v = await tx.programmeVersion.create({ data: {
        programmeId: prog.id, version: (last?.version ?? 0) + 1, authorId: actor.id, hours: b.hours,
        outcomes: b.outcomes ?? [], languages: b.languages ?? ['en'], provenance: b.provenance ?? { source: 'manual' },
        modules: { create: tree(b.modules ?? [], actor.id) } }, include: { modules: { include: { topics: true } } } });
      await this.audit.record(tx, { actor, action: 'version.created', objectType: 'ProgrammeVersion', objectId: v.id, after: { code, version: v.version, provenance: v.provenance } });
      return v;
    });
  }

  async edit(id: string, b: any, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.programmeVersion.findUnique({ where: { id } });
      if (!v) throw new NotFoundException();
      if (!isEditable(v.state as State)) throw new ConflictException(`version is ${v.state}; only DRAFT is editable`);
      if (v.authorId !== actor.id && !actor.roles.includes('ACADEMIC_ADMIN')) throw new ForbiddenException();
      const tq = { topic: { module: { versionId: id } } };
      await tx.question.deleteMany({ where: { quiz: tq } });
      await tx.quiz.deleteMany({ where: tq });
      await tx.assignment.deleteMany({ where: tq });
      await tx.contentAsset.deleteMany({ where: tq });
      await tx.topic.deleteMany({ where: { module: { versionId: id } } });
      await tx.module.deleteMany({ where: { versionId: id } });
      const u = await tx.programmeVersion.update({ where: { id }, data: {
        ...(b.hours && { hours: b.hours }), ...(b.outcomes && { outcomes: b.outcomes }), ...(b.languages && { languages: b.languages }),
        ...(b.provenance && { provenance: b.provenance }), ...(b.modules && { modules: { create: tree(b.modules) } }) },
        include: { modules: { include: { topics: true } } } });
      await this.audit.record(tx, { actor, action: 'version.edited', objectType: 'ProgrammeVersion', objectId: id, before: { hours: v.hours }, after: { hours: u.hours } });
      return u;
    });
  }

  async transition(id: string, to: State, reason: string | undefined, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<any[]>`SELECT id FROM "ProgrammeVersion" WHERE id = ${id} FOR UPDATE`;
      if (!lock) throw new NotFoundException();
      const v = await tx.programmeVersion.findUniqueOrThrow({ where: { id }, include: { modules: { include: { topics: { include: { quiz: { include: { questions: true } }, assignment: true, assets: true } } } } } });
      const reviewers = (await tx.approvalRecord.findMany({ where: { versionId: id, toState: 'FACULTY_APPROVED' } })).map((r) => r.actorId);
      try {
        authorize(v.state as State, to, { actorId: actor.id, actorRoles: actor.roles, authorId: v.authorId, facultyReviewerIds: reviewers, reason }, defaultPolicy());
      } catch (e) {
        if (e instanceof WorkflowForbidden) throw new ForbiddenException(e.message);
        if (e instanceof WorkflowError) throw new ConflictException(e.message);
        throw e;
      }
      if (to === 'FACULTY_REVIEW') {
        const issues = validateForReview(v);
        if (accessibilityEnforced()) for (const i of accessibilityReport(v.modules.flatMap((m) => m.topics) as any, (Array.isArray(v.languages) ? v.languages : ['en']) as string[])) if (i.severity === 'BLOCKING') issues.push(`topic "${i.topic}": accessibility: ${i.message}`);
        if (issues.length) throw new BadRequestException({ error: 'not_ready_for_review', issues });
      }
      // AI-generated content: unresolved blocking quality findings stop approval (human review is mandatory, not advisory).
      if (['FACULTY_APPROVED', 'ADMIN_APPROVAL', 'PUBLISHED'].includes(to)) {
        const open = await tx.qualityFinding.count({ where: { versionId: id, current: true, blocking: true, resolvedAt: null } });
        if (open) throw new ConflictException({ error: 'unresolved_quality_findings', count: open, hint: 'GET /v1/ai/quality?versionId=' + id });
      }
      const u = await tx.programmeVersion.update({ where: { id }, data: { state: to, ...(to === 'PUBLISHED' && { publishedAt: new Date() }) } });
      await tx.approvalRecord.create({ data: { versionId: id, fromState: v.state, toState: to, actorId: actor.id, reason } });
      await this.audit.record(tx, { actor, action: `version.${to.toLowerCase()}`, objectType: 'ProgrammeVersion', objectId: id, before: { state: v.state }, after: { state: to }, reason });
      return u;
    });
  }
}

@Controller('v1/authoring')
export class AuthoringController {
  constructor(private svc: AuthoringService, private prisma: PrismaService, private audit: AuditService) {}

  @Post('programmes') @Roles('ACADEMIC_ADMIN', 'CONTENT_AUTHOR')
  async createProgramme(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { code: 'string', title: 'string', discipline: 'string' });
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.programme.create({ data: { code: b.code, title: b.title, discipline: b.discipline } });
      await this.audit.record(tx, { actor: a, action: 'programme.created', objectType: 'Programme', objectId: p.id, after: b });
      return p;
    });
  }

  @Post('programmes/:code/versions') @Roles('ACADEMIC_ADMIN', 'CONTENT_AUTHOR')
  create(@Param('code') code: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { hours: 'number', modules: 'array' });
    return this.svc.createVersion(code, b, a);
  }

  @Put('versions/:id') @Roles('ACADEMIC_ADMIN', 'CONTENT_AUTHOR')
  edit(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.edit(id, b, a); }

  @Get('versions/:id') @Roles(...AUTHORING)
  async get(@Param('id') id: string) {
    const v = await this.prisma.programmeVersion.findUnique({ where: { id }, include: { modules: { orderBy: { position: 'asc' }, include: { topics: { orderBy: { position: 'asc' } } } }, approvals: { orderBy: { createdAt: 'asc' } }, comments: true } });
    if (!v) throw new NotFoundException();
    return v;
  }

  @Get('versions/:id/diff') @Roles(...AUTHORING)
  async diff(@Param('id') id: string, @Query('against') against: string) {
    if (!against) throw new BadRequestException('against=<versionId> required');
    const load = (x: string) => this.prisma.programmeVersion.findUnique({ where: { id: x }, include: { modules: { orderBy: { position: 'asc' }, include: { topics: { orderBy: { position: 'asc' } } } } } });
    const [a, b] = await Promise.all([load(against), load(id)]);
    if (!a || !b) throw new NotFoundException();
    return { from: against, to: id, changes: diffVersions(a as any, b as any) };
  }

  @Get('versions/:id/accessibility') @Roles(...AUTHORING)
  async accessibility(@Param('id') id: string) {
    const v = await this.prisma.programmeVersion.findUnique({ where: { id }, include: { modules: { include: { topics: { include: { assets: true } } } } } });
    if (!v) throw new NotFoundException();
    const issues = accessibilityReport(v.modules.flatMap((m) => m.topics) as any, (Array.isArray(v.languages) ? v.languages : ['en']) as string[]);
    return { blocking: issues.filter((i) => i.severity === 'BLOCKING').length, advisory: issues.filter((i) => i.severity === 'ADVISORY').length, enforced: accessibilityEnforced(), issues };
  }

  @Get('topics/:id/manifest') @Roles(...AUTHORING)
  async manifest(@Param('id') id: string, @Query('rev') rev?: string) {
    const m = await this.prisma.scriptManifest.findFirst({ where: { topicId: id, ...(rev && { rev: Number(rev) }) }, orderBy: { rev: 'desc' } });
    if (!m) throw new NotFoundException('no manifest');
    return { rev: m.rev, jobId: m.jobId, provenance: m.provenance, manifest: m.manifest };
  }

  @Post('versions/:id/transition') @Roles(...AUTHORING)
  transition(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { to: 'string' });
    return this.svc.transition(id, b.to, b.reason, a);
  }

  @Post('versions/:id/comments') @Roles(...AUTHORING)
  async comment(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { body: 'string' });
    return this.prisma.reviewComment.create({ data: { versionId: id, authorId: a.id, body: b.body, target: b.target } });
  }

  // CUR-006: clone any version into a new draft (new version number, provenance preserved).
  @Post('versions/:id/clone') @Roles('ACADEMIC_ADMIN', 'CONTENT_AUTHOR')
  async clone(@Param('id') id: string, @CurrentActor() a: Actor) {
    const v = await this.prisma.programmeVersion.findUnique({ where: { id }, include: { programme: true, modules: { orderBy: { position: 'asc' }, include: { topics: { orderBy: { position: 'asc' }, include: { quiz: { include: { questions: true } }, assignment: true, assets: true } } } } } });
    if (!v) throw new NotFoundException();
    return this.svc.createVersion(v.programme.code, { hours: v.hours, outcomes: v.outcomes, languages: v.languages, provenance: { ...(v.provenance as object), clonedFrom: id }, modules: v.modules }, a);
  }
}
