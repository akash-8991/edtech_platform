import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Injectable, Logger, NotFoundException, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, Roles, verifyPasswordAsync } from '../common/auth';
import { need } from '../common/http';
import { AuditService } from '../audit';
import { ConfigService } from '../ai/config';
import { NotificationsService } from '../notifications';
import { StorageService } from '../storage';
import { decryptBuffer, encryptBuffer, unwrapWithMaster, wrapWithMaster } from '../domain/media-crypto';
import { learnerToken, PROCTOR, ProctorProvider } from '../proctoring/provider';
import { SessionService } from '../security/sessions';
import { sha256 } from '../security/crypto';

export const NOTICE_VERSION = process.env.PRIVACY_NOTICE_VERSION ?? '2026-10';
export const PURPOSES = ['PLATFORM_PROCESSING', 'AI_TUTOR', 'ANALYTICS'] as const;
export const consentEnforced = () => process.env.PRIVACY_ENFORCE_CONSENT === '1' || (process.env.NODE_ENV === 'production' && process.env.PRIVACY_ENFORCE_CONSENT !== '0');
import { dataKeys, openWith, sealWith } from '../security/keyring';
const proctorSecret = () => process.env.EXAM_RECEIPT_SECRET ?? process.env.JWT_SECRET ?? 'dev-only';
const STAFF = ['PLATFORM_ADMIN', 'SUPER_ADMIN'];

@Injectable()
export class PrivacyService {
  private log = new Logger('privacy');
  constructor(private prisma: PrismaService, private audit: AuditService, private config: ConfigService, private notes: NotificationsService, private storage: StorageService, private sessions: SessionService, @Inject(PROCTOR) private proctor: ProctorProvider) {}

  // ---- consent (purpose-limited, versioned, withdrawable) -------------------------------------------------------------------------------
  async consents(userId: string) {
    const rows = await this.prisma.consentRecord.findMany({ where: { userId }, orderBy: { at: 'desc' } });
    return PURPOSES.map((p) => { const r = rows.find((x) => x.purpose === p); return { purpose: p, granted: !!r?.granted, version: r?.version ?? null, at: r?.at ?? null, currentNoticeVersion: NOTICE_VERSION, upToDate: r?.version === NOTICE_VERSION }; });
  }
  async setConsent(a: Actor, purpose: string, granted: boolean, version: string) {
    if (!(PURPOSES as readonly string[]).includes(purpose)) throw new BadRequestException(`purpose must be one of ${PURPOSES.join(',')}`);
    if (version !== NOTICE_VERSION) throw new ConflictException({ error: 'notice_changed', currentNoticeVersion: NOTICE_VERSION }); // consent is to a specific notice text
    await this.prisma.$transaction(async (tx) => { await tx.consentRecord.create({ data: { userId: a.id, purpose, granted, version, ip: a.ip } }); await this.audit.record(tx, { actor: a, action: granted ? 'privacy.consent_granted' : 'privacy.consent_withdrawn', objectType: 'User', objectId: a.id, after: { purpose, version } }); });
    return this.consents(a.id);
  }
  async hasConsent(userId: string, purpose: string) { if (!consentEnforced()) return true; const r = await this.prisma.consentRecord.findFirst({ where: { userId, purpose }, orderBy: { at: 'desc' } }); return !!r?.granted && r.version === NOTICE_VERSION; }

