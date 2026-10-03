import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, Injectable, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, hashPasswordAsync, Roles } from '../common/auth';
import { need } from '../common/http';
import { paged } from '../common/page';
import { AuditService } from '../audit';
import { passwordIssues } from '../domain/totp';
import { SessionService } from './sessions';

export const ALL_ROLES = Object.keys(Role);
/** Only a super admin may grant or take away these, or manage a person who holds one (no one can raise themselves or a peer). */
export const TOP_ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN'];
const READ = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'AUDITOR', 'SUPPORT_OPERATOR'];
const WRITE = ['SUPER_ADMIN', 'PLATFORM_ADMIN'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A one-time password the person must change: 16 characters, guaranteed to pass the password policy. */
export function temporaryPassword(email = ''): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  for (;;) { const b = randomBytes(16); const p = Array.from(b, (x) => A[x % A.length]).join('') + '-' + (b[0] % 90 + 10); if (!passwordIssues(p, email).length) return p; }
}

const SELECT = { id: true, email: true, name: true, language: true, status: true, createdAt: true, lastLoginAt: true, lockedUntil: true, mfaEnabled: true, legalHold: true, erasedAt: true, roles: { select: { role: true, programmeId: true, cohort: true } } } as const;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private audit: AuditService, private sessions: SessionService) {}

  private rolesOf(u: { roles: { role: string; programmeId: string | null; cohort: string | null }[] }) { return [...new Set(u.roles.map((r) => r.role))]; }
  private parseRoles(x: unknown, name: string, allowEmpty = false): string[] {
    if (!Array.isArray(x) || x.some((r) => typeof r !== 'string')) throw new BadRequestException(`${name} must be a list of roles`);
    const bad = x.filter((r) => !ALL_ROLES.includes(r)); if (bad.length) throw new BadRequestException(`unknown role: ${bad.join(', ')}`);
    if (!allowEmpty && !x.length) throw new BadRequestException(`${name}: at least one role`);
    return [...new Set(x as string[])];
  }
  private needReason(r: unknown) { if (typeof r !== 'string' || !r.trim()) throw new BadRequestException('reason required'); return r.trim(); }
  private mayTouch(actor: Actor, targetRoles: string[]) { if (targetRoles.some((r) => TOP_ROLES.includes(r)) && !actor.roles.includes('SUPER_ADMIN')) throw new ForbiddenException('only a super admin can change an administrator'); }
  private async lastSuper(tx: Prisma.TransactionClient, exceptUserId: string) {
    return (await tx.user.count({ where: { id: { not: exceptUserId }, status: 'ACTIVE', erasedAt: null, roles: { some: { role: 'SUPER_ADMIN' } } } })) === 0;
  }

  async list(actor: Actor, q: { q?: string; role?: string; status?: string }, res: any, limit?: string, cursor?: string) {
    const full = actor.roles.some((r) => READ.includes(r));
    // Narrow lookups for people who must name someone to do their job: academic admins find doubt teachers or learners; exam administrators find a learner (to grant an accommodation).
    const lookup = (actor.roles.includes('ACADEMIC_ADMIN') && (q.role === 'DOUBT_TEACHER' || q.role === 'LEARNER')) || (actor.roles.some((r) => ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'].includes(r)) && q.role === 'LEARNER');
    if (!full && !lookup) throw new ForbiddenException();
    if (!full && q.role === 'LEARNER' && (q.q?.trim().length ?? 0) < 3) throw new BadRequestException('type at least 3 letters of the name or email'); // no browsing of every learner
    if (q.role && !ALL_ROLES.includes(q.role)) throw new BadRequestException('unknown role');
    if (q.status && !['ACTIVE', 'SUSPENDED', 'ERASED'].includes(q.status)) throw new BadRequestException('status ACTIVE|SUSPENDED|ERASED');
    const term = q.q?.trim();
    const where: Prisma.UserWhereInput = { ...(q.role && { roles: { some: { role: q.role as Role } } }), ...(q.status === 'ERASED' ? { erasedAt: { not: null } } : q.status ? { status: q.status, erasedAt: null } : {}), ...(term && { OR: [{ email: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }] }) };
    const rows = await paged(res, limit, cursor, (a) => this.prisma.user.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: SELECT, ...a }));
    return rows.map((u) => this.view(u, true));
  }
  private view(u: any, full = true) { return { id: u.id, name: u.name, ...(full && { email: u.email }), language: u.language, status: u.erasedAt ? 'ERASED' : u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, locked: !!u.lockedUntil && u.lockedUntil > new Date(), mfaEnabled: u.mfaEnabled, legalHold: u.legalHold, roles: this.rolesOf(u), scopedRoles: u.roles.filter((r: any) => r.programmeId || r.cohort).map((r: any) => ({ role: r.role, programmeId: r.programmeId, cohort: r.cohort })) }; }

  async get(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: SELECT }); if (!u) throw new NotFoundException();
    const [sessions, events, teacher] = await Promise.all([this.prisma.userSession.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.prisma.auditEvent.findMany({ where: { objectType: 'User', objectId: id }, orderBy: { seq: 'desc' }, take: 25, select: { seq: true, actorId: true, action: true, reason: true, after: true, createdAt: true } }),
      this.prisma.teacherProfile.findUnique({ where: { userId: id }, select: { active: true } })]);
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    return { ...this.view(u), activeSessions: sessions, teacherProfile: !!teacher, history: events.map((e) => ({ seq: Number(e.seq), at: e.createdAt, by: e.actorId ? names.get(e.actorId) ?? 'Unknown' : 'The system', action: e.action, reason: e.reason, detail: e.after })) };
  }

  async create(actor: Actor, b: { email: string; name: string; roles: string[]; language?: string; ssoOnly?: boolean }) {
    const email = String(b.email ?? '').trim().toLowerCase(); if (!EMAIL.test(email)) throw new BadRequestException('a valid email is required');
    const name = String(b.name ?? '').trim(); if (!name || name.length > 120) throw new BadRequestException('a name (up to 120 characters) is required');
    const roles = this.parseRoles(b.roles, 'roles'); if (b.language && !['en', 'hi'].includes(b.language)) throw new BadRequestException('language en|hi');
    if (roles.some((r) => TOP_ROLES.includes(r)) && !actor.roles.includes('SUPER_ADMIN')) throw new ForbiddenException('only a super admin can create an administrator');
    const pw = b.ssoOnly ? null : temporaryPassword(email);
    const hash = pw ? await hashPasswordAsync(pw) : null;
    const u = await this.prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email } })) throw new ConflictException('someone with this email already exists');
      const x = await tx.user.create({ data: { email, name, language: b.language ?? 'en', passwordHash: hash, roles: { create: roles.map((role) => ({ role: role as Role })) } } });
      await this.audit.record(tx, { actor, action: 'user.created', objectType: 'User', objectId: x.id, after: { email, roles, passwordSet: !!hash } });
      return x;
    });
    return { id: u.id, email, roles, ...(pw && { temporaryPassword: pw }) };
  }

  async setRoles(actor: Actor, id: string, b: { add?: string[]; remove?: string[]; reason: string }) {
    const reason = this.needReason(b.reason); const add = this.parseRoles(b.add ?? [], 'add', true), remove = this.parseRoles(b.remove ?? [], 'remove', true);
    if (!add.length && !remove.length) throw new BadRequestException('nothing to change');
    if (add.some((r) => remove.includes(r))) throw new BadRequestException('a role cannot be both added and removed');
    if (id === actor.id) throw new ForbiddenException('you cannot change your own roles');
    if ([...add, ...remove].some((r) => TOP_ROLES.includes(r)) && !actor.roles.includes('SUPER_ADMIN')) throw new ForbiddenException('only a super admin can grant or remove an administrator role');
    const out = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id }, include: { roles: true } }); if (!u) throw new NotFoundException();
      if (u.erasedAt) throw new ConflictException('this account was erased');
      const before = this.rolesOf(u); this.mayTouch(actor, before);
      const globalHas = (r: string) => u.roles.some((x) => x.role === r && !x.programmeId && !x.cohort);
      const missing = remove.filter((r) => !globalHas(r)); if (missing.length) throw new ConflictException(`they do not hold: ${missing.join(', ')}`);
      const toAdd = add.filter((r) => !globalHas(r));
      const remaining = u.roles.filter((x) => !(remove.includes(x.role) && !x.programmeId && !x.cohort)).length + toAdd.length;
      if (!remaining) throw new BadRequestException('they would have no role: suspend the account instead');
      if (remove.includes('SUPER_ADMIN') && (await this.lastSuper(tx, id))) throw new ConflictException('this is the last active super admin');
      for (const r of toAdd) await tx.userRole.create({ data: { userId: id, role: r as Role } });
      if (remove.length) await tx.userRole.deleteMany({ where: { userId: id, role: { in: remove as Role[] }, programmeId: null, cohort: null } });
      const after = this.rolesOf({ roles: [...u.roles.filter((x) => !(remove.includes(x.role) && !x.programmeId && !x.cohort)), ...toAdd.map((role) => ({ role, programmeId: null, cohort: null }))] as any });
      await this.audit.record(tx, { actor, action: 'user.roles_changed', objectType: 'User', objectId: id, before: { roles: before }, after: { roles: after }, reason });
      return { roles: after };
    });
    const signedOut = await this.sessions.revokeAll(id, 'roles_changed'); // they sign in again and get exactly the new roles (and MFA if now privileged)
    return { ...out, sessionsRevoked: signedOut };
  }

  async setStatus(actor: Actor, id: string, status: string, reasonIn: string) {
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) throw new BadRequestException('status ACTIVE|SUSPENDED'); const reason = this.needReason(reasonIn);
    if (id === actor.id) throw new ForbiddenException('you cannot change your own account status');
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id }, include: { roles: true } }); if (!u) throw new NotFoundException();
      if (u.erasedAt) throw new ConflictException('this account was erased'); this.mayTouch(actor, this.rolesOf(u));
      if (u.status === status) throw new ConflictException(`already ${status.toLowerCase()}`);
      if (status === 'SUSPENDED' && u.roles.some((r) => r.role === 'SUPER_ADMIN') && (await this.lastSuper(tx, id))) throw new ConflictException('this is the last active super admin');
      await tx.user.update({ where: { id }, data: { status } });
      await this.audit.record(tx, { actor, action: status === 'SUSPENDED' ? 'user.suspended' : 'user.reactivated', objectType: 'User', objectId: id, before: { status: u.status }, after: { status }, reason });
    });
    const signedOut = status === 'SUSPENDED' ? await this.sessions.revokeAll(id, 'suspended') : 0;
    return { ok: true, status, sessionsRevoked: signedOut };
  }

  async unlock(actor: Actor, id: string, reason?: string) {
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id }, include: { roles: true } }); if (!u) throw new NotFoundException(); this.mayTouch(actor, this.rolesOf(u));
      await tx.user.update({ where: { id }, data: { failedLogins: 0, lockedUntil: null } });
      await this.audit.record(tx, { actor, action: 'user.unlocked', objectType: 'User', objectId: id, reason });
    });
    return { ok: true };
  }

  async resetPassword(actor: Actor, id: string, reasonIn: string) {
    const reason = this.needReason(reasonIn); if (id === actor.id) throw new ForbiddenException('change your own password from your account page');
    const u0 = await this.prisma.user.findUnique({ where: { id }, include: { roles: true } }); if (!u0) throw new NotFoundException();
    if (u0.erasedAt) throw new ConflictException('this account was erased'); this.mayTouch(actor, this.rolesOf(u0));
    const pw = temporaryPassword(u0.email); const hash = await hashPasswordAsync(pw);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash: hash, failedLogins: 0, lockedUntil: null } });
      await this.audit.record(tx, { actor, action: 'user.password_reset_by_admin', objectType: 'User', objectId: id, reason }); // the password itself is never logged
    });
    const signedOut = await this.sessions.revokeAll(id, 'password_reset');
    return { temporaryPassword: pw, sessionsRevoked: signedOut };
  }
}

