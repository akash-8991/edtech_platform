import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { Actor, hashPassword, hashPasswordAsync, verifyPasswordAsync } from '../common/auth';
import { AuditService } from '../audit';
import { limiter, limits } from '../platform/ratelimit';
import { metrics } from '../platform/metrics';
import { base32Decode, base32Encode, hashBackup, newBackupCodes, newSecret, otpauthUri, passwordIssues, verifyTotp } from '../domain/totp';
import { openSecret, sealSecret } from './crypto';
import { verifyJwt } from './keyring';
import { SessionService } from './sessions';

const DUMMY = hashPassword('dummy-password-for-timing'); // verified when the account does not exist, so response time doesn't reveal it
const LOCK_AFTER = 5, LOCK_MINUTES = 15;
const ISSUER = process.env.MFA_ISSUER ?? 'EdTech Platform';
export const isPrivileged = (roles: string[]) => roles.some((r) => r !== 'LEARNER');
export const mfaEnforced = () => process.env.MFA_ENFORCE === '1' || (process.env.NODE_ENV === 'production' && process.env.MFA_ENFORCE !== '0');
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
export interface Ctx { ip?: string; ua?: string; label?: string }

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private sessions: SessionService, private audit: AuditService) {}

  private generic() { return new UnauthorizedException({ error: 'invalid_credentials', message: 'Invalid credentials or account temporarily locked' }); }
  private async auditSafe(actor: Actor | null, action: string, objectId: string, extra: object = {}) { // security events must never take a request down
    try { await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action, objectType: 'User', objectId, after: extra })); } catch { /* best effort */ }
  }

  /** Counts a failed credential check; locks the account after repeated failures. Audited at most once a minute per user (no audit-lock DoS). */
  private async failed(userId: string, kind: 'login' | 'mfa') {
    const u = await this.prisma.user.update({ where: { id: userId }, data: { failedLogins: { increment: 1 } } });
    const lock = u.failedLogins >= LOCK_AFTER;
    if (lock) await this.prisma.user.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } });
    metrics.inc('auth_failures_total', { kind }, 1, 'Failed authentication attempts');
    if (lock) await this.auditSafe(null, 'auth.account_locked', userId, { kind, minutes: LOCK_MINUTES });
    else if ((await limiter.take(`authaudit:${userId}`, 1, 60_000)).allowed) await this.auditSafe(null, `auth.${kind}_failed`, userId);
  }

  async login(email: string, password: string, ctx: Ctx) {
    const l = limits(); const em = email.toLowerCase();
    if (!l.disabled) {
      if (!(await limiter.take(`login:ip:${ctx.ip}`, l.login)).allowed || !(await limiter.take(`login:acct:${em}`, Math.max(10, l.login / 2), 10 * 60_000)).allowed) throw new HttpException({ error: 'rate_limited', message: 'Too many sign-in attempts' }, 429);
    }
    const u = await this.prisma.user.findUnique({ where: { email: em }, include: { roles: true } });
    if (!u || !u.passwordHash) { await verifyPasswordAsync(password, DUMMY); throw this.generic(); }
    const ok = await verifyPasswordAsync(password, u.passwordHash);
    if (u.status !== 'ACTIVE' || (u.lockedUntil && u.lockedUntil > new Date())) throw this.generic();
    if (!ok) { await this.failed(u.id, 'login'); throw this.generic(); }
    const roles = [...new Set(u.roles.map((r) => r.role as string))];
    if (isPrivileged(roles) && mfaEnforced()) {
      if (!u.mfaEnabled) return { mfaEnrollmentRequired: true, enrollmentToken: await this.jwt.signAsync({ sub: u.id, purpose: 'mfa_enroll' }, { expiresIn: '10m' }) };
      return { mfaRequired: true, mfaToken: await this.jwt.signAsync({ sub: u.id, purpose: 'mfa' }, { expiresIn: '5m' }) };
    }
    await this.prisma.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    return this.issue(u.id, roles, { method: 'PASSWORD', mfa: false }, ctx);
  }

  async issue(userId: string, roles: string[], o: { method: 'PASSWORD' | 'OIDC'; mfa: boolean }, ctx: Ctx) {
    const s = await this.sessions.create(userId, { method: o.method, mfa: o.mfa, privileged: isPrivileged(roles), ip: ctx.ip, ua: ctx.ua, label: ctx.label });
    const refresh = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({ data: { sessionId: s.id, tokenHash: tokenHash(refresh), expiresAt: s.expiresAt } });
    return { accessToken: await this.jwt.signAsync({ sub: userId, roles, sid: s.id, amr: o.mfa ? ['pwd', 'mfa'] : [o.method === 'OIDC' ? 'sso' : 'pwd'] }, { expiresIn: '15m' }), refreshToken: refresh, expiresIn: 900, roles, sessionId: s.id };
  }

  // ---- MFA ---------------------------------------------------------------------------------------------------------------------
  private async purposeUser(token: string, purpose: string) {
    let c: any; try { c = await verifyJwt(this.jwt, token); } catch { throw new UnauthorizedException(); }
    if (c.purpose !== purpose) throw new UnauthorizedException(); return c.sub as string;
  }
  async verifyMfa(mfaToken: string, code: string, ctx: Ctx) {
    const id = await this.purposeUser(mfaToken, 'mfa');
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: { roles: true } });
    if (u.status !== 'ACTIVE' || (u.lockedUntil && u.lockedUntil > new Date()) || !u.mfaEnabled || !u.mfaSecretEnc) throw this.generic();
    const clean = String(code ?? '').replace(/\s/g, '');
    const step = verifyTotp(openSecret(u.mfaSecretEnc), clean, Date.now(), u.mfaLastStep);
    let used = false;
    if (step !== null) await this.prisma.user.update({ where: { id }, data: { mfaLastStep: step } });
    else { const h = hashBackup(clean); if (u.mfaBackupHashes.includes(h)) { await this.prisma.user.update({ where: { id }, data: { mfaBackupHashes: u.mfaBackupHashes.filter((x) => x !== h) } }); used = true; } }
    if (step === null && !used) { await this.failed(id, 'mfa'); throw this.generic(); }
    if (used) await this.auditSafe(null, 'auth.backup_code_used', id, { remaining: u.mfaBackupHashes.length - 1 });
    await this.prisma.user.update({ where: { id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    return this.issue(id, [...new Set(u.roles.map((r) => r.role as string))], { method: 'PASSWORD', mfa: true }, ctx);
  }

  /** Accepts an enrolment token (forced enrolment at login) or a normal access token (voluntary enrolment). */
  async enrollStart(bearer: string) {
    const { userId } = await this.enrolUser(bearer);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.mfaEnabled) throw new ConflictException('MFA is already enabled; ask an administrator to reset it');
    const secret = newSecret(); await this.prisma.user.update({ where: { id: userId }, data: { mfaSecretEnc: sealSecret(secret) } });
    const b32 = base32Encode(secret); return { secret: b32, otpauthUri: otpauthUri(ISSUER, u.email, b32) };
  }
  private async enrolUser(bearer: string): Promise<{ userId: string; forced: boolean }> {
    let c: any; try { c = await verifyJwt(this.jwt, bearer); } catch { throw new UnauthorizedException(); }
    if (c.purpose === 'mfa_enroll') return { userId: c.sub, forced: true };
    if (!c.purpose && c.sid && (await this.sessions.isActive(c.sid, c.sub))) return { userId: c.sub, forced: false };
    throw new UnauthorizedException();
  }
  async enrollConfirm(bearer: string, code: string, ctx: Ctx) {
    const { userId, forced } = await this.enrolUser(bearer);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { roles: true } });
    if (u.mfaEnabled || !u.mfaSecretEnc) throw new ConflictException('start enrolment first');
    const step = verifyTotp(openSecret(u.mfaSecretEnc), String(code ?? '').replace(/\s/g, ''), Date.now(), 0);
    if (step === null) { await this.failed(userId, 'mfa'); throw new BadRequestException('code did not match: check your authenticator clock and try again'); }
    const backup = newBackupCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true, mfaLastStep: step, mfaBackupHashes: backup.map(hashBackup), failedLogins: 0 } });
    await this.auditSafe(null, 'auth.mfa_enrolled', userId);
    const out: any = { enabled: true, backupCodes: backup }; // shown exactly once
    if (forced) Object.assign(out, await this.issue(userId, [...new Set(u.roles.map((r) => r.role as string))], { method: 'PASSWORD', mfa: true }, ctx));
    return out;
  }

  // ---- refresh / logout / sessions ----------------------------------------------------------------------------------------------------
  async refresh(token: string, ctx: Ctx) {
    const rt = await this.prisma.refreshToken.findUnique({ where: { tokenHash: tokenHash(token ?? '') } });
    if (!rt) throw new UnauthorizedException();
    const s = await this.prisma.userSession.findUnique({ where: { id: rt.sessionId } });
    if (!s || s.revokedAt || s.expiresAt < new Date() || rt.expiresAt < new Date()) throw new UnauthorizedException();
    if (rt.usedAt) { // a rotated token was presented again: assume theft, kill the whole session
      await this.sessions.revoke(s.id, 'refresh_token_reuse'); await this.auditSafe(null, 'auth.refresh_reuse', s.userId, { sessionId: s.id }); throw new UnauthorizedException();
    }
    const u = await this.prisma.user.findUnique({ where: { id: s.userId }, include: { roles: true } });
    if (!u || u.status !== 'ACTIVE') { await this.sessions.revoke(s.id, 'user_inactive'); throw new UnauthorizedException(); }
    const next = randomBytes(32).toString('base64url');
    const claimed = await this.prisma.refreshToken.updateMany({ where: { id: rt.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!claimed.count) { await this.sessions.revoke(s.id, 'refresh_token_reuse'); throw new UnauthorizedException(); } // lost a race with a replay
    await this.prisma.refreshToken.create({ data: { sessionId: s.id, tokenHash: tokenHash(next), expiresAt: s.expiresAt } });
    const roles = [...new Set(u.roles.map((r) => r.role as string))]; // roles are re-read: a demotion takes effect at the next refresh
    return { accessToken: await this.jwt.signAsync({ sub: u.id, roles, sid: s.id, amr: s.mfa ? ['pwd', 'mfa'] : ['pwd'] }, { expiresIn: '15m' }), refreshToken: next, expiresIn: 900, roles };
  }
  async logout(a: Actor) { if (a.sid) await this.sessions.revoke(a.sid, 'logout'); return { ok: true }; }

  async changePassword(a: Actor, current: string, next: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    if (!u.passwordHash || !(await verifyPasswordAsync(current ?? '', u.passwordHash))) { await this.failed(u.id, 'login'); throw this.generic(); }
    const issues = passwordIssues(next, u.email); if (issues.length) throw new BadRequestException({ error: 'weak_password', issues });
    await this.prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPasswordAsync(next) } });
    const n = await this.sessions.revokeAll(u.id, 'password_changed', a.sid); // every other device is signed out
    await this.auditSafe(a, 'auth.password_changed', u.id, { sessionsRevoked: n }); return { ok: true, otherSessionsRevoked: n };
  }

  async adminRevoke(actor: Actor, userId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('reason required');
    const n = await this.sessions.revokeAll(userId, `admin:${reason.slice(0, 60)}`);
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'auth.sessions_revoked_by_admin', objectType: 'User', objectId: userId, after: { revoked: n }, reason })); return { revoked: n };
  }
  async adminMfaReset(actor: Actor, userId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('reason required');
    if (userId === actor.id) throw new ForbiddenException('you cannot reset your own MFA');
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaBackupHashes: [], mfaLastStep: 0 } });
    const n = await this.sessions.revokeAll(userId, 'mfa_reset');
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'auth.mfa_reset', objectType: 'User', objectId: userId, after: { sessionsRevoked: n }, reason })); return { ok: true };
  }
}