  // ---- data-subject requests ---------------------------------------------------------------------------------------------------------------
  async file(actor: Actor, userId: string, type: string, details: any, password?: string) {
    if (!['EXPORT', 'CORRECTION', 'ERASURE'].includes(type)) throw new BadRequestException('type EXPORT|CORRECTION|ERASURE');
    const onBehalf = userId !== actor.id;
    if (onBehalf && !actor.roles.some((r) => ['SUPPORT_OPERATOR', ...STAFF].includes(r))) throw new ForbiddenException();
    if (!onBehalf && ['EXPORT', 'ERASURE'].includes(type)) { // step-up: a stolen session must not be able to exfiltrate or destroy an account
      const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }); const s = actor.sid ? await this.prisma.userSession.findUnique({ where: { id: actor.sid } }) : null;
      const fresh = !!s && Date.now() - s.createdAt.getTime() < 15 * 60_000 && s.authMethod === 'OIDC';
      if (!fresh && !(u.passwordHash && password && (await verifyPasswordAsync(password, u.passwordHash)))) throw new ForbiddenException({ error: 'reauthentication_required', message: 'Confirm your password to continue' });
    }
    if (type === 'CORRECTION') { const d = details ?? {}; if (!(typeof d.name === 'string' && d.name.trim()) && !['en', 'hi'].includes(d.language)) throw new BadRequestException('details.name and/or details.language required'); }
    const open = await this.prisma.dataSubjectRequest.count({ where: { userId, type, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } } });
    if (open) throw new ConflictException(`an open ${type.toLowerCase()} request already exists`);
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.dataSubjectRequest.create({ data: { userId, type, details: type === 'ERASURE' ? { reason: String(details?.reason ?? '').slice(0, 500) } : (details ?? {}), requestedById: actor.id, status: type === 'EXPORT' && !onBehalf ? 'APPROVED' : 'REQUESTED' } }); // self-service exports need no approval
      await this.audit.record(tx, { actor, action: 'privacy.request_filed', objectType: 'DataSubjectRequest', objectId: r.id, after: { type, onBehalf } });
      return r;
    });
  }

  async decide(id: string, actor: Actor, decision: string, reason: string) {
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new BadRequestException('decision APPROVE|REJECT');
    if (!reason?.trim()) throw new BadRequestException('reason required');
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.dataSubjectRequest.findUnique({ where: { id } });
      if (!r) throw new NotFoundException();
      if (r.status !== 'REQUESTED') throw new ConflictException(`request is ${r.status}`);
      if (r.requestedById === actor.id || r.userId === actor.id) throw new ConflictException('segregation of duties: someone else must decide this request');
      const u = await tx.dataSubjectRequest.update({ where: { id }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decisionReason: reason } });
      await this.audit.record(tx, { actor, action: `privacy.request_${decision === 'APPROVE' ? 'approved' : 'rejected'}`, objectType: 'DataSubjectRequest', objectId: id, after: { type: r.type }, reason });
      await this.notes.notify(tx, r.userId, 'privacy.request_decided', { requestId: id, type: r.type, decision });
      return u;
    });
  }

  /** Worker/sweep entry point: performs every approved request. Each request is isolated: one failure never blocks the rest. */
  async process() {
    const out = { exports: 0, corrections: 0, erasures: 0, blocked: 0, failed: 0 };
    for (const r of await this.prisma.dataSubjectRequest.findMany({ where: { status: 'APPROVED' }, orderBy: { requestedAt: 'asc' }, take: 20 })) {
      const claimed = await this.prisma.dataSubjectRequest.updateMany({ where: { id: r.id, status: 'APPROVED' }, data: { status: 'PROCESSING' } }); if (!claimed.count) continue;
      try {
        if (r.type === 'EXPORT') { await this.runExport(r); out.exports++; }
        else if (r.type === 'CORRECTION') { await this.runCorrection(r); out.corrections++; }
        else { const res = await this.runErasure(r); res.blocked ? out.blocked++ : out.erasures++; }
      } catch (e: any) { out.failed++; this.log.error(`DSR ${r.id} failed: ${e?.message}`); await this.prisma.dataSubjectRequest.update({ where: { id: r.id }, data: { status: 'APPROVED', result: { lastError: String(e?.message ?? e).slice(0, 200) } as any } }); }
    }
    return out;
  }

  // ---- export (permissioned, encrypted at rest, expiring, audited) ------------------------------------------------------------------------------
  async bundle(userId: string) {
    const p = this.prisma; const u = await p.user.findUniqueOrThrow({ where: { id: userId } });
    const ents = await p.entitlement.findMany({ where: { learnerId: userId }, include: { version: { include: { programme: { select: { code: true, title: true } } } }, pauses: true } });
    const subs = await p.submission.findMany({ where: { learnerId: userId }, orderBy: { createdAt: 'asc' } }); const grades = await p.submissionGrade.findMany({ where: { learnerId: userId } });
    const recs = await p.gradeRecord.findMany({ where: { submissionId: { in: subs.map((s) => s.id) } }, orderBy: [{ submissionId: 'asc' }, { seq: 'asc' }] });
    const conv = await p.tutorConversation.findMany({ where: { learnerId: userId } }); const msgs = await p.tutorMessage.findMany({ where: { learnerId: userId }, orderBy: { createdAt: 'asc' } });
    const tickets = await p.doubtTicket.findMany({ where: { learnerId: userId } }); const tmsg = await p.ticketMessage.findMany({ where: { ticketId: { in: tickets.map((t) => t.id) }, internal: false }, orderBy: { createdAt: 'asc' } });
    const attempts = await p.examAttempt.findMany({ where: { learnerId: userId }, orderBy: { createdAt: 'asc' } });
    return { exportedAt: new Date().toISOString(), note: 'Internal integrity indicators, moderator notes, proctoring incident details and other people\'s data are not part of this export (see privacy notice).',
      profile: { id: u.id, name: u.name, email: u.email, language: u.language, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, mfaEnabled: u.mfaEnabled },
      consents: await p.consentRecord.findMany({ where: { userId }, orderBy: { at: 'asc' }, select: { purpose: true, granted: true, version: true, at: true } }), preferences: (await p.userPreference.findUnique({ where: { userId } }))?.prefs ?? {},
      entitlements: ents.map((e) => ({ programme: e.version.programme, version: e.version.version, duration: e.duration, cohort: e.cohort, status: e.status, startAt: e.startAt, endAt: e.endAt, pauses: e.pauses.map((x) => ({ startedAt: x.startedAt, endedAt: x.endedAt })) })),
      progress: await p.topicProgress.findMany({ where: { entitlementId: { in: ents.map((e) => e.id) } }, select: { topicId: true, videoDone: true, quizPassed: true, assignmentSubmitted: true, completedAt: true } }),
      quizAttempts: await p.quizAttempt.findMany({ where: { learnerId: userId }, select: { topicId: true, scorePercent: true, passed: true, submittedAt: true } }),
      submissions: subs.map((s) => { const g = grades.find((x) => x.submissionId === s.id); const rec = recs.filter((r) => r.submissionId === s.id).pop();
        return { id: s.id, topicId: s.topicId, attemptNo: s.attemptNo, submittedAt: s.createdAt, content: s.content, contentHash: s.contentHash, state: g?.state, ...(g && ['GRADED', 'FINAL'].includes(g.state) && rec ? { finalPercent: g.finalPercent, passed: g.passed, feedback: rec.feedback, dimensions: (rec.dimensions as any[]).map((d) => ({ id: d.id, score: d.score, max: d.max, rationale: d.rationale })), gradedBy: rec.kind === 'AI' ? 'AI' : 'Teacher' } : {}) }; }),
      tutor: conv.map((c) => ({ id: c.id, createdAt: c.createdAt, messages: msgs.filter((m) => m.conversationId === c.id).map((m) => ({ role: m.role, content: m.content, at: m.createdAt })) })),
      doubts: tickets.map((t) => ({ id: t.id, subject: t.subject, category: t.category, status: t.status, createdAt: t.createdAt, messages: tmsg.filter((m) => m.ticketId === t.id).map((m) => ({ from: m.authorRole, body: m.body, at: m.createdAt })) })),
      labs: await p.labBooking.findMany({ where: { learnerId: userId }, select: { activityId: true, status: true, attendedAt: true, completedAt: true } }),
      exams: attempts.map((a) => ({ examId: a.examId, attemptNo: a.attemptNo, status: a.status, submittedAt: a.submittedAt, ...(a.resultState === 'RELEASED' ? { score: (a.score as any)?.percent, passed: a.passed } : { result: 'not released' }) })),
      notifications: await p.notification.findMany({ where: { userId }, select: { type: true, createdAt: true } }), sessions: (await p.userSession.findMany({ where: { userId } })).map((s) => ({ device: s.deviceLabel, method: s.authMethod, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })) };
  }
  private async runExport(r: { id: string; userId: string }) {
    const days = await this.config.get<number>('retention.export_days'); const data = Buffer.from(JSON.stringify(await this.bundle(r.userId), null, 1));
    const enc = encryptBuffer(data); const k = `exports/${r.id}.enc`; await this.storage.put(k, enc.data);
    await this.prisma.$transaction(async (tx) => {
      await tx.dataSubjectRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date(), exportKey: k, exportCrypto: { wrapped: sealWith(dataKeys(), enc.key), iv: enc.iv.toString('base64'), tag: enc.tag.toString('base64') } as any, exportExpiresAt: new Date(Date.now() + days * 86_400_000), result: { bytes: data.length } as any } });
      await this.notes.notify(tx, r.userId, 'privacy.export_ready', { requestId: r.id, expiresInDays: days });
      await this.audit.record(tx, { actor: null, action: 'privacy.export_generated', objectType: 'DataSubjectRequest', objectId: r.id, after: { bytes: data.length } });
    });
  }
  async download(id: string, actor: Actor) {
    const r = await this.prisma.dataSubjectRequest.findFirst({ where: { id, userId: actor.id, type: 'EXPORT', status: 'COMPLETED' } });
    if (!r || !r.exportKey) throw new NotFoundException();
    if (!r.exportExpiresAt || r.exportExpiresAt < new Date()) throw new ConflictException('this export has expired: file a new request');
    const c: any = r.exportCrypto; const plain = decryptBuffer(await this.storage.get(r.exportKey), openWith(dataKeys(), c.wrapped), Buffer.from(c.iv, 'base64'), Buffer.from(c.tag, 'base64'));
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'privacy.export_downloaded', objectType: 'DataSubjectRequest', objectId: id })); return plain;
  }

  private async runCorrection(r: { id: string; userId: string; details: any; decidedById: string | null }) {
    const d = r.details as any; const data: any = {}; if (typeof d.name === 'string' && d.name.trim()) data.name = d.name.trim().slice(0, 120); if (['en', 'hi'].includes(d.language)) data.language = d.language;
    await this.prisma.$transaction(async (tx) => { const before = await tx.user.findUniqueOrThrow({ where: { id: r.userId }, select: { name: true, language: true } }); await tx.user.update({ where: { id: r.userId }, data });
      await tx.dataSubjectRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date(), result: { applied: Object.keys(data) } as any } });
      await this.audit.record(tx, { actor: r.decidedById ? { id: r.decidedById, roles: ['PLATFORM_ADMIN'] } : null, action: 'privacy.correction_applied', objectType: 'User', objectId: r.userId, before: { fields: Object.keys(before).filter((k) => k in data) }, after: { fields: Object.keys(data) } }); });
  }

  // ---- erasure ----------------------------------------------------------------------------------------------------------------------------------------
  /**
   * Erases personal data but keeps the academic record intact (grades, results, completion) for the institute's retention period, linked
   * only to a pseudonymous id. Blocked while an entitlement is live or a legal hold applies.
   */
  async runErasure(r: { id: string; userId: string; decidedById: string | null }) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    const live = await this.prisma.entitlement.count({ where: { learnerId: u.id, status: { in: ['ACTIVE', 'PAUSED'] }, endAt: { gt: new Date() } } });
    const block = u.legalHold ? 'legal hold' : live ? 'an entitlement is still active (revoke or let it expire first)' : u.status === 'ERASED' ? 'already erased' : null;
    if (block) { await this.prisma.dataSubjectRequest.update({ where: { id: r.id }, data: { status: 'BLOCKED', result: { reason: block } as any, completedAt: new Date() } }); return { blocked: true }; }
    const counts: Record<string, number> = {}; const deleteKeys: string[] = [];
    const ticketIds = (await this.prisma.doubtTicket.findMany({ where: { learnerId: u.id }, select: { id: true } })).map((t) => t.id);
    for (const m of await this.prisma.ticketMessage.findMany({ where: { ticketId: { in: ticketIds } } })) for (const a of (m.attachments as any[]) ?? []) if (a?.key) deleteKeys.push(a.key);
    const hadProctor = (await this.prisma.examAttempt.count({ where: { learnerId: u.id, providerSessionId: { not: null } } })) > 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.erasure', 'on', true)`; // transaction-local: only this routine may redact append-only tables
      counts.tutorMessages = (await tx.tutorMessage.updateMany({ where: { learnerId: u.id }, data: { content: '[erased]', citations: [], retrieved: { chunks: [] } as any, feedback: null } })).count;
      counts.ticketMessages = (await tx.ticketMessage.updateMany({ where: { ticketId: { in: ticketIds } }, data: { body: '[erased]', attachments: [] } })).count;
      counts.tickets = (await tx.doubtTicket.updateMany({ where: { learnerId: u.id }, data: { subject: '[erased]', contextBundle: {} } })).count;
      counts.applications = (await tx.learnerApplication.updateMany({ where: { learnerId: u.id }, data: { email: `erased-${u.id}@invalid.local`, name: 'Erased learner' } })).count;
      counts.notifications = (await tx.notification.deleteMany({ where: { userId: u.id } })).count; counts.preferences = (await tx.userPreference.deleteMany({ where: { userId: u.id } })).count;
      counts.devices = (await tx.device.deleteMany({ where: { userId: u.id } })).count; await tx.offlineLicense.updateMany({ where: { entitlementId: { in: (await tx.entitlement.findMany({ where: { learnerId: u.id }, select: { id: true } })).map((e) => e.id) }, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: 'erasure' } });
      counts.refreshTokens = (await tx.refreshToken.deleteMany({ where: { sessionId: { in: (await tx.userSession.findMany({ where: { userId: u.id }, select: { id: true } })).map((s) => s.id) } } })).count;
      await tx.user.update({ where: { id: u.id }, data: { email: `erased-${u.id}@invalid.local`, name: 'Erased learner', externalId: null, passwordHash: null, status: 'ERASED', erasedAt: new Date(), mfaEnabled: false, mfaSecretEnc: null, mfaBackupHashes: [], language: 'en' } });
      await this.audit.record(tx, { actor: r.decidedById ? { id: r.decidedById, roles: ['PLATFORM_ADMIN'] } : null, action: 'privacy.erasure_completed', objectType: 'User', objectId: u.id, after: { redacted: counts } });
    });
    await this.sessions.revokeAll(u.id, 'erasure');
    for (const k of deleteKeys) await this.storage.remove(k).catch(() => undefined); await this.storage.remove(`doubts/${u.id}`).catch(() => undefined);
    let external: Record<string, string> = {};
    if (hadProctor) { try { if (this.proctor.eraseLearner) { await this.proctor.eraseLearner(learnerToken(proctorSecret(), u.id)); external = { proctoringProvider: 'erasure requested' }; } else external = { proctoringProvider: 'provider has no erasure API: contact the vendor' }; } catch { external = { proctoringProvider: 'FAILED: follow up manually with the vendor' }; } }
    await this.prisma.dataSubjectRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date(), result: { redacted: counts, external, retained: ['grades and assignment submissions', 'exam attempts and released results', 'lab attendance/completion', 'learning events', 'consent history', 'audit trail'], retentionNote: 'Academic records are kept, pseudonymised, until the retention schedule expires.' } as any } });
    return { blocked: false };
  }

  // ---- retention ---------------------------------------------------------------------------------------------------------------------------------------
  async retention(dryRun = false, actor: Actor | null = null) {
    const days = async (k: string) => new Date(Date.now() - (await this.config.get<number>(k)) * 86_400_000);
    const cut = { notif: await days('retention.notifications_days'), tutor: await days('retention.tutor_days'), webhook: await days('retention.webhook_days'), sess: await days('retention.sessions_days') };
    const res: Record<string, number> = {};
    const q = {
      notifications: () => this.prisma.notification.count({ where: { createdAt: { lt: cut.notif } } }),
      tutorMessages: () => this.prisma.tutorMessage.count({ where: { createdAt: { lt: cut.tutor }, NOT: { content: '[expired]' } } }),
      webhookEvents: () => this.prisma.proctorWebhookEvent.count({ where: { receivedAt: { lt: cut.webhook } } }),
      sessions: () => this.prisma.userSession.count({ where: { OR: [{ expiresAt: { lt: cut.sess } }, { revokedAt: { lt: cut.sess } }] } }),
      oidcLogins: () => this.prisma.oidcLogin.count({ where: { expiresAt: { lt: new Date() } } }),
      exports: () => this.prisma.dataSubjectRequest.count({ where: { type: 'EXPORT', exportKey: { not: null }, exportExpiresAt: { lt: new Date() } } }),
    };
    for (const [k, f] of Object.entries(q)) res[k] = await f();
    if (dryRun) return { dryRun: true, wouldRemove: res };
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.erasure', 'on', true)`;
      await tx.notification.deleteMany({ where: { createdAt: { lt: cut.notif } } });
      await tx.tutorMessage.updateMany({ where: { createdAt: { lt: cut.tutor }, NOT: { content: '[expired]' } }, data: { content: '[expired]', citations: [], retrieved: { chunks: [] } as any } });
      await tx.proctorWebhookEvent.deleteMany({ where: { receivedAt: { lt: cut.webhook } } });
      const old = await tx.userSession.findMany({ where: { OR: [{ expiresAt: { lt: cut.sess } }, { revokedAt: { lt: cut.sess } }] }, select: { id: true }, take: 5000 }); // bounded; the daily run converges, a backlog drains over several runs
      await tx.refreshToken.deleteMany({ where: { sessionId: { in: old.map((o) => o.id) } } }); await tx.userSession.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
      await tx.oidcLogin.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    });
    for (const e of await this.prisma.dataSubjectRequest.findMany({ where: { type: 'EXPORT', exportKey: { not: null }, exportExpiresAt: { lt: new Date() } }, take: 500 })) { await this.storage.remove(e.exportKey!).catch(() => undefined); await this.prisma.dataSubjectRequest.update({ where: { id: e.id }, data: { exportKey: null, exportCrypto: Prisma.JsonNull } }); }
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'privacy.retention_run', objectType: 'Platform', objectId: 'retention', after: res })); return { dryRun: false, removed: res };
  }

  // ---- preferences (accessibility + localisation) ----------------------------------------------------------------------------------------------------
  static PREF_RULES: Record<string, (v: any) => boolean> = {
    captions: (v) => typeof v === 'boolean', transcriptByDefault: (v) => typeof v === 'boolean', audioDescription: (v) => typeof v === 'boolean', highContrast: (v) => typeof v === 'boolean', reducedMotion: (v) => typeof v === 'boolean',
    lowBandwidth: (v) => typeof v === 'boolean', largeTargets: (v) => typeof v === 'boolean', playbackSpeed: (v) => typeof v === 'number' && v >= 0.5 && v <= 2, fontScale: (v) => typeof v === 'number' && v >= 0.8 && v <= 2.5, language: (v) => ['en', 'hi'].includes(v),
    captionLanguage: (v) => ['en', 'hi'].includes(v), textSpacing: (v) => ['normal', 'wide', 'wider'].includes(v),
  };
  async setPrefs(a: Actor, b: any) {
    const bad = Object.keys(b ?? {}).filter((k) => !PrivacyService.PREF_RULES[k] || !PrivacyService.PREF_RULES[k](b[k])); if (bad.length) throw new BadRequestException({ error: 'invalid_preferences', fields: bad });
    const cur = ((await this.prisma.userPreference.findUnique({ where: { userId: a.id } }))?.prefs ?? {}) as object; const next = { ...cur, ...b };
    await this.prisma.$transaction(async (tx) => { await tx.userPreference.upsert({ where: { userId: a.id }, update: { prefs: next as any }, create: { userId: a.id, prefs: next as any } }); if (b.language) await tx.user.update({ where: { id: a.id }, data: { language: b.language } }); });
    return next;
  }
}

