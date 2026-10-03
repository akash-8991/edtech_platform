import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, GoneException, Headers, Injectable, Logger, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService, ReadDb } from '../common/prisma.service';
import { Actor, CurrentActor, Public, Roles } from '../common/auth';
import { need } from '../common/http';
import { paged } from '../common/page';
import { AuditService } from '../audit';
import { ConfigService } from '../ai/config';
import { NotificationsService } from '../notifications';
import { resultStateFor, scoreAttempt } from '../domain/exam';
import { verifyChain } from '../domain/audit-chain';
import { verifyWebhook } from '../proctoring/provider';
import { ExamsService } from './exams';

type Db = Prisma.TransactionClient | PrismaService;
const EXAM_ADMIN = ['EXAM_ADMIN', 'ASSESSMENT_ADMIN'];
const ADJ = ['FACULTY_REVIEWER', 'ASSESSMENT_ADMIN'];          // may decide incidents and outcomes
const RELEASERS = ['ASSESSMENT_ADMIN', 'ACADEMIC_ADMIN'];      // may release results
const OPS_READ = [...new Set([...EXAM_ADMIN, ...ADJ, ...RELEASERS, 'AUDITOR', 'PLATFORM_ADMIN'])];
const SEV: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const DECISIONS = ['DISMISSED', 'CONFIRMED_MINOR', 'CONFIRMED_MAJOR', 'NEEDS_INFO'];
const ref = (id: string, salt: string) => createHash('sha256').update(id + salt).digest('hex').slice(0, 8);

@Injectable()
export class ExamOpsService {
  private log = new Logger('exam-ops');
  constructor(private prisma: PrismaService, private audit: AuditService, private config: ConfigService, private notes: NotificationsService, private exams: ExamsService) {}

  // ---- result state machine ------------------------------------------------------------------------------------------------------------------
  /** Re-derive HELD/READY/INVALIDATED. A released result is only pulled back if a serious incident arrives late. */
  async recompute(tx: Db, attemptId: string, lateSerious = false) {
    const a = await tx.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    if (a.status !== 'SUBMITTED') return a;
    const s = await tx.examSession.findUniqueOrThrow({ where: { id: a.sessionId } });
    const inc = await tx.incident.findMany({ where: { attemptId } });
    const state = resultStateFor({ submitted: true, mode: s.mode as any, proctorFinal: a.proctorReportFinal, reportWaived: false, incidentStatuses: inc.map((i) => i.status), outcome: a.outcome });
    if (a.resultState === 'RELEASED') {
      if (!lateSerious) return a;
      return tx.examAttempt.update({ where: { id: a.id }, data: { resultState: 'HELD', releasedAt: null, releasedById: null } }); // pulled back for re-review
    }
    if (a.resultState === state) return a;
    return tx.examAttempt.update({ where: { id: a.id }, data: { resultState: state, ...(state === 'INVALIDATED' ? { releasedAt: new Date() } : {}) } });
  }

  // ---- provider webhook (EXM-003) -----------------------------------------------------------------------------------------------------------------
  async webhook(raw: string, headers: { ts?: string; sig?: string }) {
    if (!verifyWebhook(process.env.PROCTOR_WEBHOOK_SECRET, headers.ts, headers.sig, raw)) throw new UnauthorizedException();
    let ev: any; try { ev = JSON.parse(raw); } catch { throw new BadRequestException('invalid JSON'); }
    if (typeof ev?.eventId !== 'string' || typeof ev.sessionId !== 'string' || typeof ev.type !== 'string') throw new BadRequestException('eventId, sessionId and type required');
    const provider = this.exams.proctor.name;
    return this.prisma.$transaction(async (tx) => {
      const dup = await tx.proctorWebhookEvent.createMany({ data: [{ provider, eventId: ev.eventId, payload: ev }], skipDuplicates: true });
      if (!dup.count) return { status: 'duplicate' }; // replay-safe
      const a = await tx.examAttempt.findFirst({ where: { providerSessionId: ev.sessionId } });
      if (!a) return { status: 'unknown_session' };
      if (ev.type === 'identity_verified') await this.exams.setIdentity(a.id, 'VERIFIED', 'PROVIDER', null).catch(() => undefined);
      else if (ev.type === 'identity_failed') await this.exams.setIdentity(a.id, 'FAILED', 'PROVIDER', null, ev.detail?.reason).catch(() => undefined);
      else if (ev.type === 'incident') await this.addIncident(tx, a.id, { source: 'PROVIDER', type: String(ev.incidentType ?? ev.detail?.type ?? 'provider_flag'), severity: ev.severity, occurredAt: ev.occurredAt, evidenceUrl: ev.evidenceUrl, evidenceExpiresAt: ev.evidenceExpiresAt, detail: ev.detail, providerEventId: ev.eventId });
      else if (ev.type === 'report_final') { await tx.examAttempt.update({ where: { id: a.id }, data: { proctorReportFinal: true } }); await this.exams.appendEvent(tx, a.id, 'PROCTOR_REPORT_FINAL', {}); await this.recompute(tx, a.id); }
      return { status: 'accepted' };
    });
  }

