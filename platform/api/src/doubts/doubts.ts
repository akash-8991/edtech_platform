import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Injectable, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, Roles } from '../common/auth';
import { need } from '../common/http';
import { AuditService } from '../audit';
import { ConfigService } from '../ai/config';
import { NotificationsService } from '../notifications';
import { readBody, ScanProvider, SCANNER, StorageService } from '../storage';
import { ProgressionService } from '../learning';
import { hasLearningAccess } from '../domain/entitlement';
import { inWorkingHours, Priority, priorityFor, rank, slaDueAt, TICKET_OPEN, TeacherView } from '../domain/routing';
import { redactPii } from '../ai/quality';
import { tokenize } from '../ai/retrieval';
import { TutorIndexService } from '../tutor/tutor-index';

type Db = Prisma.TransactionClient | PrismaService;
const CATEGORIES = ['CONTENT', 'ASSIGNMENT', 'QUIZ', 'TECHNICAL', 'OTHER'];
const STAFF = ['SUPPORT_OPERATOR', 'ACADEMIC_ADMIN', 'PLATFORM_ADMIN'];
const EXT = /\.(pdf|txt|md|png|jpe?g|zip|ipynb|py|csv|docx?|mp4|mp3)$/i;
const REOPEN_DAYS = 7;

export interface CreateParams {
  learnerId: string; entitlement: { id: string; versionId: string }; topicId?: string | null; category: string; subject: string; body: string;
  blocked?: boolean; source: 'MANUAL' | 'TUTOR' | 'AUTO'; conversationId?: string; contextBundle?: object; attachments?: unknown[]; actor: Actor | null;
}

@Injectable()
export class DoubtService {
  constructor(private prisma: PrismaService, private audit: AuditService, private config: ConfigService, private notes: NotificationsService, private prog: ProgressionService, private index: TutorIndexService) {}

  // ---- routing -----------------------------------------------------------------------------------------------
  private async teacherViews(tx: Db): Promise<TeacherView[]> {
    const profiles = await tx.teacherProfile.findMany({ where: { active: true } });
    const open = await tx.doubtTicket.groupBy({ by: ['assignedTeacherId'], where: { status: { in: TICKET_OPEN }, assignedTeacherId: { not: null } }, _count: true });
    const load = new Map(open.map((o) => [o.assignedTeacherId!, o._count]));
    return profiles.map((p) => ({ userId: p.userId, active: p.active, available: p.available, disciplines: p.disciplines, skills: p.skills, languages: p.languages, capacity: p.capacity, open: load.get(p.userId) ?? 0, lastAssignedAt: p.lastAssignedAt, windows: p.windows as any }));
  }

