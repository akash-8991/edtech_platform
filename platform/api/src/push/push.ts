import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Inject, Injectable, NotFoundException, Optional, Param, Post } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, RateLimit } from '../common/auth';
import { need } from '../common/http';
import { PUSH_PROVIDERS, PushMessage, PushProvider, PushResult, PushTarget } from './providers';
import { pushMessage } from './text';

const MAX_DEVICES = 10, MAX_FAILURES = 5, FRESH_MS = 24 * 3600_000;
const PLATFORMS = ['WEB', 'IOS', 'ANDROID'];

@Injectable()
export class PushService {
  constructor(private prisma: PrismaService, @Optional() @Inject(PUSH_PROVIDERS) private providers: PushProvider[] = []) {}

  /** What a client needs to subscribe. `webPublicKey` is the VAPID application server key (public by design). */
  config() { return { enabled: this.providers.length > 0, web: !!this.providers.find((p) => p.supports('WEB')), native: !!this.providers.find((p) => p.supports('ANDROID')), webPublicKey: this.providers.find((p) => p.name === 'webpush') ? process.env.VAPID_PUBLIC_KEY ?? null : null }; }

  async register(userId: string, b: any, userAgent?: string) {
    need(b, { platform: 'string', token: 'string' });
    if (!PLATFORMS.includes(b.platform)) throw new BadRequestException({ error: 'validation_failed', fields: ['platform'] });
    if (b.token.length > 4096) throw new BadRequestException({ error: 'validation_failed', fields: ['token'] });
    if (b.platform === 'WEB') {
      let u: URL | null = null; try { u = new URL(b.token); } catch { /* checked below */ }
      if (!u || u.protocol !== 'https:' || !b.keys || typeof b.keys.p256dh !== 'string' || typeof b.keys.auth !== 'string' || b.keys.p256dh.length > 200 || b.keys.auth.length > 100) throw new BadRequestException({ error: 'validation_failed', fields: ['token', 'keys'] });
    }
    const language = b.language === 'hi' ? 'hi' : b.language === 'en' ? 'en' : undefined;
    const row = await this.prisma.$transaction(async (tx) => {
      // the same browser or phone may be signed in as someone else later: the device follows the latest sign-in
      const d = await tx.pushDevice.upsert({ where: { token: b.token }, update: { userId, platform: b.platform, keys: b.platform === 'WEB' ? b.keys : undefined, language, userAgent: userAgent?.slice(0, 200), lastSeenAt: new Date(), failures: 0, disabledAt: null }, create: { userId, platform: b.platform, token: b.token, keys: b.platform === 'WEB' ? b.keys : undefined, language, userAgent: userAgent?.slice(0, 200) } });
      const all = await tx.pushDevice.findMany({ where: { userId, disabledAt: null }, orderBy: { lastSeenAt: 'desc' }, select: { id: true } });
      if (all.length > MAX_DEVICES) await tx.pushDevice.updateMany({ where: { id: { in: all.slice(MAX_DEVICES).map((x) => x.id) } }, data: { disabledAt: new Date() } });
      return d;
    });
    return this.view(row);
  }
  async list(userId: string) { return (await this.prisma.pushDevice.findMany({ where: { userId, disabledAt: null }, orderBy: { lastSeenAt: 'desc' } })).map((d) => this.view(d)); }
  async remove(userId: string, id: string) { const r = await this.prisma.pushDevice.deleteMany({ where: { id, userId } }); if (!r.count) throw new NotFoundException(); return { ok: true }; }
  private view(d: { id: string; platform: string; createdAt: Date; lastSeenAt: Date; userAgent: string | null }) { return { id: d.id, platform: d.platform, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, userAgent: d.userAgent }; }

