import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { verifyJwt } from '../security/keyring';
import { HttpException, Inject } from '@nestjs/common';
import type { SessionService } from '../security/sessions'; // type-only: avoids an import cycle through the config/audit modules
import { limiter, limits } from '../platform/ratelimit';
import { metrics } from '../platform/metrics';
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'crypto';

export interface Actor { id: string; roles: string[]; ip?: string; correlationId?: string; sid?: string }

export const Public = () => SetMetadata('public', true);
export const Roles = (...r: string[]) => SetMetadata('roles', r);
/** Per-actor requests/minute for an expensive route (overrides the default). */
export const RateLimit = (perMin: number) => SetMetadata('rate_limit', perMin);
export const CurrentActor = createParamDecorator((_: unknown, c: ExecutionContext): Actor => c.switchToHttp().getRequest().actor);

export const hashPassword = (pw: string) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`;
};
// Password hashing is deliberately expensive. The async variants run on the libuv threadpool so a login burst never blocks the event loop
// (the sync variants stalled every in-flight request on the instance for ~50 ms each). Concurrency is capped so hashing cannot starve
// the threadpool that fs/dns also use.
let active = 0; const waiting: (() => void)[] = []; const MAX_HASH = Number(process.env.HASH_CONCURRENCY ?? 4);
const scryptAsync = async (pw: string, salt: Buffer): Promise<Buffer> => {
  if (active >= MAX_HASH) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await new Promise<Buffer>((res, rej) => scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k)))); }
  finally { active--; waiting.shift()?.(); }
};
export const hashPasswordAsync = async (pw: string) => { const salt = randomBytes(16); return `${salt.toString('hex')}:${(await scryptAsync(pw, salt)).toString('hex')}`; };
export const verifyPasswordAsync = async (pw: string, stored: string) => {
  const [s, h] = stored.split(':'); const a = await scryptAsync(pw, Buffer.from(s, 'hex')), b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
export const verifyPassword = (pw: string, stored: string) => {
  const [s, h] = stored.split(':');
  const a = scryptSync(pw, Buffer.from(s, 'hex'), 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Global guard. Identity comes from a JWT issued by the (swappable) identity provider (IAM-006:
 * OIDC/SAML adapter replaces AuthService.login; the guard only needs verified claims {sub, roles}).
 * Default-deny: a route needs @Public() or a valid token; @Roles() further restricts.
 */
export const STAFF_ROLE_LIST = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'ACADEMIC_ADMIN', 'CONTENT_AUTHOR', 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', 'ASSESSMENT_ADMIN', 'EXAM_ADMIN', 'DOUBT_TEACHER', 'SUPPORT_OPERATOR', 'AUDITOR', 'LAB_COORDINATOR'];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector, @Inject('SESSION_SERVICE') private sessions: SessionService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    req.correlationId = req.headers['x-correlation-id'] ?? randomBytes(8).toString('hex');
    if (this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()])) return true;
    const h: string = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) throw new UnauthorizedException();
    let claims: any;
    try { claims = await verifyJwt(this.jwt, h.slice(7)); } catch { throw new UnauthorizedException(); }
    // single-purpose tokens (MFA step, enrolment) are never accepted as access tokens; every access token is tied to a live session
    if (claims.purpose || !claims.sid || !(await this.sessions.isActive(claims.sid, claims.sub))) throw new UnauthorizedException();
    // SUPER_ADMIN is the super user: it holds every staff role for every check, in guards and services alike. Separation of duties (author != approver etc.) is by person, so it still applies. LEARNER is not added: learner routes stay about the person's own learning.
    const roles: string[] = claims.roles ?? [];
    req.actor = { id: claims.sub, roles: roles.includes('SUPER_ADMIN') ? [...new Set([...roles, ...STAFF_ROLE_LIST])] : roles, ip: req.ip, correlationId: req.correlationId, sid: claims.sid } as Actor;
    const need = this.reflector.getAllAndOverride<string[]>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (need && !req.actor.roles.includes('SUPER_ADMIN') && !need.some((r) => req.actor.roles.includes(r))) throw new ForbiddenException('insufficient role');
    return true;
  }
}


/** Per-actor rate limit, applied after authentication. Public routes are limited per IP by the middleware and, for login, in AuthService. */
@Injectable()
export class ActorRateLimitGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    const l = limits(); const req = ctx.switchToHttp().getRequest();
    if (l.disabled || !req.actor) return true;
    const per = this.reflector.getAllAndOverride<number>('rate_limit', [ctx.getHandler(), ctx.getClass()]);
    const key = per ? `actor:${req.actor.id}:${ctx.getHandler().name}` : `actor:${req.actor.id}`;
    const t = await limiter.take(key, per ?? l.actor);
    if (!t.allowed) { ctx.switchToHttp().getResponse().setHeader('Retry-After', Math.ceil(t.resetMs / 1000)); metrics.inc('rate_limited_total', { scope: 'actor' }, 1, 'Requests rejected by rate limiting'); throw new HttpException({ error: 'rate_limited', message: 'Too many requests' }, 429); }
    return true;
  }
}
