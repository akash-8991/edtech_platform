import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Injectable, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { parse } from 'csv-parse/sync';
import { PrismaService } from './common/prisma.service';
import { DecisionDto, ImportApplicationsDto } from './common/dto';
import { Prisma } from '@prisma/client';
import { Actor, CurrentActor, Public, Roles } from './common/auth';
import { need } from './common/http';
import { paged } from './common/page';
import { AuditService } from './audit';
import { computeEnd } from './domain/entitlement';
import { defaultPolicy } from './domain/policy';

const FIELDS = { externalRef: 'string', email: 'string', name: 'string', programmeCode: 'string', duration: 'string', cohort: 'string' } as const;

@Injectable()
export class ApplicationsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** IAM-001: validate, de-duplicate by externalRef (idempotent), report per-record outcome (reconciliation). */
  static MAX_BATCH = () => Number(process.env.INTAKE_MAX_BATCH ?? 1000);
  static LIMITS = { string: 500, email: 254 };

  /**
   * IAM-001: validate, de-duplicate by externalRef (idempotent), report per-record outcome (reconciliation).
   * Each record commits on its own so one bad row never blocks the batch. De-duplication is decided by the unique index, not by a
   * read-then-write: concurrent deliveries of the same externalRef (webhook retries, double-click imports) resolve to one 'created'
   * and the rest 'duplicate', never a 500.
   */
  async intake(records: any[], actor: Actor | null) {
    if (!Array.isArray(records)) throw new BadRequestException('applications must be an array');
    if (records.length > ApplicationsService.MAX_BATCH()) throw new BadRequestException({ error: 'batch_too_large', max: ApplicationsService.MAX_BATCH() });
    const out: { externalRef?: string; result: 'created' | 'duplicate' | 'invalid'; errors?: string[]; id?: string }[] = [];
    for (const r of records) {
      const errors: string[] = [];
      for (const k of Object.keys(FIELDS)) {
        if (typeof r?.[k] !== 'string' || !r[k].trim()) errors.push(`${k} required`);
        else if (r[k].length > (k === 'email' ? ApplicationsService.LIMITS.email : ApplicationsService.LIMITS.string)) errors.push(`${k} too long`);
      }
      if (!errors.length && !['M12', 'M18'].includes(r.duration)) errors.push('duration must be M12 or M18');
      if (!errors.length && !/^\S+@\S+\.\S+$/.test(r.email)) errors.push('email invalid');
      if (errors.length) { out.push({ externalRef: typeof r?.externalRef === 'string' ? r.externalRef.slice(0, 100) : undefined, result: 'invalid', errors }); continue; }
      try {
        const app = await this.prisma.$transaction(async (tx) => {
          const a = await tx.learnerApplication.create({ data: {
            externalRef: r.externalRef, email: r.email.toLowerCase(), name: r.name, programmeCode: r.programmeCode,
            duration: r.duration, cohort: r.cohort, language: r.language === 'hi' ? 'hi' : 'en' } });
          await this.audit.record(tx, { actor, action: 'application.received', objectType: 'LearnerApplication', objectId: a.id, after: { externalRef: a.externalRef, programmeCode: a.programmeCode } });
          return a;
        });
        out.push({ externalRef: r.externalRef, result: 'created', id: app.id });
      } catch (e: any) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const existing = await this.prisma.learnerApplication.findUnique({ where: { externalRef: r.externalRef } });
        out.push({ externalRef: r.externalRef, result: 'duplicate', id: existing?.id });
      }
    }
    return { summary: { created: out.filter((o) => o.result === 'created').length, duplicate: out.filter((o) => o.result === 'duplicate').length, invalid: out.filter((o) => o.result === 'invalid').length }, results: out };
  }

  /** IAM-002/003: approve -> learner account + entitlement from a PUBLISHED course version only. */
  async decide(id: string, b: { decision: string; reason?: string; startAt?: string }, actor: Actor) {
    if (!['APPROVE', 'REJECT', 'RETURN'].includes(b.decision)) throw new BadRequestException('decision must be APPROVE|REJECT|RETURN');
    if (b.decision !== 'APPROVE' && !b.reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const [app] = await tx.$queryRaw<any[]>`SELECT id FROM "LearnerApplication" WHERE id = ${id} FOR UPDATE`;
      if (!app) throw new BadRequestException('not found');
      const a = await tx.learnerApplication.findUniqueOrThrow({ where: { id } });
      // D-077: only an undecided (RECEIVED) or returned application can be decided; a final decision is never silently overwritten.
      if (a.status === 'APPROVED' || a.status === 'REJECTED') throw new ConflictException(`already ${a.status.toLowerCase()}`);
      let learnerId: string | null = null, entitlementId: string | null = null;
      if (b.decision === 'APPROVE') {
        const prog = await tx.programme.findUnique({ where: { code: a.programmeCode } });
        const ver = prog && await tx.programmeVersion.findFirst({ where: { programmeId: prog.id, state: 'PUBLISHED' }, orderBy: { version: 'desc' } });
        if (!ver) throw new ConflictException('no published course version for programme');
        const user = await tx.user.upsert({ where: { email: a.email }, update: {}, create: { email: a.email, name: a.name, language: a.language, roles: { create: { role: 'LEARNER' } } } });
        if (await tx.entitlement.findFirst({ where: { learnerId: user.id, versionId: ver.id }, select: { id: true } })) throw new ConflictException('learner already has an entitlement for this course version'); // unique (learner, version): re-admission goes through the entitlement exception flow, not a new row
        const start = b.startAt ? new Date(b.startAt) : new Date();
        const ent = await tx.entitlement.create({ data: {
          learnerId: user.id, versionId: ver.id, duration: a.duration, cohort: a.cohort,
          startAt: start, endAt: computeEnd(start, a.duration, defaultPolicy()), approvedById: actor.id } });
        learnerId = user.id; entitlementId = ent.id;
        await this.audit.record(tx, { actor, action: 'entitlement.created', objectType: 'Entitlement', objectId: ent.id, after: { learnerId, versionId: ver.id, duration: a.duration, startAt: ent.startAt, endAt: ent.endAt } });
      }
      const status = b.decision === 'APPROVE' ? 'APPROVED' : b.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
      const upd = await tx.learnerApplication.update({ where: { id }, data: { status, reason: b.reason, decidedById: actor.id, decidedAt: new Date(), learnerId } });
      await this.audit.record(tx, { actor, action: `application.${status.toLowerCase()}`, objectType: 'LearnerApplication', objectId: id, before: { status: a.status }, after: { status }, reason: b.reason });
      return { ...upd, entitlementId };
    });
  }
}