  async addIncident(tx: Db, attemptId: string, i: { source: string; type: string; severity?: string; occurredAt?: string; evidenceUrl?: string; evidenceExpiresAt?: string; detail?: any; providerEventId?: string }) {
    const severity = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(i.severity ?? '') ? i.severity! : 'MEDIUM';
    const url = i.evidenceUrl && /^https:\/\//.test(i.evidenceUrl) ? i.evidenceUrl : null; // evidence links must be https
    const inc = await tx.incident.create({ data: { attemptId, source: i.source, type: i.type.slice(0, 60), severity, occurredAt: i.occurredAt && !isNaN(Date.parse(i.occurredAt)) ? new Date(i.occurredAt) : new Date(), providerEventId: i.providerEventId, evidenceUrl: url, evidenceExpiresAt: url && i.evidenceExpiresAt ? new Date(i.evidenceExpiresAt) : null, detail: (i.detail ?? {}) as any } });
    await this.exams.appendEvent(tx, attemptId, 'INCIDENT', { incidentId: inc.id, type: inc.type, severity, source: i.source });
    await this.recompute(tx, attemptId, ['HIGH', 'CRITICAL'].includes(severity));
    return inc;
  }

  async manualIncident(attemptId: string, actor: Actor, b: { type: string; severity?: string; detail?: any }) {
    if (!b.type?.trim()) throw new BadRequestException('type required');
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.examAttempt.findUnique({ where: { id: attemptId } }))) throw new NotFoundException();
      const inc = await this.addIncident(tx, attemptId, { source: 'PROCTOR', type: b.type, severity: b.severity, detail: { ...(b.detail ?? {}), recordedById: actor.id } });
      await this.audit.record(tx, { actor, action: 'incident.recorded', objectType: 'ExamAttempt', objectId: attemptId, after: { incidentId: inc.id, type: inc.type, severity: inc.severity } });
      return inc;
    });
  }

  // ---- adjudication (EXM-004) ---------------------------------------------------------------------------------------------------------------------
  async decideIncident(id: string, actor: Actor, decision: string, reason: string) {
    if (!DECISIONS.includes(decision)) throw new BadRequestException(`decision must be one of ${DECISIONS.join(',')}`);
    if (!reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const inc = await tx.incident.findUnique({ where: { id } });
      if (!inc) throw new NotFoundException();
      if ((inc.detail as any)?.recordedById === actor.id) throw new ConflictException('segregation of duties: you recorded this incident and cannot adjudicate it');
      const a = await tx.examAttempt.findUniqueOrThrow({ where: { id: inc.attemptId } });
      if (a.learnerId === actor.id) throw new ForbiddenException();
      const u = await tx.incident.update({ where: { id }, data: { status: decision, decidedById: actor.id, decisionReason: reason, decidedAt: new Date() } });
      await this.exams.appendEvent(tx, inc.attemptId, 'INCIDENT_DECISION', { incidentId: id, decision });
      await this.audit.record(tx, { actor, action: 'incident.decided', objectType: 'Incident', objectId: id, before: { status: inc.status }, after: { status: decision, severity: inc.severity, type: inc.type }, reason });
      await this.recompute(tx, inc.attemptId);
      return u;
    });
  }

  async setOutcome(attemptId: string, actor: Actor, outcome: string, reason: string) {
    if (!['VALID', 'INVALIDATED'].includes(outcome)) throw new BadRequestException('outcome VALID|INVALIDATED');
    if (!reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.examAttempt.findUnique({ where: { id: attemptId } });
      if (!a || a.status !== 'SUBMITTED') throw new NotFoundException('submitted attempt not found');
      if (a.learnerId === actor.id) throw new ForbiddenException();
      if (await tx.incident.count({ where: { attemptId, status: { in: ['OPEN', 'NEEDS_INFO'] } } })) throw new ConflictException('decide every open incident first');
      if (a.resultState === 'RELEASED' && outcome === 'VALID') throw new ConflictException('result already released');
      await tx.examAttempt.update({ where: { id: attemptId }, data: { outcome, outcomeReason: reason, outcomeById: actor.id } });
      await this.exams.appendEvent(tx, attemptId, 'OUTCOME', { outcome });
      const u = await this.recompute(tx, attemptId, outcome === 'INVALIDATED');
      if (outcome === 'INVALIDATED') { await tx.examAttempt.update({ where: { id: attemptId }, data: { resultState: 'INVALIDATED', releasedAt: new Date() } }); await this.notes.notify(tx, a.learnerId, 'exam.invalidated', { attemptId }); }
      await this.audit.record(tx, { actor, action: 'exam.outcome_set', objectType: 'ExamAttempt', objectId: attemptId, after: { outcome, resultState: outcome === 'INVALIDATED' ? 'INVALIDATED' : u.resultState }, reason });
      return tx.examAttempt.findUniqueOrThrow({ where: { id: attemptId } }).then((x) => ({ outcome: x.outcome, resultState: x.resultState }));
    });
  }

  private async adjudicatorIds(tx: Db, attemptId: string) {
    const [inc, a] = await Promise.all([tx.incident.findMany({ where: { attemptId, decidedById: { not: null } }, select: { decidedById: true } }), tx.examAttempt.findUnique({ where: { id: attemptId }, select: { outcomeById: true } })]);
    return [...new Set([...inc.map((i) => i.decidedById!), ...(a?.outcomeById ? [a.outcomeById] : [])])];
  }

  /** Authorised release: result must be READY, and the releaser cannot be someone who adjudicated this attempt. */
  async release(attemptId: string, actor: Actor, tx0?: Db) {
    const run = async (tx: Db) => {
      const a = await tx.examAttempt.findUnique({ where: { id: attemptId } });
      if (!a || a.status !== 'SUBMITTED') throw new NotFoundException();
      if (a.resultState === 'RELEASED') throw new ConflictException('already released');
      if (a.resultState !== 'READY') throw new ConflictException({ error: 'not_ready_for_release', resultState: a.resultState });
      if ((await this.adjudicatorIds(tx, attemptId)).includes(actor.id)) throw new ConflictException('segregation of duties: you adjudicated this attempt; another authorised person must release it');
      const u = await tx.examAttempt.update({ where: { id: attemptId }, data: { resultState: 'RELEASED', releasedAt: new Date(), releasedById: actor.id } });
      await this.exams.appendEvent(tx, attemptId, 'RELEASED', { by: actor.id });
      await this.notes.notify(tx, a.learnerId, 'exam.result_released', { attemptId });
      await this.audit.record(tx, { actor, action: 'exam.result_released', objectType: 'ExamAttempt', objectId: attemptId, after: { percent: (a.score as any)?.percent, passed: a.passed } });
      return u;
    };
    return tx0 ? run(tx0) : this.prisma.$transaction(run);
  }

  async releaseSession(sessionId: string, actor: Actor) {
    const ready = await this.prisma.examAttempt.findMany({ where: { sessionId, status: 'SUBMITTED', resultState: 'READY' }, select: { id: true } });
    const out = { released: 0, skipped: [] as { attemptId: string; reason: string }[] };
    for (const r of ready) { try { await this.release(r.id, actor); out.released++; } catch (e: any) { out.skipped.push({ attemptId: r.id, reason: e?.response?.error ?? e?.message ?? 'error' }); } }
    return out;
  }

  async waiveReport(attemptId: string, actor: Actor, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.examAttempt.findUnique({ where: { id: attemptId } }); if (!a || a.status !== 'SUBMITTED') throw new NotFoundException();
      await tx.examAttempt.update({ where: { id: attemptId }, data: { proctorReportFinal: true } });
      await this.exams.appendEvent(tx, attemptId, 'PROCTOR_REPORT_WAIVED', { by: actor.id });
      await this.audit.record(tx, { actor, action: 'exam.proctor_report_waived', objectType: 'ExamAttempt', objectId: attemptId, reason });
      return this.recompute(tx, attemptId);
    });
  }

  // ---- appeals -----------------------------------------------------------------------------------------------------------------------------------------------
  async appeal(attemptId: string, actor: Actor, reason: string) {
    if (!reason || reason.trim().length < 20) throw new BadRequestException('explain your appeal in at least 20 characters');
    const days = await this.config.get<number>('exam.appeal_window_days');
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.examAttempt.findFirst({ where: { id: attemptId, learnerId: actor.id } });
      if (!a) throw new NotFoundException();
      const affected = a.resultState === 'INVALIDATED' || (a.resultState === 'RELEASED' && (await tx.incident.count({ where: { attemptId, status: { in: ['CONFIRMED_MINOR', 'CONFIRMED_MAJOR'] } } })) > 0);
      if (!affected) throw new ConflictException('only an invalidated result or one affected by a confirmed incident can be appealed');
      if (!a.releasedAt || Date.now() - a.releasedAt.getTime() > days * 86_400_000) throw new ConflictException('the appeal window has closed');
      if (await tx.examAppeal.count({ where: { attemptId } })) throw new ConflictException('this result has already been appealed');
      const x = await tx.examAppeal.create({ data: { attemptId, learnerId: actor.id, reason: reason.trim(), excludedAdjudicators: await this.adjudicatorIds(tx, attemptId) } });
      await this.audit.record(tx, { actor, action: 'exam.appealed', objectType: 'ExamAttempt', objectId: attemptId, reason });
      return { appealId: x.id, status: 'OPEN' };
    });
  }

  async decideAppeal(id: string, actor: Actor, decision: string, reason: string) {
    if (!['UPHELD', 'OVERTURNED'].includes(decision)) throw new BadRequestException('decision UPHELD|OVERTURNED');
    if (!reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const ap = await tx.examAppeal.findUnique({ where: { id } });
      if (!ap) throw new NotFoundException();
      if (ap.status !== 'OPEN') throw new ConflictException(`appeal is ${ap.status}`);
      if (ap.excludedAdjudicators.includes(actor.id)) throw new ForbiddenException('conflict of interest: you adjudicated the original decision');
      await tx.examAppeal.update({ where: { id }, data: { status: decision, decidedById: actor.id, decision: reason, decidedAt: new Date() } });
      if (decision === 'OVERTURNED') { // the appeal decision is itself the authorised release of a valid result
        await tx.examAttempt.update({ where: { id: ap.attemptId }, data: { outcome: 'VALID', outcomeReason: `appeal overturned: ${reason}`, outcomeById: actor.id, resultState: 'RELEASED', releasedAt: new Date(), releasedById: actor.id } });
        await this.exams.appendEvent(tx, ap.attemptId, 'APPEAL_OVERTURNED', { by: actor.id });
      }
      await this.notes.notify(tx, ap.learnerId, 'exam.appeal_decided', { attemptId: ap.attemptId, decision });
      await this.audit.record(tx, { actor, action: 'exam.appeal_decided', objectType: 'ExamAttempt', objectId: ap.attemptId, after: { decision }, reason });
      return { decision };
    });
  }

  // ---- evidence access: restricted, expiring, audited -----------------------------------------------------------------------------------------------------
  async evidence(id: string, actor: Actor) {
    const inc = await this.prisma.incident.findUnique({ where: { id } });
    if (!inc || !inc.evidenceUrl) throw new NotFoundException('no evidence');
    // Log first, in its own transaction: a refused (expired) access must still leave a trace, not roll back with the error.
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'incident.evidence_accessed', objectType: 'Incident', objectId: id, after: { attemptId: inc.attemptId, expired: !!inc.evidenceExpiresAt && inc.evidenceExpiresAt < new Date() } }));
    if (inc.evidenceExpiresAt && inc.evidenceExpiresAt < new Date()) throw new GoneException('evidence link expired: request a fresh link from the provider');
    return { url: inc.evidenceUrl, expiresAt: inc.evidenceExpiresAt };
  }

  // ---- case file (blind to the score), event-log verification --------------------------------------------------------------------------------------------
  async caseFile(attemptId: string) {
    const a = await this.prisma.examAttempt.findUnique({ where: { id: attemptId } });
    if (!a) throw new NotFoundException();
    const [events, incidents, s, acc] = await Promise.all([this.prisma.examEvent.findMany({ where: { attemptId }, orderBy: { seq: 'asc' } }), this.prisma.incident.findMany({ where: { attemptId }, orderBy: { occurredAt: 'asc' } }), this.prisma.examSession.findUniqueOrThrow({ where: { id: a.sessionId } }), this.prisma.examAccommodation.findMany({ where: { learnerId: a.learnerId, active: true } })]);
    return { attemptId, learnerRef: ref(a.learnerId, a.id), attemptNo: a.attemptNo, mode: s.mode, status: a.status, resultState: a.resultState, outcome: a.outcome, deviceCheck: a.deviceCheck, idCheck: a.idCheck, sessionSwitches: a.sessionSwitches, autoSubmitted: a.autoSubmitted,
      accommodations: acc.map((x) => ({ type: x.type, extraTimePercent: x.extraTimePercent })), startedAt: a.startedAt, submittedAt: a.submittedAt, proctorReportFinal: a.proctorReportFinal,
      incidents: incidents.map((i) => ({ id: i.id, source: i.source, type: i.type, severity: i.severity, status: i.status, occurredAt: i.occurredAt, hasEvidence: !!i.evidenceUrl, decisionReason: i.decisionReason })),
      timeline: events.map((e) => ({ seq: e.seq, type: e.type, at: e.at, payload: e.type === 'SAVE' ? { seq: (e.payload as any).seq, answered: (e.payload as any).answered } : e.payload })) }; // no score: adjudicators decide integrity blind to performance
  }
  async verifyLog(attemptId: string) {
    const rows = await this.prisma.examEvent.findMany({ where: { attemptId }, orderBy: { seq: 'asc' } });
    const bad = verifyChain(rows.map((r) => ({ prevHash: r.prevHash, hash: r.hash, payload: { attemptId, seq: r.seq, type: r.type, payload: r.payload, at: r.at.toISOString() } })));
    return { events: rows.length, intact: bad === null, firstBrokenIndex: bad };
  }

  // ---- sweeps ---------------------------------------------------------------------------------------------------------------------------------------------------
  async sweep() {
    const autoSubmitted = await this.exams.autoSubmitExpired();
    let polled = 0;
    const pending = await this.prisma.examAttempt.findMany({ where: { status: 'SUBMITTED', providerSessionId: { not: null }, proctorReportFinal: false, submittedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, take: 50 });
    for (const a of pending) { // webhook fallback: pull the report if the callback never arrived
      try {
        const r = await this.exams.proctor.fetchReport(a.providerSessionId!); polled++;
        await this.prisma.$transaction(async (tx) => {
          for (const i of r.incidents) { if (await tx.incident.findUnique({ where: { providerEventId: i.eventId } })) continue; await this.addIncident(tx, a.id, { source: 'PROVIDER', type: i.type, severity: i.severity, occurredAt: i.occurredAt, evidenceUrl: i.evidenceUrl, evidenceExpiresAt: i.evidenceExpiresAt, providerEventId: i.eventId }); }
          if (r.final) { await tx.examAttempt.update({ where: { id: a.id }, data: { proctorReportFinal: true } }); await this.recompute(tx, a.id); }
        });
      } catch (e: any) { this.log.warn(`report poll failed for ${a.id}: ${e?.message}`); }
    }
    return { autoSubmitted, reportsPolled: polled };
  }
}

