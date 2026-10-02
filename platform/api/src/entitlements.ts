import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Post } from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor, Roles } from './common/auth';
import { need } from './common/http';
import { AuditService } from './audit';
import { canPause, effectiveStatus, hasLearningAccess, PolicyError, resumeResult } from './domain/entitlement';
import { defaultPolicy } from './domain/policy';

const STAFF = ['PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'SUPPORT_OPERATOR'];

@Injectable()
export class EntitlementsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private async lockOwn(tx: any, id: string, actor: Actor) {
    const [row] = await tx.$queryRaw<any[]>`SELECT id FROM "Entitlement" WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundException();
    const e = await tx.entitlement.findUniqueOrThrow({ where: { id } });
    const staff = actor.roles.some((r) => STAFF.includes(r));
    if (e.learnerId !== actor.id && !staff) throw new ForbiddenException(); // object-level access (IAM-007)
    return e;
  }

  async pause(id: string, actor: Actor, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const e = await this.lockOwn(tx, id, actor);
      const now = new Date();
      try { canPause(e, now, defaultPolicy()); } catch (x) { if (x instanceof PolicyError) throw new ConflictException(x.message); throw x; }
      const u = await tx.entitlement.update({ where: { id }, data: { status: 'PAUSED', pausedAt: now, pauseCount: { increment: 1 } } });
      await tx.entitlementPause.create({ data: { entitlementId: id, startedAt: now, reason } });
      await this.audit.record(tx, { actor, action: 'entitlement.paused', objectType: 'Entitlement', objectId: id, before: { status: e.status, pauseCount: e.pauseCount }, after: { status: 'PAUSED', pauseCount: u.pauseCount }, reason });
      return u;
    });
  }

  async resume(id: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const e = await this.lockOwn(tx, id, actor);
      const now = new Date();
      let r; try { r = resumeResult(e, now, defaultPolicy()); } catch (x) { if (x instanceof PolicyError) throw new ConflictException(x.message); throw x; }
      // endAt intentionally unchanged: pause does not extend the entitlement
      const u = await tx.entitlement.update({ where: { id }, data: { status: 'ACTIVE', pausedAt: null, pausedDays: r.pausedDays } });
      const open = await tx.entitlementPause.findFirst({ where: { entitlementId: id, endedAt: null }, orderBy: { startedAt: 'desc' } });
      if (open) await tx.entitlementPause.update({ where: { id: open.id }, data: { endedAt: now } });
      await this.audit.record(tx, { actor, action: 'entitlement.resumed', objectType: 'Entitlement', objectId: id, before: { status: 'PAUSED' }, after: { status: 'ACTIVE', pausedDays: r.pausedDays, endAt: e.endAt } });
      return u;
    });
  }

  async extend(id: string, actor: Actor, days: number, reason: string) {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BadRequestException('extendDays 1..365');
    return this.prisma.$transaction(async (tx) => {
      const e = await this.lockOwn(tx, id, actor);
      const endAt = new Date(e.endAt.getTime() + days * 86_400_000);
      await tx.entitlementException.create({ data: { entitlementId: id, extendDays: days, reason, approvedById: actor.id } });
      const u = await tx.entitlement.update({ where: { id }, data: { endAt, ...(e.status === 'EXPIRED' && { status: 'ACTIVE' }) } });
      await this.audit.record(tx, { actor, action: 'entitlement.exception_extended', objectType: 'Entitlement', objectId: id, before: { endAt: e.endAt }, after: { endAt }, reason });
      return u;
    });
  }

  async revoke(id: string, actor: Actor, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const e = await this.lockOwn(tx, id, actor);
      const u = await tx.entitlement.update({ where: { id }, data: { status: 'REVOKED' } });
      // Offline copies die with the entitlement.
      await tx.offlineLicense.updateMany({ where: { entitlementId: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: 'entitlement revoked' } });
      await this.audit.record(tx, { actor, action: 'entitlement.revoked', objectType: 'Entitlement', objectId: id, before: { status: e.status }, after: { status: 'REVOKED' }, reason });
      return u;
    });
  }
}

const view = (e: any, now = new Date()) => ({ ...e, effectiveStatus: effectiveStatus(e, now), learningAccess: hasLearningAccess(e, now) });

@Controller('v1')
export class EntitlementsController {
  constructor(private svc: EntitlementsService, private prisma: PrismaService) {}

  @Get('me/entitlements') @Roles('LEARNER')
  async mine(@CurrentActor() a: Actor) {
    return (await this.prisma.entitlement.findMany({ where: { learnerId: a.id } })).map((e) => view(e));
  }

  @Post('entitlements/:id/pause') @Roles('LEARNER', ...STAFF)
  pause(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.pause(id, a, b?.reason); }

  @Post('entitlements/:id/resume') @Roles('LEARNER', ...STAFF)
  resume(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.resume(id, a); }

  @Post('entitlements/:id/exceptions') @Roles('PLATFORM_ADMIN', 'ACADEMIC_ADMIN')
  extend(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { extendDays: 'number', reason: 'string' });
    return this.svc.extend(id, a, b.extendDays, b.reason);
  }

  @Post('entitlements/:id/revoke') @Roles('PLATFORM_ADMIN', 'ACADEMIC_ADMIN')
  revoke(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { reason: 'string' });
    return this.svc.revoke(id, a, b.reason);
  }

  // Server-side access decision; clients never decide (build prompt).
  @Get('entitlements/:id/access') @Roles('LEARNER', ...STAFF)
  async access(@Param('id') id: string, @CurrentActor() a: Actor) {
    const e = await this.prisma.entitlement.findUnique({ where: { id } });
    if (!e || (e.learnerId !== a.id && !a.roles.some((r) => STAFF.includes(r)))) throw new NotFoundException();
    return { id, effectiveStatus: effectiveStatus(e, new Date()), allowed: hasLearningAccess(e, new Date()) };
  }
}