@Controller('v1')
export class ApplicationsController {
  constructor(private svc: ApplicationsService, private prisma: PrismaService) {}

  // Signed server-to-server inbound from the admissions front: HMAC(timestamp.rawBody), 5-minute replay window.
  @Public() @Post('admissions/applications')
  async inbound(@Req() req: any, @Headers('x-timestamp') ts: string, @Headers('x-signature') sig: string, @Body() body: any) {
    const secret = process.env.ADMISSIONS_HMAC_SECRET;
    if (!secret || !ts || !sig || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) throw new UnauthorizedException();
    const exp = createHmac('sha256', secret).update(`${ts}.${req.rawBody?.toString() ?? ''}`).digest();
    const got = Buffer.from(sig, 'hex');
    if (got.length !== exp.length || !timingSafeEqual(got, exp)) throw new UnauthorizedException();
    need(body, { applications: 'array' });
    return this.svc.intake(body.applications, null);
  }

  @Post('applications/import') @Roles('PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPER_ADMIN')
  async import(@Body() b: ImportApplicationsDto, @CurrentActor() a: Actor) {
    const records = typeof b?.csv === 'string' ? parse(b.csv, { columns: true, skip_empty_lines: true, trim: true, to: ApplicationsService.MAX_BATCH() + 1 }) : need(b, { applications: 'array' }).applications;
    return this.svc.intake(records, a);
  }

  @Get('applications') @Roles('PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR')
  list(@Res({ passthrough: true }) res: any, @Query('status') status?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return paged(res, limit, cursor, (a) => this.prisma.learnerApplication.findMany({ where: status ? { status: status as any } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...a }));
  }

  @Post('applications/:id/decision') @Roles('PLATFORM_ADMIN', 'ACADEMIC_ADMIN')
  decide(@Param('id') id: string, @Body() b: DecisionDto, @CurrentActor() a: Actor) { return this.svc.decide(id, b, a); }
}