@Controller('v1')
export class ExamOpsController {
  constructor(private ops: ExamOpsService, private prisma: PrismaService, private read: ReadDb, private exams: ExamsService, private audit: AuditService) {}

  // inbound from the proctoring provider (signed)
  @Public() @Post('proctoring/webhook')
  webhook(@Req() req: any, @Headers('x-timestamp') ts: string, @Headers('x-signature') sig: string) { return this.ops.webhook(req.rawBody?.toString() ?? '', { ts, sig }); }

  // ---- learner results & appeals -------------------------------------------------------------------------------------------------------------------------------
  @Get('me/exam-attempts/:id') @Roles('LEARNER')
  async result(@Param('id') id: string, @CurrentActor() a: Actor) {
    const at = await this.prisma.examAttempt.findFirst({ where: { id, learnerId: a.id } });
    if (!at) throw new NotFoundException();
    const exam = await this.prisma.examDefinition.findUniqueOrThrow({ where: { id: at.examId } });
    const sub = at.status === 'SUBMITTED' ? await this.prisma.examSubmission.findUnique({ where: { attemptId: id } }) : null;
    const base = { attemptId: id, status: at.status, receiptCode: sub?.receiptCode ?? null, submittedAt: at.submittedAt };
    if (at.status !== 'SUBMITTED') return base;
    if (at.resultState === 'RELEASED') { const sc = at.score as any; return { ...base, state: 'RELEASED', percent: sc.percent, passed: at.passed, passMark: exam.passPercent, sections: Object.fromEntries(Object.entries(sc.sections).map(([k, v]: any) => [k, { percent: v.max ? Math.round((v.points / v.max) * 100) : 0 }])), appeal: { eligible: false } }; }
    if (at.resultState === 'INVALIDATED') return { ...base, state: 'INVALIDATED', message: 'Your attempt was invalidated after an integrity review.', reason: at.outcomeReason, appeal: { eligible: !(await this.prisma.examAppeal.count({ where: { attemptId: id } })) } };
    return { ...base, state: at.resultState === 'READY' ? 'AWAITING_RELEASE' : 'UNDER_REVIEW', message: at.resultState === 'READY' ? 'Your result is awaiting authorised release.' : 'Your result is being reviewed.' }; // no incident details, no score
  }
  @Post('me/exam-attempts/:id/appeal') @Roles('LEARNER') appeal(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.ops.appeal(id, a, b?.reason); }