  /** Assign (or leave unassigned with a note). Serialised so two tickets cannot both take a teacher's last slot. */
  async route(tx: Prisma.TransactionClient, ticketId: string, exclude: string[] = [], actor: Actor | null = null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7002)`;
    const t = await tx.doubtTicket.findUniqueOrThrow({ where: { id: ticketId } });
    const v = await tx.programmeVersion.findUniqueOrThrow({ where: { id: t.versionId }, include: { programme: true } });
    const topic = t.topicId ? await tx.topic.findUnique({ where: { id: t.topicId } }) : null;
    const keywords = tokenize(`${t.subject} ${topic?.title ?? ''}`);
    const ranked = rank(await this.teacherViews(tx), { discipline: v.programme.discipline, language: t.language, keywords, exclude }, new Date());
    if (!ranked.length) {
      await tx.doubtTicket.update({ where: { id: t.id }, data: { assignedTeacherId: null, status: 'NEW', routingNote: 'no eligible teacher (discipline/language/availability/capacity)' } });
      return null;
    }
    const best = ranked[0];
    await tx.doubtTicket.update({ where: { id: t.id }, data: { assignedTeacherId: best.userId, status: t.status === 'NEW' ? 'ASSIGNED' : t.status, routingNote: best.reasons.join('; ') } });
    await tx.teacherProfile.update({ where: { userId: best.userId }, data: { lastAssignedAt: new Date() } });
    await this.notes.notify(tx, best.userId, 'doubt.assigned', { ticketId: t.id, priority: t.priority, subject: t.subject });
    if (actor) await this.audit.record(tx, { actor, action: 'doubt.routed', objectType: 'DoubtTicket', objectId: t.id, after: { teacherId: best.userId, reasons: best.reasons } });
    return best.userId;
  }

  private async notifyStaff(tx: Prisma.TransactionClient, type: string, payload: object) {
    const staff = await tx.userRole.findMany({ where: { role: 'SUPPORT_OPERATOR' }, select: { userId: true }, distinct: ['userId'] });
    for (const s of staff) await this.notes.notify(tx, s.userId, type, payload);
  }

  // ---- creation ----------------------------------------------------------------------------------------------
  async create(p: CreateParams) {
    if (!CATEGORIES.includes(p.category)) throw new BadRequestException(`category must be one of ${CATEGORIES.join(',')}`);
    if (p.subject.length > 200 || p.body.length > 8000) throw new BadRequestException('subject <=200 and body <=8000 chars');
    const sla = await this.config.get<Record<string, number>>('doubt.sla_minutes');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: p.learnerId }, select: { language: true } });
    const priority = priorityFor(p.category, !!p.blocked);
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.doubtTicket.create({ data: { learnerId: p.learnerId, entitlementId: p.entitlement.id, versionId: p.entitlement.versionId, topicId: p.topicId ?? null, category: p.category, priority, language: user.language, subject: p.subject,
        source: p.source, conversationId: p.conversationId, contextBundle: (p.contextBundle ?? {}) as any, firstResponseDueAt: slaDueAt(priority as Priority, sla, new Date()) } });
      await tx.ticketMessage.create({ data: { ticketId: t.id, authorId: p.learnerId, authorRole: 'LEARNER', body: p.body, attachments: (p.attachments ?? []) as any } });
      const teacher = await this.route(tx, t.id, [], p.actor);
      if (!teacher) await this.notifyStaff(tx, 'doubt.unassigned', { ticketId: t.id, priority, subject: t.subject });
      if (p.source !== 'MANUAL') await this.audit.record(tx, { actor: p.actor, action: `doubt.created_${p.source.toLowerCase()}`, objectType: 'DoubtTicket', objectId: t.id, after: { conversationId: p.conversationId, priority } });
      return tx.doubtTicket.findUniqueOrThrow({ where: { id: t.id } });
    });
  }

  /** TUT-004 context bundle: question, conversation, sources searched, course/topic and learner progress. */
  async contextBundle(db: Db, learnerId: string, ent: { id: string; versionId: string }, topicId: string | null, conversationId?: string) {
    const [version, topic, st, attempts] = await Promise.all([
      db.programmeVersion.findUniqueOrThrow({ where: { id: ent.versionId }, include: { programme: true } }),
      topicId ? db.topic.findUnique({ where: { id: topicId } }) : null,
      this.prog.state(db, ent), db.quizAttempt.count({ where: { entitlementId: ent.id, status: 'SUBMITTED' } }),
    ]);
    const msgs = conversationId ? await db.tutorMessage.findMany({ where: { conversationId, learnerId }, orderBy: { createdAt: 'asc' }, take: 40 }) : [];
    const lastTutor = [...msgs].reverse().find((m) => m.role === 'TUTOR');
    const mand = st.rows.filter((r) => r.topic.mandatory);
    return { course: { programme: version.programme.title, code: version.programme.code, versionId: version.id, discipline: version.programme.discipline }, topic: topic && { id: topic.id, title: topic.title },
      conversation: msgs.map((m) => ({ role: m.role, content: m.content, status: m.status, at: m.createdAt })),
      sourcesSearched: (lastTutor?.retrieved as any)?.chunks ?? [], tutorStatus: lastTutor?.status ?? null,
      learnerProgress: { percentComplete: mand.length ? Math.round((mand.filter((r) => r.complete).length / mand.length) * 100) : 0, topicsDone: mand.filter((r) => r.complete).length, topicsTotal: mand.length, quizAttempts: attempts } };
  }

  // ---- views ---------------------------------------------------------------------------------------------------
  async thread(db: Db, ticketId: string, includeInternal: boolean) {
    return (await db.ticketMessage.findMany({ where: { ticketId, ...(includeInternal ? {} : { internal: false }) }, orderBy: { createdAt: 'asc' } })).map((m) => ({ id: m.id, authorRole: m.authorRole, internal: m.internal, body: m.body, attachments: m.attachments, at: m.createdAt }));
  }

  private asLearnerView(t: any) {
    return { id: t.id, number: t.number, subject: t.subject, category: t.category, priority: t.priority, status: t.status, topicId: t.topicId, createdAt: t.createdAt, firstResponseAt: t.firstResponseAt, resolvedAt: t.resolvedAt, resolutionSummary: t.resolutionSummary, rating: t.rating, canReopen: t.status === 'RESOLVED' && !!t.resolvedAt && Date.now() - t.resolvedAt.getTime() < REOPEN_DAYS * 86_400_000 };
  }
  asTeacherView(t: any) { const { learnerId, contextBundle, ...rest } = t; return { ...rest, context: contextBundle }; }
  learnerView(t: any) { return this.asLearnerView(t); }

  // ---- thread actions --------------------------------------------------------------------------------------------
  private async ownTicket(tx: Db, id: string, actor: Actor, mode: 'learner' | 'teacher') {
    const t = await tx.doubtTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    const staff = actor.roles.some((r) => STAFF.includes(r));
    if (mode === 'learner' ? t.learnerId !== actor.id : !(t.assignedTeacherId === actor.id || staff)) throw new NotFoundException(); // hide existence
    return t;
  }
  private checkAttachments(att: any, actor: Actor) {
    const a = Array.isArray(att) ? att : [];
    if (a.length > 5 || a.some((x) => typeof x?.key !== 'string' || !x.key.startsWith(`doubts/${actor.id}/`))) throw new ForbiddenException('attachments must be your own uploads (max 5)');
    return a;
  }

  async learnerMessage(id: string, actor: Actor, body: string, attachments: unknown) {
    if (!body?.trim() && !(Array.isArray(attachments) && attachments.length)) throw new BadRequestException('body or attachment required');
    const att = this.checkAttachments(attachments, actor);
    return this.prisma.$transaction(async (tx) => {
      const t = await this.ownTicket(tx, id, actor, 'learner');
      if (['RESOLVED', 'CLOSED'].includes(t.status)) throw new ConflictException('ticket is resolved: reopen it to continue');
      await tx.ticketMessage.create({ data: { ticketId: id, authorId: actor.id, authorRole: 'LEARNER', body: body ?? '', attachments: att as any } });
      if (t.status === 'WAITING_LEARNER') await tx.doubtTicket.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
      if (t.assignedTeacherId) await this.notes.notify(tx, t.assignedTeacherId, 'doubt.learner_replied', { ticketId: id });
      return { ok: true };
    });
  }

  async teacherReply(id: string, actor: Actor, b: { body: string; internal?: boolean; attachments?: unknown }) {
    if (!b.body?.trim()) throw new BadRequestException('body required');
    const att = this.checkAttachments(b.attachments, actor);
    return this.prisma.$transaction(async (tx) => {
      const t = await this.ownTicket(tx, id, actor, 'teacher');
      if (['RESOLVED', 'CLOSED'].includes(t.status)) throw new ConflictException('ticket is resolved');
      if (!t.assignedTeacherId) throw new ConflictException('claim or assign the ticket first');
      await tx.ticketMessage.create({ data: { ticketId: id, authorId: actor.id, authorRole: 'TEACHER', internal: !!b.internal, body: b.body, attachments: att as any } });
      if (b.internal) return { ok: true, internal: true };
      await tx.doubtTicket.update({ where: { id }, data: { status: 'WAITING_LEARNER', firstResponseAt: t.firstResponseAt ?? new Date() } });
      await this.notes.notify(tx, t.learnerId, 'doubt.teacher_replied', { ticketId: id });
      return { ok: true };
    });
  }

  async claim(id: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7002)`;
      const t = await tx.doubtTicket.findUnique({ where: { id } });
      if (!t) throw new NotFoundException();
      if (t.assignedTeacherId) throw new ConflictException('already assigned');
      const v = await tx.programmeVersion.findUniqueOrThrow({ where: { id: t.versionId }, include: { programme: true } });
      const mine = (await this.teacherViews(tx)).filter((x) => x.userId === actor.id);
      if (!rank(mine, { discipline: v.programme.discipline, language: t.language, keywords: [] }, new Date()).length) throw new ConflictException('you are not eligible (discipline, language, availability or capacity)');
      await tx.doubtTicket.update({ where: { id }, data: { assignedTeacherId: actor.id, status: 'ASSIGNED', routingNote: 'claimed by teacher' } });
      await tx.teacherProfile.update({ where: { userId: actor.id }, data: { lastAssignedAt: new Date() } });
      return { ok: true };
    });
  }

  async resolve(id: string, actor: Actor, summary: string) {
    if (!summary?.trim()) throw new BadRequestException('resolution summary required');
    return this.prisma.$transaction(async (tx) => {
      const t = await this.ownTicket(tx, id, actor, 'teacher');
      if (['RESOLVED', 'CLOSED'].includes(t.status)) throw new ConflictException('already resolved');
      if (!t.firstResponseAt) throw new ConflictException('send a reply to the learner before resolving');
      await tx.doubtTicket.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolutionSummary: summary } });
      await tx.ticketMessage.create({ data: { ticketId: id, authorId: actor.id, authorRole: 'SYSTEM', body: `Resolved: ${summary}` } });
      await this.notes.notify(tx, t.learnerId, 'doubt.resolved', { ticketId: id });
      await this.audit.record(tx, { actor, action: 'doubt.resolved', objectType: 'DoubtTicket', objectId: id, after: { summary } });
      return { ok: true };
    });
  }

  async reopen(id: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.ownTicket(tx, id, actor, 'learner');
      if (t.status !== 'RESOLVED' || !t.resolvedAt || Date.now() - t.resolvedAt.getTime() > REOPEN_DAYS * 86_400_000) throw new ConflictException(`only tickets resolved within ${REOPEN_DAYS} days can be reopened`);
      await tx.doubtTicket.update({ where: { id }, data: { status: 'IN_PROGRESS', resolvedAt: null, reopenCount: { increment: 1 } } });
      if (t.assignedTeacherId) await this.notes.notify(tx, t.assignedTeacherId, 'doubt.reopened', { ticketId: id });
      return { ok: true };
    });
  }

  async rate(id: string, actor: Actor, rating: number, comment?: string) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException('rating 1..5');
    return this.prisma.$transaction(async (tx) => {
      const t = await this.ownTicket(tx, id, actor, 'learner');
      if (!['RESOLVED', 'CLOSED'].includes(t.status)) throw new ConflictException('rate after resolution');
      if (t.rating !== null) throw new ConflictException('already rated');
      await tx.doubtTicket.update({ where: { id }, data: { rating, ratingComment: comment?.slice(0, 1000) } });
      return { ok: true };
    });
  }

  async reassign(id: string, actor: Actor, teacherId: string | undefined, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.doubtTicket.findUnique({ where: { id } });
      if (!t) throw new NotFoundException();
      if (['RESOLVED', 'CLOSED'].includes(t.status)) throw new ConflictException('ticket is resolved');
      const before = { teacher: t.assignedTeacherId, status: t.status };
      if (teacherId) {
        const p = await tx.teacherProfile.findUnique({ where: { userId: teacherId } });
        if (!p?.active) throw new BadRequestException('teacher not active');
        await tx.doubtTicket.update({ where: { id }, data: { assignedTeacherId: teacherId, status: t.status === 'NEW' ? 'ASSIGNED' : t.status, routingNote: `manually assigned: ${reason}` } });
        await this.notes.notify(tx, teacherId, 'doubt.assigned', { ticketId: id, priority: t.priority, subject: t.subject });
      } else {
        const got = await this.route(tx, id, t.assignedTeacherId ? [t.assignedTeacherId] : [], actor);
        if (!got) throw new ConflictException('no other eligible teacher');
      }
      await this.audit.record(tx, { actor, action: 'doubt.reassigned', objectType: 'DoubtTicket', objectId: id, before, after: { teacherId: teacherId ?? 'auto' }, reason });
      return tx.doubtTicket.findUniqueOrThrow({ where: { id } });
    });
  }

  // ---- appointments / clinic ---------------------------------------------------------------------------------------
  async requestAppointment(id: string, actor: Actor, startsAt: string, durationMin: number) {
    const start = new Date(startsAt);
    if (isNaN(start.getTime()) || start.getTime() < Date.now() + 15 * 60_000) throw new BadRequestException('startsAt must be at least 15 minutes in the future');
    if (![15, 30, 45, 60].includes(durationMin)) throw new BadRequestException('durationMin 15|30|45|60');
    const end = new Date(start.getTime() + durationMin * 60_000);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7003)`;
      const t = await this.ownTicket(tx, id, actor, 'learner');
      if (!t.assignedTeacherId) throw new ConflictException('a teacher must be assigned first');
      if (['RESOLVED', 'CLOSED'].includes(t.status)) throw new ConflictException('ticket is resolved');
      const prof = await tx.teacherProfile.findUniqueOrThrow({ where: { userId: t.assignedTeacherId } });
      if (!inWorkingHours(prof.windows as any, start) || !inWorkingHours(prof.windows as any, new Date(end.getTime() - 1))) throw new ConflictException('outside the teacher\'s working hours');
      const clash = await tx.appointment.count({ where: { teacherId: t.assignedTeacherId, status: { in: ['REQUESTED', 'CONFIRMED'] }, startsAt: { lt: end }, endsAt: { gt: start } } });
      if (clash) throw new ConflictException('teacher already has an appointment in that slot');
      const a = await tx.appointment.create({ data: { ticketId: id, teacherId: t.assignedTeacherId, learnerId: actor.id, startsAt: start, endsAt: end } });
      await this.notes.notify(tx, t.assignedTeacherId, 'doubt.appointment_requested', { ticketId: id, appointmentId: a.id, startsAt: start });
      return a;
    });
  }

  async decideAppointment(id: string, actor: Actor, decision: 'CONFIRM' | 'CANCEL', meetingRef?: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.appointment.findUnique({ where: { id } });
      if (!a) throw new NotFoundException();
      const isTeacher = a.teacherId === actor.id, isLearner = a.learnerId === actor.id;
      if (!isTeacher && !isLearner && !actor.roles.some((r) => STAFF.includes(r))) throw new NotFoundException();
      if (decision === 'CONFIRM' && !isTeacher) throw new ForbiddenException('only the teacher confirms');
      if (a.status === 'CANCELLED' || a.status === 'COMPLETED') throw new ConflictException(`appointment is ${a.status}`);
      const u = await tx.appointment.update({ where: { id }, data: decision === 'CONFIRM' ? { status: 'CONFIRMED', meetingRef } : { status: 'CANCELLED' } });
      await this.notes.notify(tx, isTeacher ? a.learnerId : a.teacherId, decision === 'CONFIRM' ? 'doubt.appointment_confirmed' : 'doubt.appointment_cancelled', { appointmentId: id, startsAt: a.startsAt });
      return u;
    });
  }

  // ---- sweeps: SLA breach, re-routing, auto-close -------------------------------------------------------------------
  async sweep(now = new Date()) {
    const out = { routed: 0, breached: 0, rerouted: 0, closed: 0 };
    for (const t of await this.prisma.doubtTicket.findMany({ where: { status: 'NEW', assignedTeacherId: null }, take: 100 }))
      if (await this.prisma.$transaction((tx) => this.route(tx, t.id))) out.routed++;
    const late = await this.prisma.doubtTicket.findMany({ where: { firstResponseAt: null, slaBreachedAt: null, firstResponseDueAt: { lt: now }, status: { in: ['NEW', 'ASSIGNED', 'IN_PROGRESS'] } }, take: 100 });
    for (const t of late) await this.prisma.$transaction(async (tx) => {
      await tx.doubtTicket.update({ where: { id: t.id }, data: { slaBreachedAt: now } });
      out.breached++;
      if (t.assignedTeacherId) await this.notes.notify(tx, t.assignedTeacherId, 'doubt.sla_breached', { ticketId: t.id });
      await this.notifyStaff(tx, 'doubt.sla_breached', { ticketId: t.id, priority: t.priority, teacherId: t.assignedTeacherId });
      if (t.assignedTeacherId && t.rerouteCount < 1) { // one automatic escalation to the next best teacher
        const to = await this.route(tx, t.id, [t.assignedTeacherId]);
        if (to) { await tx.doubtTicket.update({ where: { id: t.id }, data: { rerouteCount: { increment: 1 }, status: 'ASSIGNED' } }); out.rerouted++; }
        else await tx.doubtTicket.update({ where: { id: t.id }, data: { assignedTeacherId: t.assignedTeacherId, routingNote: 'SLA breached; no alternative teacher' } });
      }
    });
    out.closed = (await this.prisma.doubtTicket.updateMany({ where: { status: 'RESOLVED', resolvedAt: { lt: new Date(now.getTime() - REOPEN_DAYS * 86_400_000) } }, data: { status: 'CLOSED' } })).count;
    return out;
  }

  // ---- FAQ / remediation lifecycle (DCC-003) -----------------------------------------------------------------------
  async proposeFaq(ticketId: string, actor: Actor, b: { question: string; answer: string; language?: string; topicId?: string; kind?: string }) {
    if (!b.question?.trim() || !b.answer?.trim()) throw new BadRequestException('question and answer required');
    if (!['en', 'hi'].includes(b.language ?? 'en') || !['FAQ', 'REMEDIATION'].includes(b.kind ?? 'FAQ')) throw new BadRequestException('language en|hi, kind FAQ|REMEDIATION');
    const q = redactPii(b.question), a = redactPii(b.answer); // learner details must not leak into reusable content
    return this.prisma.$transaction(async (tx) => {
      const t = await this.ownTicket(tx, ticketId, actor, 'teacher');
      if (b.topicId && !(await tx.topic.findFirst({ where: { id: b.topicId, module: { versionId: t.versionId } } }))) throw new BadRequestException('topic not in this course version');
      const v = await tx.programmeVersion.findUniqueOrThrow({ where: { id: t.versionId } });
      const f = await tx.faqEntry.create({ data: { programmeId: v.programmeId, topicId: b.topicId ?? t.topicId, kind: b.kind ?? 'FAQ', language: b.language ?? 'en', question: q.text, answer: a.text, sourceTicketId: ticketId, proposedById: actor.id } });
      await this.audit.record(tx, { actor, action: 'faq.proposed', objectType: 'FaqEntry', objectId: f.id, after: { ticketId, redactions: q.count + a.count } });
      return f;
    });
  }

  async reviewFaq(id: string, actor: Actor, decision: string, reason?: string) {
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new BadRequestException('decision APPROVE|REJECT');
    if (decision === 'REJECT' && !reason?.trim()) throw new BadRequestException('reason required');
    const f = await this.prisma.$transaction(async (tx) => {
      const f = await tx.faqEntry.findUnique({ where: { id } });
      if (!f) throw new NotFoundException();
      if (f.status !== 'DRAFT') throw new ConflictException(`entry is ${f.status}`);
      if (f.proposedById === actor.id) throw new ConflictException('segregation of duties: proposer cannot review own entry');
      const u = await tx.faqEntry.update({ where: { id }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewedById: actor.id, reviewReason: reason, reviewedAt: new Date() } });
      if (decision === 'APPROVE') await this.index.upsertFaq(tx, u);
      await this.audit.record(tx, { actor, action: `faq.${decision === 'APPROVE' ? 'approved' : 'rejected'}`, objectType: 'FaqEntry', objectId: id, reason });
      return u;
    });
    if (decision === 'APPROVE') void this.index.embedPending();
    return f;
  }

  async retireFaq(id: string, actor: Actor, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.faqEntry.findUnique({ where: { id } });
      if (!f || f.status !== 'APPROVED') throw new ConflictException('only approved entries can be retired');
      await this.index.removeFaq(tx, id);
      const u = await tx.faqEntry.update({ where: { id }, data: { status: 'RETIRED', reviewReason: reason } });
      await this.audit.record(tx, { actor, action: 'faq.retired', objectType: 'FaqEntry', objectId: id, reason });
      return u;
    });
  }

  // ---- teacher directory (max 50 active) ----------------------------------------------------------------------------
  async upsertTeacher(userId: string, actor: Actor, b: any) {
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.userRole.findFirst({ where: { userId, role: 'DOUBT_TEACHER' } });
      if (!role) throw new BadRequestException('user does not hold the DOUBT_TEACHER role');
      const strs = (x: unknown, name: string) => { if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) throw new BadRequestException(`${name} must be string[]`); return x as string[]; };
      const data: any = {};
      if (b.disciplines !== undefined) data.disciplines = strs(b.disciplines, 'disciplines');
      if (b.skills !== undefined) data.skills = strs(b.skills, 'skills');
      if (b.languages !== undefined) { data.languages = strs(b.languages, 'languages'); if (data.languages.some((l: string) => !['en', 'hi'].includes(l))) throw new BadRequestException('languages en|hi'); }
      if (b.capacity !== undefined) { if (!Number.isInteger(b.capacity) || b.capacity < 1 || b.capacity > 100) throw new BadRequestException('capacity 1..100'); data.capacity = b.capacity; }
      if (b.active !== undefined) data.active = !!b.active;
      if (b.available !== undefined) data.available = !!b.available;
      if (b.windows !== undefined) { if (!Array.isArray(b.windows) || b.windows.some((w: any) => !(w.day >= 0 && w.day <= 6) || !/^\d\d:\d\d$/.test(w.start) || !/^\d\d:\d\d$/.test(w.end))) throw new BadRequestException('windows: [{day 0-6, start HH:MM, end HH:MM}]'); data.windows = b.windows; }
      const cur = await tx.teacherProfile.findUnique({ where: { userId } });
      if ((data.active ?? cur?.active ?? true) && !cur?.active) {
        const max = await this.config.get<number>('doubt.max_teachers');
        if ((await tx.teacherProfile.count({ where: { active: true } })) >= max) throw new ConflictException(`doubt centre is capped at ${max} active teachers`);
      }
      const p = await tx.teacherProfile.upsert({ where: { userId }, update: data, create: { userId, disciplines: [], skills: [], languages: ['en'], ...data } });
      await this.audit.record(tx, { actor, action: 'teacher.profile_set', objectType: 'TeacherProfile', objectId: userId, before: cur, after: p });
      return p;
    });
  }
}

@Controller('v1')
export class DoubtsController {
  constructor(private svc: DoubtService, private prisma: PrismaService, private prog: ProgressionService, private storage: StorageService, @Inject(SCANNER) private scanner: ScanProvider) {}

  // ---- learner ----------------------------------------------------------------------------------------------------
  @Post('doubts') @Roles('LEARNER')
  async create(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { entitlementId: 'string', subject: 'string', body: 'string', category: 'string' });
    const ent = await this.prisma.entitlement.findFirst({ where: { id: b.entitlementId, learnerId: a.id } });
    if (!ent || !hasLearningAccess(ent, new Date())) throw new ForbiddenException('no active entitlement');
    if (b.topicId && !(await this.prisma.topic.findFirst({ where: { id: b.topicId, module: { versionId: ent.versionId } } }))) throw new BadRequestException('topic not in your course');
    const att = Array.isArray(b.attachments) ? b.attachments : [];
    if (att.length > 5 || att.some((x: any) => typeof x?.key !== 'string' || !x.key.startsWith(`doubts/${a.id}/`))) throw new ForbiddenException('attachments must be your own uploads (max 5)');
    const ctx = await this.svc.contextBundle(this.prisma, a.id, ent, b.topicId ?? null);
    const t = await this.svc.create({ learnerId: a.id, entitlement: ent, topicId: b.topicId, category: b.category, subject: b.subject, body: b.body, blocked: !!b.blocked, source: 'MANUAL', contextBundle: ctx, attachments: att, actor: a });
    return this.svc.learnerView(t);
  }

  @Get('me/doubts') @Roles('LEARNER')
  async mine(@CurrentActor() a: Actor) { return (await this.prisma.doubtTicket.findMany({ where: { learnerId: a.id }, orderBy: { createdAt: 'desc' }, take: 100 })).map((t) => this.svc.learnerView(t)); }

  @Get('me/doubts/:id') @Roles('LEARNER')
  async mineOne(@Param('id') id: string, @CurrentActor() a: Actor) {
    const t = await this.prisma.doubtTicket.findFirst({ where: { id, learnerId: a.id } });
    if (!t) throw new NotFoundException();
    const teacher = t.assignedTeacherId ? await this.prisma.user.findUnique({ where: { id: t.assignedTeacherId }, select: { name: true } }) : null;
    return { ...this.svc.learnerView(t), teacher: teacher?.name?.split(' ')[0] ?? null, messages: await this.svc.thread(this.prisma, id, false),
      appointments: await this.prisma.appointment.findMany({ where: { ticketId: id }, orderBy: { startsAt: 'asc' }, select: { id: true, startsAt: true, endsAt: true, status: true, meetingRef: true } }) };
  }

  @Post('me/doubts/:id/messages') @Roles('LEARNER')
  msg(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.learnerMessage(id, a, b?.body, b?.attachments); }
  @Post('me/doubts/:id/reopen') @Roles('LEARNER') reopen(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.reopen(id, a); }
  @Post('me/doubts/:id/rating') @Roles('LEARNER') rate(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { rating: 'number' }); return this.svc.rate(id, a, b.rating, b.comment); }
  @Post('me/doubts/:id/appointments') @Roles('LEARNER')
  appt(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { startsAt: 'string', durationMin: 'number' }); return this.svc.requestAppointment(id, a, b.startsAt, b.durationMin); }

  @Put('doubts/upload') @Roles('LEARNER', 'DOUBT_TEACHER')
  async upload(@Query('name') name: string, @Req() req: any, @CurrentActor() a: Actor) {
    if (!name || !EXT.test(name) || /[\/\\]/.test(name)) throw new BadRequestException('file name/extension not allowed');
    const data = await readBody(req, 10 * 1024 * 1024);
    if (!data.length) throw new BadRequestException('empty file');
    if ((await this.scanner.scan(data, name)) !== 'CLEAN') throw new BadRequestException('file rejected by malware scan');
    const f = await this.storage.put(`doubts/${a.id}/${randomUUID()}-${name}`, data);
    return { key: f.key, name, size: f.size, checksum: f.checksum };
  }

  // ---- remediation content for a topic (approved only) -------------------------------------------------------------
  @Get('topics/:id/remediation') @Roles('LEARNER')
  async remediation(@Param('id') id: string, @CurrentActor() a: Actor) {
    const { topic, ent } = await this.prog.context(this.prisma, a.id, id);
    const lang = (await this.prisma.user.findUnique({ where: { id: a.id }, select: { language: true } }))?.language ?? 'en';
    const v = await this.prisma.programmeVersion.findUniqueOrThrow({ where: { id: ent.versionId } });
    return this.prisma.faqEntry.findMany({ where: { programmeId: v.programmeId, topicId: topic.id, kind: 'REMEDIATION', status: 'APPROVED', language: lang }, select: { id: true, question: true, answer: true } });
  }

  // ---- teacher workspace --------------------------------------------------------------------------------------------
  @Get('teacher/tickets') @Roles('DOUBT_TEACHER', ...STAFF)
  async queue(@Query('scope') scope: string | undefined, @Query('status') status: string | undefined, @CurrentActor() a: Actor) {
    const staff = a.roles.some((r) => STAFF.includes(r));
    let where: Prisma.DoubtTicketWhereInput;
    if (scope === 'unassigned') where = { status: 'NEW', assignedTeacherId: null };
    else if (scope === 'all' && staff) where = {};
    else where = { assignedTeacherId: a.id };
    if (status) where = { ...where, status };
    const rows = await this.prisma.doubtTicket.findMany({ where, orderBy: [{ priority: 'asc' }, { firstResponseDueAt: 'asc' }], take: 200 });
    return rows.map(({ contextBundle, learnerId, ...t }) => t);
  }

  @Get('teacher/tickets/:id') @Roles('DOUBT_TEACHER', ...STAFF)
  async ticket(@Param('id') id: string, @CurrentActor() a: Actor) {
    const t = await this.prisma.doubtTicket.findUnique({ where: { id } });
    const staff = a.roles.some((r) => STAFF.includes(r));
    if (!t || !(t.assignedTeacherId === a.id || staff || (t.status === 'NEW' && !t.assignedTeacherId))) throw new NotFoundException();
    const learner = await this.prisma.user.findUnique({ where: { id: t.learnerId }, select: { name: true, language: true } }); // no email/phone for teachers
    return { ...this.svc.asTeacherView(t), learner, messages: await this.svc.thread(this.prisma, id, true), appointments: await this.prisma.appointment.findMany({ where: { ticketId: id } }) };
  }

  @Post('teacher/tickets/:id/claim') @Roles('DOUBT_TEACHER') claim(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.claim(id, a); }
  @Post('teacher/tickets/:id/reply') @Roles('DOUBT_TEACHER', ...STAFF) reply(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.teacherReply(id, a, b ?? {}); }
  @Post('teacher/tickets/:id/resolve') @Roles('DOUBT_TEACHER', ...STAFF) resolve(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.resolve(id, a, b?.summary); }
  @Post('teacher/tickets/:id/propose-faq') @Roles('DOUBT_TEACHER') propose(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.proposeFaq(id, a, b ?? {}); }
  @Get('teacher/appointments') @Roles('DOUBT_TEACHER')
  appts(@CurrentActor() a: Actor) { return this.prisma.appointment.findMany({ where: { teacherId: a.id, status: { in: ['REQUESTED', 'CONFIRMED'] } }, orderBy: { startsAt: 'asc' } }); }
  @Post('teacher/appointments/:id/confirm') @Roles('DOUBT_TEACHER') confirm(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.decideAppointment(id, a, 'CONFIRM', b?.meetingRef); }
  @Post('appointments/:id/cancel') @Roles('DOUBT_TEACHER', 'LEARNER', ...STAFF) cancelAppt(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.decideAppointment(id, a, 'CANCEL'); }

  @Get('teacher/profile') @Roles('DOUBT_TEACHER')
  async myProfile(@CurrentActor() a: Actor) { const p = await this.prisma.teacherProfile.findUnique({ where: { userId: a.id } }); if (!p) throw new NotFoundException('no profile: ask an admin to register you'); return p; }
  @Put('teacher/profile') @Roles('DOUBT_TEACHER') // teachers manage only their own availability; skills/disciplines/capacity are admin-set
  myAvail(@Body() b: any, @CurrentActor() a: Actor) { return this.svc.upsertTeacher(a.id, a, { available: b?.available, windows: b?.windows }); }

  // ---- doubt-centre administration ---------------------------------------------------------------------------------
  @Get('doubt-centre/teachers') @Roles('ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_OPERATOR')
  async teachers() {
    const views = await (this.svc as any).teacherViews(this.prisma) as TeacherView[];
    const users = await this.prisma.user.findMany({ where: { id: { in: views.map((v) => v.userId) } }, select: { id: true, name: true } });
    return views.map((v) => ({ ...v, name: users.find((u) => u.id === v.userId)?.name }));
  }
  @Put('doubt-centre/teachers/:userId') @Roles('ACADEMIC_ADMIN', 'PLATFORM_ADMIN')
  setTeacher(@Param('userId') userId: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.upsertTeacher(userId, a, b ?? {}); }
  @Post('doubt-centre/tickets/:id/reassign') @Roles(...STAFF)
  reassign(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { reason: 'string' }); return this.svc.reassign(id, a, b.teacherId, b.reason); }
  @Post('doubt-centre/sweep') @Roles(...STAFF) sweep() { return this.svc.sweep(); }

  // ---- FAQ review ---------------------------------------------------------------------------------------------------
  @Get('faq') @Roles('FACULTY_REVIEWER', 'ACADEMIC_ADMIN', 'DOUBT_TEACHER', 'AUDITOR')
  faqs(@Query('status') status?: string, @Query('programmeId') programmeId?: string) { return this.prisma.faqEntry.findMany({ where: { ...(status && { status }), ...(programmeId && { programmeId }) }, orderBy: { createdAt: 'desc' }, take: 200 }); }
  @Post('faq/:id/review') @Roles('FACULTY_REVIEWER', 'ACADEMIC_ADMIN') review(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { decision: 'string' }); return this.svc.reviewFaq(id, a, b.decision, b.reason); }
  @Post('faq/:id/retire') @Roles('FACULTY_REVIEWER', 'ACADEMIC_ADMIN') retire(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.svc.retireFaq(id, a, b?.reason); }
}