@Controller('v1/admin/users')
export class UsersController {
  constructor(private svc: UsersService) {}
  @Get() @Roles(...READ, 'ACADEMIC_ADMIN', 'EXAM_ADMIN', 'ASSESSMENT_ADMIN')
  list(@CurrentActor() a: Actor, @Res({ passthrough: true }) res: any, @Query('q') q?: string, @Query('role') role?: string, @Query('status') status?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) { return this.svc.list(a, { q, role, status }, res, limit, cursor); }
  @Get(':id') @Roles(...READ) one(@Param('id') id: string) { return this.svc.get(id); }
  @Post() @Roles(...WRITE) @HttpCode(201) @Header('Cache-Control', 'no-store')
  create(@Body() b: any, @CurrentActor() a: Actor) { need(b, { email: 'string', name: 'string', roles: 'array' }); return this.svc.create(a, b); }
  @Post(':id/roles') @Roles(...WRITE) @HttpCode(201) roles(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { reason: 'string' }); return this.svc.setRoles(a, id, b); }
  @Post(':id/status') @Roles(...WRITE) @HttpCode(201) status(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { status: 'string', reason: 'string' }); return this.svc.setStatus(a, id, b.status, b.reason); }
  @Post(':id/unlock') @Roles(...WRITE) @HttpCode(201) unlock(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.unlock(a, id, b?.reason); }
  @Post(':id/reset-password') @Roles(...WRITE) @HttpCode(201) @Header('Cache-Control', 'no-store') reset(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { reason: 'string' }); return this.svc.resetPassword(a, id, b.reason); }
}