  private provider(platform: string) { return this.providers.find((p) => p.supports(platform)); }
  private async sendTo(d: { id: string; platform: string; token: string; keys: unknown; failures: number }, m: PushMessage): Promise<PushResult> {
    const p = this.provider(d.platform); if (!p) return 'retry';
    const r = await p.send({ id: d.id, platform: d.platform, token: d.token, keys: d.keys as PushTarget['keys'] }, m).catch((): PushResult => 'retry');
    if (r === 'sent') await this.prisma.pushDevice.update({ where: { id: d.id }, data: { lastSeenAt: new Date(), failures: 0 } }).catch(() => undefined);
    else if (r === 'gone') await this.prisma.pushDevice.update({ where: { id: d.id }, data: { disabledAt: new Date() } }).catch(() => undefined);
    else await this.prisma.pushDevice.update({ where: { id: d.id }, data: { failures: { increment: 1 }, ...(d.failures + 1 >= MAX_FAILURES && { disabledAt: new Date() }) } }).catch(() => undefined);
    return r;
  }
  /** Sends one notification to every active device of its owner, in the owner's language, unless they turned push off. Returns how many were sent. */
  async deliver(n: { userId: string; type: string; payload: unknown }): Promise<number> {
    if (!this.providers.length) return 0;
    const devices = await this.prisma.pushDevice.findMany({ where: { userId: n.userId, disabledAt: null } }); if (!devices.length) return 0;
    const [user, pref] = await Promise.all([this.prisma.user.findUnique({ where: { id: n.userId }, select: { language: true, status: true } }), this.prisma.userPreference.findUnique({ where: { userId: n.userId } })]);
    if (!user || user.status !== 'ACTIVE' || (pref?.prefs as any)?.push === false) return 0;
    const lang = (pref?.prefs as any)?.language ?? user.language; const m = pushMessage(n.type, n.payload, lang); if (!m) return 0;
    let sent = 0; for (const d of devices) if ((await this.sendTo(d, { ...m, url: m.url })) === 'sent') sent++;
    return sent;
  }
  /** Immediate test message to the caller's own devices (settings screen: "send me a test"). */
  async test(a: Actor) {
    const devices = await this.prisma.pushDevice.findMany({ where: { userId: a.id, disabledAt: null } }); const user = await this.prisma.user.findUnique({ where: { id: a.id }, select: { language: true } });
    const hi = user?.language === 'hi'; let sent = 0; for (const d of devices) if ((await this.sendTo(d, { title: hi ? 'लर्निंग पोर्टल' : 'Learning Portal', body: hi ? 'यह एक परीक्षण सूचना है।' : 'This is a test notification.', url: '/notifications', tag: 'test' })) === 'sent') sent++;
    return { devices: devices.length, sent };
  }

  /**
   * Worker sweep: claims notifications not yet pushed (each exactly once across workers) and delivers them. Older than a day are marked done without sending:
   * a "your exam starts soon" that arrives tomorrow is worse than none. At-most-once by design: a crash mid-send loses that push, never duplicates it.
   */
  async sweep(limit = 100): Promise<number> {
    if (!this.providers.length) return 0;
    const now = new Date(), cutoff = new Date(now.getTime() - FRESH_MS);
    await this.prisma.$executeRaw`UPDATE "Notification" SET "pushedAt" = (${now} AT TIME ZONE 'UTC') WHERE "pushedAt" IS NULL AND "createdAt" < (${cutoff} AT TIME ZONE 'UTC')`;
    const claimed = await this.prisma.$queryRaw<{ id: string; userId: string; type: string; payload: unknown }[]>`
      UPDATE "Notification" SET "pushedAt" = (${now} AT TIME ZONE 'UTC') WHERE id IN (SELECT id FROM "Notification" WHERE "pushedAt" IS NULL ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED) RETURNING id, "userId", type, payload`;
    let sent = 0; for (const n of claimed) sent += await this.deliver(n).catch(() => 0);
    return sent;
  }
}

@Controller('v1')
export class PushController {
  constructor(private svc: PushService, private prisma: PrismaService) {}
  @Get('push/config') config() { return this.svc.config(); }
  @Post('me/push/devices') @HttpCode(201) register(@Body() b: any, @CurrentActor() a: Actor, @Headers('user-agent') ua?: string) { return this.svc.register(a.id, b, ua); }
  @Get('me/push/devices') list(@CurrentActor() a: Actor) { return this.svc.list(a.id); }
  @Delete('me/push/devices/:id') remove(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.remove(a.id, id); }
  @Post('me/push/test') @HttpCode(201) @RateLimit(6) test(@CurrentActor() a: Actor) { return this.svc.test(a); }
}
