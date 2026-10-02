import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { redis, redisSubscriber } from '../platform/redis';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '../ai/config';

/**
 * Session registry. isActive() sits on every authenticated request, so it is cached for a few seconds per instance:
 * With REDIS_URL, revocation is fanned out over pub/sub so every instance drops its cached entry immediately; without it (or if a
 * message is missed) revocation still reaches all instances within TTL.
 */
const CHANNEL = 'sessions:revoked';
@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private sub: Redis | null = null;
  private cache = new Map<string, { ok: boolean; until: number }>();
  private touched = new Map<string, number>();
  static TTL_MS = Number(process.env.SESSION_CACHE_MS ?? 5000);
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  onModuleInit() {
    this.sub = redisSubscriber();
    if (!this.sub) return;
    this.sub.on('error', () => undefined);
    void this.sub.subscribe(CHANNEL).catch(() => undefined);
    this.sub.on('message', (_c, msg) => { for (const sid of msg.split(',')) this.cache.delete(sid); });
  }
  onModuleDestroy() { this.sub?.disconnect(); }
  private broadcast(sids: string[]) { const r = redis(); if (r && sids.length) void r.publish(CHANNEL, sids.join(',')).catch(() => undefined); }

  async isActive(sid: string, userId: string): Promise<boolean> {
    const now = Date.now(); const c = this.cache.get(sid);
    if (c && c.until > now) return c.ok;
    const s = await this.prisma.userSession.findUnique({ where: { id: sid } });
    const ok = !!s && s.userId === userId && !s.revokedAt && s.expiresAt > new Date() && (await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } }))?.status === 'ACTIVE';
    this.cache.set(sid, { ok, until: now + SessionService.TTL_MS }); if (this.cache.size > 100_000) this.cache.clear();
    if (ok && (this.touched.get(sid) ?? 0) < now - 5 * 60_000) { this.touched.set(sid, now); void this.prisma.userSession.update({ where: { id: sid }, data: { lastSeenAt: new Date() } }).catch(() => undefined); } // at most one write per 5 min
    return ok;
  }
  forget(sid: string) { this.cache.delete(sid); }

  async create(userId: string, o: { method: 'PASSWORD' | 'OIDC'; mfa: boolean; privileged: boolean; ip?: string; ua?: string; label?: string }) {
    const hours = o.privileged ? await this.config.get<number>('security.privileged_session_hours') : (await this.config.get<number>('security.session_days')) * 24;
    const s = await this.prisma.userSession.create({ data: { userId, authMethod: o.method, mfa: o.mfa, ip: o.ip, uaHash: o.ua ? require('crypto').createHash('sha256').update(o.ua).digest('hex').slice(0, 16) : null, deviceLabel: (o.label ?? o.ua ?? '').slice(0, 80), expiresAt: new Date(Date.now() + hours * 3_600_000) } });
    const max = await this.config.get<number>('security.max_sessions');
    const live = await this.prisma.userSession.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'asc' } });
    for (const old of live.slice(0, Math.max(0, live.length - max))) await this.revoke(old.id, 'session_limit');
    return s;
  }

  async revoke(sid: string, reason: string) { await this.prisma.userSession.updateMany({ where: { id: sid, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } }); this.forget(sid); this.broadcast([sid]); }
  async revokeAll(userId: string, reason: string, exceptSid?: string) {
    const live = await this.prisma.userSession.findMany({ where: { userId, revokedAt: null, ...(exceptSid && { NOT: { id: exceptSid } }) }, select: { id: true } });
    await this.prisma.userSession.updateMany({ where: { id: { in: live.map((l) => l.id) } }, data: { revokedAt: new Date(), revokeReason: reason } }); live.forEach((l) => this.forget(l.id)); this.broadcast(live.map((l) => l.id)); return live.length;
  }
}