@Controller('v1')
export class PrivacyController {
  constructor(private svc: PrivacyService, private prisma: PrismaService, private audit: AuditService) {}

  @Get('me/consents') consents(@CurrentActor() a: Actor) { return this.svc.consents(a.id); }
  @Put('me/consents') setConsent(@Body() b: any, @CurrentActor() a: Actor) { need(b, { purpose: 'string', granted: 'boolean', version: 'string' }); return this.svc.setConsent(a, b.purpose, b.granted, b.version); }
  @Get('me/preferences') async prefs(@CurrentActor() a: Actor) { return (await this.prisma.userPreference.findUnique({ where: { userId: a.id } }))?.prefs ?? {}; }
  @Put('me/preferences') setPrefs(@Body() b: any, @CurrentActor() a: Actor) { return this.svc.setPrefs(a, b); }

  @Post('me/privacy/requests') file(@Body() b: any, @CurrentActor() a: Actor) { need(b, { type: 'string' }); return this.svc.file(a, a.id, b.type, b.details, b.password); }
  @Get('me/privacy/requests') mine(@CurrentActor() a: Actor) { return this.prisma.dataSubjectRequest.findMany({ where: { userId: a.id }, orderBy: { requestedAt: 'desc' }, select: { id: true, type: true, status: true, requestedAt: true, completedAt: true, exportExpiresAt: true, decisionReason: true } }); }
  @Get('me/privacy/requests/:id/download')
  async download(@Param('id') id: string, @CurrentActor() a: Actor, @Res() res: any) { const buf = await this.svc.download(id, a); res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"'); res.send(buf); }

  @Post('privacy/requests/on-behalf') @Roles('SUPPORT_OPERATOR', ...STAFF) onBehalf(@Body() b: any, @CurrentActor() a: Actor) { need(b, { userId: 'string', type: 'string' }); return this.svc.file(a, b.userId, b.type, b.details); }
  /** Requests with who they concern and who filed or decided them (names, so staff do not work from ids). Oldest first: the longest-waiting is first in line. */
  @Get('privacy/requests') @Roles(...STAFF, 'SUPPORT_OPERATOR', 'AUDITOR')
  async list(@Query('status') status?: string, @Query('type') type?: string) {
    const rows = await this.prisma.dataSubjectRequest.findMany({ where: { ...(status && { status: { in: status.split(',') } }), ...(type && { type }) }, orderBy: { requestedAt: 'asc' }, take: 200, select: { id: true, userId: true, type: true, status: true, requestedAt: true, requestedById: true, decidedById: true, decisionReason: true, completedAt: true, exportExpiresAt: true, details: true, result: true } });
    return this.enrich(rows);
  }
  private async enrich<T extends { userId: string; requestedById: string; decidedById: string | null }>(rows: T[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.userId, r.requestedById, r.decidedById].filter((x): x is string => !!x)))];
    const people = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, userName: people.get(r.userId)?.name ?? null, userEmail: people.get(r.userId)?.email ?? null, requestedByName: people.get(r.requestedById)?.name ?? null, decidedByName: r.decidedById ? people.get(r.decidedById)?.name ?? null : null, onBehalf: r.requestedById !== r.userId }));
  }
  /** One request with what would stop an erasure and the audited history, so the decision is made with the facts in front of the decider. */
  @Get('privacy/requests/:id') @Roles(...STAFF, 'SUPPORT_OPERATOR', 'AUDITOR')
  async one(@Param('id') id: string) {
    const r = await this.prisma.dataSubjectRequest.findUnique({ where: { id }, select: { id: true, userId: true, type: true, status: true, requestedAt: true, requestedById: true, decidedById: true, decisionReason: true, completedAt: true, exportExpiresAt: true, details: true, result: true } });
    if (!r) throw new NotFoundException();
    const [view] = await this.enrich([r]); const u = await this.prisma.user.findUnique({ where: { id: r.userId }, select: { legalHold: true, status: true, erasedAt: true } });
    const live = await this.prisma.entitlement.count({ where: { learnerId: r.userId, status: { in: ['ACTIVE', 'PAUSED'] }, endAt: { gt: new Date() } } });
    // The request's own events, plus the carrying-out of an erasure or correction, which is audited against the person rather than the request.
    const events = await this.prisma.auditEvent.findMany({ where: { OR: [{ objectType: 'DataSubjectRequest', objectId: id }, { objectType: 'User', objectId: r.userId, action: { in: ['privacy.erasure_completed', 'privacy.correction_applied'] }, createdAt: { gte: r.requestedAt } }] }, orderBy: { seq: 'asc' }, select: { seq: true, actorId: true, action: true, reason: true, createdAt: true } });
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    return { ...view, subject: { legalHold: !!u?.legalHold, erased: !!u?.erasedAt, activeEntitlements: live }, history: events.map((e) => ({ at: e.createdAt, by: e.actorId ? names.get(e.actorId) ?? 'Unknown' : 'The system', action: e.action, reason: e.reason })) };
  }
  @Post('privacy/requests/:id/decide') @Roles(...STAFF) decide(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { need(b, { decision: 'string', reason: 'string' }); return this.svc.decide(id, a, b.decision, b.reason); }
  @Post('privacy/process') @Roles(...STAFF) process() { return this.svc.process(); }
  @Post('privacy/retention/run') @Roles(...STAFF) retention(@Query('dryRun') dryRun: string | undefined, @CurrentActor() a: Actor) { return this.svc.retention(dryRun === 'true', a); }
  @Put('privacy/users/:id/legal-hold') @Roles(...STAFF)
  async hold(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { hold: 'boolean', reason: 'string' });
    await this.prisma.$transaction(async (tx) => { await tx.user.update({ where: { id }, data: { legalHold: b.hold } }); await this.audit.record(tx, { actor: a, action: b.hold ? 'privacy.legal_hold_set' : 'privacy.legal_hold_cleared', objectType: 'User', objectId: id, reason: b.reason }); }); return { ok: true };
  }
}
