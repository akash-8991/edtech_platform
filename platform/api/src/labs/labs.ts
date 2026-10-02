import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Injectable, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, Roles } from '../common/auth';
import { need } from '../common/http';
import { AuditService } from '../audit';
import { ConfigService } from '../ai/config';
import { NotificationsService } from '../notifications';
import { readBody, ScanProvider, SCANNER, StorageService } from '../storage';
import { ProgressionService } from '../learning';
import { hasLearningAccess } from '../domain/entitlement';
import { signToken } from '../domain/media-crypto';
import { labSecrets, verifyAny } from '../security/keyring';

const COORD = ['LAB_COORDINATOR', 'ACADEMIC_ADMIN'];
const WRITERS = ['ACADEMIC_ADMIN', 'CONTENT_AUTHOR'];
const EXT = /\.(pdf|txt|md|png|jpe?g|zip|csv|docx?|mp4|mp3)$/i;
const secret = () => labSecrets().current;
export const QR_VALID_MS = 90_000;
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class LabsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private config: ConfigService, private notes: NotificationsService, private prog: ProgressionService) {}

  // ---- authoring (LAB-001): lab activities are part of the course version and freeze with it -----------------------------------
  async upsertActivity(versionId: string, code: string, b: any, actor: Actor) {
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(code)) throw new BadRequestException('code 2..30 chars: letters, digits, - _');
    if (typeof b.title !== 'string' || !b.title.trim()) throw new BadRequestException('title required');
    if (typeof b.safetyText !== 'string' || b.safetyText.trim().length < 20) throw new BadRequestException('safetyText (the acknowledgement learners must accept) is required, min 20 chars');
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.programmeVersion.findUnique({ where: { id: versionId } });
      if (!v) throw new NotFoundException();
      if (v.state !== 'DRAFT') throw new ConflictException(`version is ${v.state}; lab activities are frozen`);
      if (v.authorId !== actor.id && !actor.roles.includes('ACADEMIC_ADMIN')) throw new ForbiddenException();
      const prereq: string[] = Array.isArray(b.prerequisiteTopicIds) ? b.prerequisiteTopicIds : [];
      const topics = await tx.topic.findMany({ where: { module: { versionId }, id: { in: [...prereq, ...(b.topicId ? [b.topicId] : [])] } }, select: { id: true } });
      if (new Set(topics.map((t) => t.id)).size !== new Set([...prereq, ...(b.topicId ? [b.topicId] : [])]).size) throw new BadRequestException('prerequisite/linked topics must belong to this version');
      const data = { topicId: b.topicId ?? null, title: b.title, description: b.description ?? '', location: b.location ?? '', manual: b.manual ?? '', safetyText: b.safetyText, safetyHash: sha(b.safetyText), prerequisiteTopicIds: prereq,
        outcomes: b.outcomes ?? [], requireEvidence: b.requireEvidence ?? true, mandatory: b.mandatory ?? true };
      const a = await tx.labActivity.upsert({ where: { versionId_code: { versionId, code } }, update: data, create: { versionId, code, createdById: actor.id, ...data } });
      await this.audit.record(tx, { actor, action: 'lab.activity_set', objectType: 'LabActivity', objectId: a.id, after: { code, prerequisites: prereq.length, safetyHash: a.safetyHash } });
      return a;
    });
  }

  // ---- learner eligibility (LAB-002) -----------------------------------------------------------------------------------------------
  async eligibility(learnerId: string, activity: { id: string; versionId: string; prerequisiteTopicIds: string[]; safetyHash: string }) {
    const ent = await this.prisma.entitlement.findUnique({ where: { learnerId_versionId: { learnerId, versionId: activity.versionId } } });
    if (!ent) throw new ForbiddenException('no entitlement for this course');
    const st = await this.prog.state(this.prisma, ent);
    const missing = activity.prerequisiteTopicIds.filter((id) => !st.rows.find((r) => r.topic.id === id)?.complete);
    const acked = !!(await this.prisma.labAck.findFirst({ where: { activityId: activity.id, learnerId, textHash: activity.safetyHash } }));
    return { ent, active: hasLearningAccess(ent, new Date()), missingTopicIds: missing, acked, eligible: hasLearningAccess(ent, new Date()) && !missing.length && acked };
  }

  async ack(activityId: string, actor: Actor, textHash: string) {
    const a = await this.prisma.labActivity.findUnique({ where: { id: activityId } });
    if (!a) throw new NotFoundException();
    if (textHash !== a.safetyHash) throw new ConflictException('you are acknowledging an outdated safety text: reload it');
    const e = await this.eligibility(actor.id, a); if (!e.active) throw new ForbiddenException('entitlement not active');
    await this.prisma.labAck.upsert({ where: { activityId_learnerId_textHash: { activityId, learnerId: actor.id, textHash } }, update: {}, create: { activityId, learnerId: actor.id, textHash } });
    return { ok: true };
  }

  async book(slotId: string, actor: Actor) {
    const hours = await this.config.get<number>('lab.cancel_before_hours');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'labslot:' + slotId}))`;
      const slot = await tx.labSlot.findUnique({ where: { id: slotId } });
      if (!slot || slot.status !== 'OPEN') throw new NotFoundException();
      if (slot.startsAt.getTime() < Date.now()) throw new ConflictException('slot already started');
      const a = await tx.labActivity.findUniqueOrThrow({ where: { id: slot.activityId } });
      const e = await this.eligibility(actor.id, a);
      if (!e.eligible) throw new ConflictException({ error: 'not_eligible', activeEntitlement: e.active, missingPrerequisiteTopics: e.missingTopicIds, safetyAcknowledged: e.acked });
      const mine = await tx.labBooking.findFirst({ where: { activityId: a.id, learnerId: actor.id, status: { in: ['BOOKED', 'ATTENDED'] } } });
      if (mine) throw new ConflictException('you already have a booking for this lab');
      if ((await tx.labBooking.count({ where: { slotId, status: { in: ['BOOKED', 'ATTENDED'] } } })) >= slot.capacity) throw new ConflictException('slot is full');
      const b = await tx.labBooking.upsert({ where: { slotId_learnerId: { slotId, learnerId: actor.id } }, update: { status: 'BOOKED', cancelledAt: null }, create: { slotId, activityId: a.id, learnerId: actor.id, entitlementId: e.ent.id } });
      await this.notes.notify(tx, actor.id, 'lab.booked', { bookingId: b.id, startsAt: slot.startsAt, location: slot.location || a.location, cancelBeforeHours: hours });
      return b;
    });
  }

  async cancel(bookingId: string, actor: Actor) {
    const hours = await this.config.get<number>('lab.cancel_before_hours');
    return this.prisma.$transaction(async (tx) => {
      const b = await tx.labBooking.findUnique({ where: { id: bookingId } });
      const staff = actor.roles.some((r) => COORD.includes(r));
      if (!b || (b.learnerId !== actor.id && !staff)) throw new NotFoundException();
      if (b.status !== 'BOOKED') throw new ConflictException(`booking is ${b.status}`);
      const slot = await tx.labSlot.findUniqueOrThrow({ where: { id: b.slotId } });
      if (!staff && slot.startsAt.getTime() - Date.now() < hours * 3_600_000) throw new ConflictException(`bookings can only be cancelled ${hours}h before the slot`);
      return tx.labBooking.update({ where: { id: b.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    });
  }

  // ---- attendance (LAB-003): teacher-marked or signed rotating QR -------------------------------------------------------------------
  private async completionCheck(tx: Prisma.TransactionClient, bookingId: string) {
    const b = await tx.labBooking.findUniqueOrThrow({ where: { id: bookingId } });
    const a = await tx.labActivity.findUniqueOrThrow({ where: { id: b.activityId } });
    if (b.completedAt || b.status !== 'ATTENDED') return b;
    if (a.requireEvidence && !(b.evidence as any[]).length) return b;
    const u = await tx.labBooking.update({ where: { id: b.id }, data: { completedAt: new Date() } });
    await this.notes.notify(tx, b.learnerId, 'lab.completed', { bookingId: b.id, activity: a.code });
    return u;
  }

  async markAttendance(slotId: string, learnerId: string, status: string, actor: Actor, note?: string) {
    if (!['ATTENDED', 'NO_SHOW'].includes(status)) throw new BadRequestException('status ATTENDED|NO_SHOW');
    return this.prisma.$transaction(async (tx) => {
      const slot = await tx.labSlot.findUnique({ where: { id: slotId } });
      if (!slot) throw new NotFoundException();
      if (Date.now() < slot.startsAt.getTime() - 30 * 60_000) throw new ConflictException('attendance opens 30 minutes before the slot');
      const b = await tx.labBooking.findUnique({ where: { slotId_learnerId: { slotId, learnerId } } });
      if (!b || b.status === 'CANCELLED') throw new NotFoundException('no active booking');
      await tx.labBooking.update({ where: { id: b.id }, data: { status, attendedAt: status === 'ATTENDED' ? new Date() : null, attendanceMethod: 'TEACHER', markedById: actor.id } });
      await this.audit.record(tx, { actor, action: `lab.attendance_${status.toLowerCase()}`, objectType: 'LabBooking', objectId: b.id, reason: note });
      return this.completionCheck(tx, b.id);
    });
  }

  qr(slotId: string) { return { token: signToken(secret(), { k: `labqr:${slotId}`, exp: Date.now() + QR_VALID_MS }), validSeconds: QR_VALID_MS / 1000 }; }

  async scan(token: string, actor: Actor) {
    const c = verifyAny(labSecrets().all, token ?? '');
    if (!c || !c.k.startsWith('labqr:')) throw new ForbiddenException('invalid or expired QR code');
    const slotId = c.k.slice(6);
    return this.prisma.$transaction(async (tx) => {
      const slot = await tx.labSlot.findUnique({ where: { id: slotId } });
      if (!slot || slot.status !== 'OPEN') throw new NotFoundException();
      const now = Date.now(); if (now < slot.startsAt.getTime() - 15 * 60_000 || now > slot.endsAt.getTime()) throw new ConflictException('outside the slot time');
      const b = await tx.labBooking.findUnique({ where: { slotId_learnerId: { slotId, learnerId: actor.id } } });
      if (!b || b.status === 'CANCELLED') throw new ForbiddenException('you have no booking for this slot');
      if (b.status !== 'ATTENDED') await tx.labBooking.update({ where: { id: b.id }, data: { status: 'ATTENDED', attendedAt: new Date(), attendanceMethod: 'QR' } }); // idempotent
      return this.completionCheck(tx, b.id);
    });
  }

  async submitEvidence(bookingId: string, actor: Actor, files: any[], note?: string) {
    if (!Array.isArray(files) || !files.length || files.length > 5 || files.some((f) => typeof f?.key !== 'string' || !f.key.startsWith(`labs/${actor.id}/`))) throw new ForbiddenException('1-5 files, uploaded by you');
    return this.prisma.$transaction(async (tx) => {
      const b = await tx.labBooking.findFirst({ where: { id: bookingId, learnerId: actor.id } });
      if (!b) throw new NotFoundException();
      if (b.status !== 'ATTENDED') throw new ConflictException('evidence can be submitted after your attendance is recorded');
      await tx.labBooking.update({ where: { id: b.id }, data: { evidence: files.map((f) => ({ key: f.key, name: f.name, checksum: f.checksum, note })) as any, evidenceAt: new Date() } });
      return this.completionCheck(tx, b.id);
    });
  }

  async forceComplete(bookingId: string, actor: Actor, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const b = await tx.labBooking.findUnique({ where: { id: bookingId } });
      if (!b || b.status !== 'ATTENDED') throw new ConflictException('only attended bookings can be completed');
      const u = await tx.labBooking.update({ where: { id: b.id }, data: { completedAt: b.completedAt ?? new Date(), completionNote: reason } });
      await this.audit.record(tx, { actor, action: 'lab.completed_by_coordinator', objectType: 'LabBooking', objectId: b.id, reason });
      return u;
    });
  }

  async completedCodes(learnerId: string, versionId: string) {
    const done = await this.prisma.labBooking.findMany({ where: { learnerId, completedAt: { not: null }, activityId: { in: (await this.prisma.labActivity.findMany({ where: { versionId }, select: { id: true } })).map((a) => a.id) } }, select: { activityId: true } });
    const acts = await this.prisma.labActivity.findMany({ where: { id: { in: done.map((d) => d.activityId) } }, select: { code: true } });
    return acts.map((a) => a.code);
  }
}

@Controller('v1')
export class LabsController {
  constructor(private svc: LabsService, private prisma: PrismaService, private audit: AuditService, private storage: StorageService, @Inject(SCANNER) private scanner: ScanProvider, private prog: ProgressionService) {}

  @Put('authoring/versions/:id/labs/:code') @Roles(...WRITERS)
  upsert(@Param('id') id: string, @Param('code') code: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.upsertActivity(id, code, b ?? {}, a); }
  @Get('authoring/versions/:id/labs') @Roles(...WRITERS, 'FACULTY_REVIEWER', 'LAB_COORDINATOR', 'AUDITOR')
  list(@Param('id') id: string) { return this.prisma.labActivity.findMany({ where: { versionId: id }, orderBy: { code: 'asc' } }); }

  // ---- coordinator ---------------------------------------------------------------------------------------------------------------
  @Post('labs/slots') @Roles(...COORD)
  async slot(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { activityId: 'string', batchCode: 'string', startsAt: 'string', endsAt: 'string', capacity: 'number' });
    const s = new Date(b.startsAt), e = new Date(b.endsAt);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s || s.getTime() < Date.now()) throw new BadRequestException('startsAt must be in the future and before endsAt');
    if (!Number.isInteger(b.capacity) || b.capacity < 1 || b.capacity > 500) throw new BadRequestException('capacity 1..500');
    const act = await this.prisma.labActivity.findUnique({ where: { id: b.activityId } });
    if (!act) throw new NotFoundException('activity');
    const v = await this.prisma.programmeVersion.findUniqueOrThrow({ where: { id: act.versionId } });
    if (!['PUBLISHED', 'RETIRED'].includes(v.state)) throw new ConflictException('slots can only be planned for published course versions');
    return this.prisma.$transaction(async (tx) => {
      const sl = await tx.labSlot.create({ data: { activityId: act.id, batchCode: b.batchCode, startsAt: s, endsAt: e, capacity: b.capacity, location: b.location ?? act.location, createdById: a.id } });
      await this.audit.record(tx, { actor: a, action: 'lab.slot_created', objectType: 'LabSlot', objectId: sl.id, after: { activity: act.code, batch: b.batchCode, capacity: b.capacity } });
      return sl;
    });
  }

  @Post('labs/slots/:id/cancel') @Roles(...COORD)
  async cancelSlot(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { reason: 'string' });
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.labSlot.findUnique({ where: { id } }); if (!s || s.status !== 'OPEN') throw new NotFoundException();
      await tx.labSlot.update({ where: { id }, data: { status: 'CANCELLED' } });
      const bs = await tx.labBooking.findMany({ where: { slotId: id, status: 'BOOKED' } });
      await tx.labBooking.updateMany({ where: { slotId: id, status: 'BOOKED' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      for (const x of bs) await this.svcNotify(tx, x.learnerId, id);
      await this.audit.record(tx, { actor: a, action: 'lab.slot_cancelled', objectType: 'LabSlot', objectId: id, reason: b.reason, after: { affected: bs.length } });
      return { cancelledBookings: bs.length };
    });
  }
  private svcNotify(tx: Prisma.TransactionClient, userId: string, slotId: string) { return tx.notification.create({ data: { userId, type: 'lab.slot_cancelled', payload: { slotId } } }); }

  @Get('labs/slots') @Roles(...COORD, 'LEARNER')
  async slots(@Query('activityId') activityId: string, @CurrentActor() a: Actor) {
    if (!activityId) throw new BadRequestException('activityId required');
    const rows = await this.prisma.labSlot.findMany({ where: { activityId, status: 'OPEN', startsAt: { gt: new Date() } }, orderBy: { startsAt: 'asc' } });
    const used = await this.prisma.labBooking.groupBy({ by: ['slotId'], where: { slotId: { in: rows.map((r) => r.id) }, status: { in: ['BOOKED', 'ATTENDED'] } }, _count: true });
    return rows.map((r) => ({ id: r.id, batchCode: r.batchCode, startsAt: r.startsAt, endsAt: r.endsAt, location: r.location, capacity: r.capacity, seatsLeft: r.capacity - (used.find((u) => u.slotId === r.id)?._count ?? 0) }));
  }

  @Get('labs/slots/:id/roster') @Roles(...COORD)
  async roster(@Param('id') id: string) {
    const bs = await this.prisma.labBooking.findMany({ where: { slotId: id }, orderBy: { createdAt: 'asc' } });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: bs.map((b) => b.learnerId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return bs.map((b) => ({ bookingId: b.id, learnerId: b.learnerId, name: users.get(b.learnerId), status: b.status, attendanceMethod: b.attendanceMethod, evidenceFiles: (b.evidence as any[]).length, completed: !!b.completedAt }));
  }
  @Post('labs/slots/:id/attendance') @Roles(...COORD)
  attendance(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { learnerId: 'string', status: 'string' }); return this.svc.markAttendance(id, b.learnerId, b.status, a, b.note); }
  @Get('labs/slots/:id/qr') @Roles(...COORD)
  async qr(@Param('id') id: string) { if (!(await this.prisma.labSlot.findUnique({ where: { id } }))) throw new NotFoundException(); return this.svc.qr(id); }
  @Post('labs/bookings/:id/complete') @Roles(...COORD)
  complete(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.forceComplete(id, a, b?.reason); }

  // ---- learner -------------------------------------------------------------------------------------------------------------------------
  @Get('me/labs') @Roles('LEARNER')
  async mine(@CurrentActor() a: Actor) {
    const ents = await this.prisma.entitlement.findMany({ where: { learnerId: a.id } });
    const acts = await this.prisma.labActivity.findMany({ where: { versionId: { in: ents.map((e) => e.versionId) } }, orderBy: { code: 'asc' } });
    const bookings = await this.prisma.labBooking.findMany({ where: { learnerId: a.id } });
    return Promise.all(acts.map(async (act) => { const e = await this.svc.eligibility(a.id, act); const bs = bookings.filter((b) => b.activityId === act.id);
      return { activityId: act.id, code: act.code, title: act.title, mandatory: act.mandatory, location: act.location, manual: act.manual, safetyText: act.safetyText, safetyHash: act.safetyHash, requireEvidence: act.requireEvidence,
        eligibility: { eligible: e.eligible, missingPrerequisiteTopics: e.missingTopicIds, safetyAcknowledged: e.acked }, bookings: bs.map((b) => ({ id: b.id, slotId: b.slotId, status: b.status, completed: !!b.completedAt })), completed: bs.some((b) => !!b.completedAt) }; }));
  }
  @Post('labs/activities/:id/ack') @Roles('LEARNER') ack(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { textHash: 'string' }); return this.svc.ack(id, a, b.textHash); }
  @Post('labs/slots/:id/book') @Roles('LEARNER') book(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.book(id, a); }
  @Post('labs/bookings/:id/cancel') @Roles('LEARNER', ...COORD) cancel(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.cancel(id, a); }
  @Post('labs/attendance') @Roles('LEARNER') scan(@Body() b: any, @CurrentActor() a: Actor) { need(b, { token: 'string' }); return this.svc.scan(b.token, a); }

  @Put('labs/evidence/upload') @Roles('LEARNER')
  async upload(@Query('name') name: string, @Req() req: any, @CurrentActor() a: Actor) {
    if (!name || !EXT.test(name) || /[\/\\]/.test(name)) throw new BadRequestException('file name/extension not allowed');
    const data = await readBody(req, 10 * 1024 * 1024); if (!data.length) throw new BadRequestException('empty file');
    if ((await this.scanner.scan(data, name)) !== 'CLEAN') throw new BadRequestException('file rejected by malware scan');
    const f = await this.storage.put(`labs/${a.id}/${randomUUID()}-${name}`, data);
    return { key: f.key, name, size: f.size, checksum: f.checksum };
  }
  @Post('labs/bookings/:id/evidence') @Roles('LEARNER') evidence(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.submitEvidence(id, a, b?.files, b?.note); }
}