  // ---- proctor / adjudicator / releaser ----------------------------------------------------------------------------------------------------------------------------
  @Post('proctor/attempts/:id/verify-id') @Roles(...EXAM_ADMIN)
  async verifyId(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { status: 'string' }); if (!['VERIFIED', 'FAILED'].includes(b.status)) throw new BadRequestException('status VERIFIED|FAILED'); if (!b.note?.trim()) throw new BadRequestException('note required');
    const r = await this.exams.setIdentity(id, b.status, 'CENTRE_PROCTOR', a.id, b.note);
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor: a, action: 'exam.identity_set', objectType: 'ExamAttempt', objectId: id, after: { status: b.status }, reason: b.note })); return { status: r.status };
  }
  @Post('proctor/attempts/:id/incidents') @Roles(...EXAM_ADMIN) manual(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.ops.manualIncident(id, a, b ?? {}); }

  /** Staff index of exams with their sessions and how many results are in each state (the learner list is /me/exams). */
  @Get('exam-ops/exams') @Roles(...OPS_READ)
  async examIndex() {
    const exams = await this.prisma.examDefinition.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const sessions = await this.prisma.examSession.findMany({ where: { examId: { in: exams.map((e) => e.id) } }, orderBy: { startsAt: 'desc' } });
    const counts = await this.prisma.examAttempt.groupBy({ by: ['sessionId', 'status', 'resultState'], where: { sessionId: { in: sessions.map((x) => x.id) } }, _count: true });
    return exams.map((e) => ({ id: e.id, code: e.code, title: e.title, status: e.status, durationMin: e.durationMin, passPercent: e.passPercent, publishedAt: e.publishedAt,
      sessions: sessions.filter((x) => x.examId === e.id).map((x) => { const c = counts.filter((k) => k.sessionId === x.id); const n = (f: (k: (typeof c)[number]) => boolean) => c.filter(f).reduce((t, k) => t + k._count, 0);
        return { id: x.id, startsAt: x.startsAt, endsAt: x.endsAt, mode: x.mode, centre: x.centre, capacity: x.capacity, status: x.status, attempts: { total: n(() => true), inProgress: n((k) => k.status === 'IN_PROGRESS'), submitted: n((k) => k.status === 'SUBMITTED'), held: n((k) => k.resultState === 'HELD'), ready: n((k) => k.resultState === 'READY'), released: n((k) => k.resultState === 'RELEASED'), invalidated: n((k) => k.resultState === 'INVALIDATED') } }; }) }));
  }
  @Get('exam-ops/incidents') @Roles(...OPS_READ)
  async queue(@Query('status') status: string | undefined, @Query('severity') severity: string | undefined) {
    const rows = await this.prisma.incident.findMany({ where: { status: status ? { in: status.split(',') } : { in: ['OPEN', 'NEEDS_INFO'] }, ...(severity && { severity }) }, orderBy: { occurredAt: 'asc' }, take: 300 });
    return rows.sort((x, y) => SEV[x.severity] - SEV[y.severity] || x.occurredAt.getTime() - y.occurredAt.getTime()).map((i) => ({ id: i.id, attemptId: i.attemptId, source: i.source, type: i.type, severity: i.severity, status: i.status, occurredAt: i.occurredAt, hasEvidence: !!i.evidenceUrl, ageMinutes: Math.round((Date.now() - i.createdAt.getTime()) / 60_000) }));
  }
  @Get('exam-ops/attempts/:id/case') @Roles(...ADJ, 'EXAM_ADMIN', 'AUDITOR') case(@Param('id') id: string) { return this.ops.caseFile(id); }
  @Get('exam-ops/attempts/:id/verify-log') @Roles(...OPS_READ) verify(@Param('id') id: string) { return this.ops.verifyLog(id); }
  @Post('exam-ops/incidents/:id/decide') @Roles(...ADJ) decide(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { decision: 'string', reason: 'string' }); return this.ops.decideIncident(id, a, b.decision, b.reason); }
  @Get('incidents/:id/evidence') @Roles(...ADJ, 'EXAM_ADMIN') evidence(@Param('id') id: string, @CurrentActor() a: Actor) { return this.ops.evidence(id, a); }
  @Post('exam-ops/attempts/:id/outcome') @Roles(...ADJ) outcome(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { outcome: 'string', reason: 'string' }); return this.ops.setOutcome(id, a, b.outcome, b.reason); }
  @Post('exam-ops/attempts/:id/waive-report') @Roles(...EXAM_ADMIN) waive(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.ops.waiveReport(id, a, b?.reason); }
  @Post('exam-ops/attempts/:id/release') @Roles(...RELEASERS) release(@Param('id') id: string, @CurrentActor() a: Actor) { return this.ops.release(id, a); }
  @Post('exam-ops/sessions/:id/release-ready') @Roles(...RELEASERS) releaseSession(@Param('id') id: string, @CurrentActor() a: Actor) { return this.ops.releaseSession(id, a); }
  @Get('exam-ops/attempts/:id/result') @Roles(...RELEASERS, 'AUDITOR')
  async opsResult(@Param('id') id: string) { const a = await this.prisma.examAttempt.findUnique({ where: { id } }); if (!a) throw new NotFoundException(); return { attemptId: id, resultState: a.resultState, outcome: a.outcome, score: a.score, passed: a.passed }; }
  @Post('exam-ops/appeals/:id/decide') @Roles(...ADJ) decideAppeal(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { decision: 'string', reason: 'string' }); return this.ops.decideAppeal(id, a, b.decision, b.reason); }
  @Get('exam-ops/appeals') @Roles(...OPS_READ) appeals(@Res({ passthrough: true }) res: any, @Query('status') status?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) { return paged(res, limit, cursor, (a) => this.prisma.examAppeal.findMany({ where: { status: status ?? 'OPEN' }, orderBy: [{ filedAt: 'asc' }, { id: 'asc' }], ...a, select: { id: true, attemptId: true, reason: true, status: true, filedAt: true } })); }
  @Post('exam-ops/sweep') @Roles(...EXAM_ADMIN, ...RELEASERS) sweep() { return this.ops.sweep(); }

  /** Exam-mode operations dashboard (TRD: autosave health, proctor callbacks, incident queue). */
  @Get('exam-ops/status') @Roles(...OPS_READ)
  async status() {
    const now = Date.now();
    // One aggregate query (not every in-progress attempt loaded into memory): this endpoint is polled during a 10,000-attempt exam.
    const staleCut = new Date(now - 90_000), soon = new Date(now + 5 * 60_000);
    const [live] = await this.prisma.$queryRaw<{ n: bigint; stale: bigint; expiring: bigint; switches: bigint }[]>`
      SELECT count(*)::bigint n,
             count(*) FILTER (WHERE COALESCE("lastSavedAt", "startedAt") < (${staleCut} AT TIME ZONE 'UTC'))::bigint stale,
             count(*) FILTER (WHERE "deadlineAt" < (${soon} AT TIME ZONE 'UTC'))::bigint expiring,
             count(*) FILTER (WHERE "sessionSwitches" >= 3)::bigint switches
      FROM "ExamAttempt" WHERE status = 'IN_PROGRESS'`;
    const stale = Number(live.stale);
    const inc = await this.prisma.incident.groupBy({ by: ['severity'], where: { status: { in: ['OPEN', 'NEEDS_INFO'] } }, _count: true });
    return { inProgress: Number(live.n), staleAutosave: stale, expiringWithin5Min: Number(live.expiring), noRecentSave: stale, highSessionSwitches: Number(live.switches),
      openIncidents: Object.fromEntries(inc.map((i) => [i.severity, i._count])), heldResults: await this.prisma.examAttempt.count({ where: { resultState: 'HELD' } }), awaitingRelease: await this.prisma.examAttempt.count({ where: { resultState: 'READY' } }),
      remoteAwaitingProctorReport: await this.prisma.examAttempt.count({ where: { status: 'SUBMITTED', providerSessionId: { not: null }, proctorReportFinal: false } }), webhookEventsLastHour: await this.prisma.proctorWebhookEvent.count({ where: { receivedAt: { gt: new Date(now - 3_600_000) } } }), openAppeals: await this.prisma.examAppeal.count({ where: { status: 'OPEN' } }) };
  }

  /** Results, item analysis, integrity and funnel (BRD: exam integrity dashboard). */
  @Get('reports/exams') @Roles(...OPS_READ)
  async report(@Query('examId') examId: string) {
    return this.read.run(async (db) => {
    if (!examId) throw new BadRequestException('examId required');
    const exam = await db.examDefinition.findUnique({ where: { id: examId } }); if (!exam) throw new NotFoundException();
    // Keyset-batched pass: memory is O(batch + distinct questions), not O(attempts). Aggregates are accumulated per batch.
    const pct: number[] = []; let nAttempts = 0, started = 0, nSub = 0, released = 0, held = 0, invalidated = 0, autoSub = 0, takeovers = 0, passed = 0, nScored = 0;
    const sec = new Map<string, { p: number; m: number }>(); const items = new Map<string, { right: number; n: number }>();
    const incs: any[] = []; const appeals: any[] = []; const confirmedAttempts = new Set<string>();
    for (let cursor: string | undefined; ;) {
      const batch = await db.examAttempt.findMany({ where: { examId }, orderBy: { id: 'asc' }, take: 2000, ...(cursor && { cursor: { id: cursor }, skip: 1 }) });
      if (!batch.length) break; cursor = batch[batch.length - 1].id; nAttempts += batch.length;
      const ids = batch.map((a) => a.id);
      for (const a of batch) {
        if (a.startedAt) started++; if (a.sessionSwitches >= 3) takeovers++;
        if (a.status !== 'SUBMITTED') continue; nSub++;
        if (a.resultState === 'RELEASED') released++; if (a.resultState === 'HELD') held++; if (a.resultState === 'INVALIDATED') invalidated++; if (a.autoSubmitted) autoSub++;
        if (!a.score || a.outcome === 'INVALIDATED') continue; nScored++; if (a.passed) passed++; pct.push((a.score as any).percent as number);
        for (const [k, v] of Object.entries((a.score as any).sections) as any) { const e = sec.get(k) ?? { p: 0, m: 0 }; e.p += v.points; e.m += v.max; sec.set(k, e); }
        for (const it of (a.score as any).perItem ?? []) { const e = items.get(it.questionId) ?? { right: 0, n: 0 }; e.n++; if (it.correct) e.right++; items.set(it.questionId, e); }
      }
      for (const i of await db.incident.findMany({ where: { attemptId: { in: ids } }, select: { type: true, severity: true, status: true, attemptId: true } })) { incs.push(i); if (i.status.startsWith('CONFIRMED')) confirmedAttempts.add(i.attemptId); }
      for (const ap of await db.examAppeal.findMany({ where: { attemptId: { in: ids } }, select: { status: true } })) appeals.push(ap);
    }
    const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);
    const regs = await db.examRegistration.count({ where: { examId, status: 'REGISTERED' } });
    const by = (xs: any[], f: (x: any) => string) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {} as Record<string, number>);
    const inc = incs;
    return { exam: { code: exam.code, passPercent: exam.passPercent }, funnel: { registered: regs, checkedIn: nAttempts, started, submitted: nSub, released, held, invalidated, autoSubmitted: autoSub },
      results: { n: nScored, mean: mean(pct), passRate: nScored ? Math.round((passed / nScored) * 100) / 100 : null, distribution: Array.from({ length: 10 }, (_, i) => pct.filter((p) => Math.min(9, Math.floor(p / 10)) === i).length) },
      sections: Object.fromEntries([...sec].map(([k, v]) => [k, Math.round((v.p / v.m) * 100)])), itemAnalysis: [...items].map(([id, v]) => ({ questionId: id, attempts: v.n, pValue: Math.round((v.right / v.n) * 100) / 100 })).sort((a, b) => a.pValue - b.pValue).slice(0, 20),
      integrity: { incidents: inc.length, byType: by(inc, (i) => i.type), bySeverity: by(inc, (i) => i.severity), byStatus: by(inc, (i) => i.status), confirmedRate: nSub ? Math.round((confirmedAttempts.size / nSub) * 100) / 100 : null, sessionTakeovers: takeovers },
      appeals: { filed: appeals.length, overturned: appeals.filter((a) => a.status === 'OVERTURNED').length, open: appeals.filter((a) => a.status === 'OPEN').length } };
  });
  }
}
