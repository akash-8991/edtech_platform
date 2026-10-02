import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createPublicKey } from 'crypto';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor, Public, Roles } from './common/auth';
import { need } from './common/http';
import { ProgressionService } from './learning';
import { StorageService } from './storage';
import { hasLearningAccess } from './domain/entitlement';
import { masterKeys, mediaSecrets, openWith, sealWith, verifyAny } from './security/keyring';
import { decryptBuffer, encryptBuffer, signToken, unwrapWithMaster, verifyToken, wrapForDevice, wrapWithMaster } from './domain/media-crypto';

const secret = () => mediaSecrets().current;
const MIME: Record<string, string> = { master: 'video/mp4', '720p': 'video/mp4', '360p': 'video/mp4', audio: 'audio/mpeg', transcript: 'text/plain; charset=utf-8', slides: 'application/pdf' };
const OFFLINE_LABELS = ['360p', 'master']; // smallest first: devices on low bandwidth
const STREAM_TTL = 10 * 60_000, OFFLINE_DAYS = Number(process.env.OFFLINE_DAYS ?? 7), MAX_DEVICES = 3;

const learnerAsset = (a: any) => ({ id: a.id, language: a.language, durationSec: a.durationSec });
// Strip server-only fields (`correct`) from interactions before they reach a learner.
const publicInteractions = (ix: any[]) => ix.map(({ correct, ...rest }) => rest);

@Controller('v1')
export class MediaController {
  constructor(private prisma: PrismaService, private prog: ProgressionService, private storage: StorageService) {}

  private pick(topic: any, language?: string) {
    const vids = topic.assets.filter((a: any) => a.kind === 'VIDEO' && a.files?.master);
    return vids.find((a: any) => a.language === language) ?? vids.find((a: any) => a.language === 'en') ?? vids[0];
  }

  private url(key: string, sub: string, ttl = STREAM_TTL, n?: string) {
    return `/v1/media/stream/${signToken(secret(), { k: key, exp: Date.now() + ttl, sub, n })}`;
  }

  /** mode=low returns audio + transcript first (and the smallest video), per the low-bandwidth requirement. */
  @Get('topics/:id/playback') @Roles('LEARNER')
  async playback(@Param('id') id: string, @Query('language') language: string, @Query('mode') mode: string, @CurrentActor() a: Actor) {
    const { topic, row } = await this.prog.context(this.prisma, a.id, id);
    const asset = this.pick(topic, language);
    if (!asset) throw new NotFoundException('no video for topic');
    const f = asset.files as Record<string, { key: string }>;
    const order = mode === 'low' ? ['audio', 'transcript', '360p', 'slides'] : ['720p', '360p', 'master', 'audio', 'transcript', 'slides'];
    const streams = order.filter((l) => f[l]).map((l) => ({ label: l, mime: MIME[l], url: this.url(f[l].key, a.id) }));
    if (!streams.length) throw new NotFoundException('no renditions');
    return { assetId: asset.id, language: asset.language, durationSec: asset.durationSec, mode: mode === 'low' ? 'low' : 'normal', streams,
      interactions: publicInteractions(asset.interactions as any[]), resume: { sec: row.p?.resumeAssetId === asset.id ? (row.p?.resumeSec ?? 0) : 0 } };
  }

  // Token-authorised byte streaming with HTTP Range support (seeking, resumable download). Stand-in for CDN signed URLs.
  @Public() @Get('media/stream/:token')
  async stream(@Param('token') token: string, @Req() req: any, @Res() res: any) {
    const c = verifyAny(mediaSecrets().all, token);
    if (!c) throw new UnauthorizedException();
    let size: number;
    try { size = (await this.storage.stat(c.k)).size; } catch { throw new NotFoundException(); }
    const label = c.k.split('/').pop() ?? '';
    res.setHeader('Content-Type', c.n ?? MIME[label] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'private, no-store');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : size - Number(m[2]), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`); res.setHeader('Content-Length', end - start + 1);
      return (await this.storage.stream(c.k, { start, end })).pipe(res);
    }
    res.setHeader('Content-Length', size);
    return (await this.storage.stream(c.k)).pipe(res);
  }

  // ---- Offline ---------------------------------------------------------------------------------------------
  @Post('offline/devices') @Roles('LEARNER')
  async registerDevice(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { deviceId: 'string', publicKeyPem: 'string' });
    try { const k = createPublicKey(b.publicKeyPem); if (k.asymmetricKeyType !== 'rsa' || (k.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw 0; } catch { throw new BadRequestException('publicKeyPem must be an RSA >=2048 public key'); }
    const active = await this.prisma.device.count({ where: { userId: a.id, status: 'ACTIVE', NOT: { deviceId: b.deviceId } } });
    if (active >= MAX_DEVICES) throw new ConflictException(`max ${MAX_DEVICES} devices`);
    return this.prisma.device.upsert({ where: { userId_deviceId: { userId: a.id, deviceId: b.deviceId } }, update: { publicKeyPem: b.publicKeyPem, status: 'ACTIVE' }, create: { userId: a.id, deviceId: b.deviceId, publicKeyPem: b.publicKeyPem } });
  }

  @Post('offline/devices/:deviceId/revoke') @Roles('LEARNER', 'SUPPORT_OPERATOR')
  async revokeDevice(@Param('deviceId') deviceId: string, @Query('userId') userId: string | undefined, @CurrentActor() a: Actor) {
    const uid = a.roles.includes('SUPPORT_OPERATOR') && userId ? userId : a.id;
    const d = await this.prisma.device.findUnique({ where: { userId_deviceId: { userId: uid, deviceId } } });
    if (!d) throw new NotFoundException();
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id: d.id }, data: { status: 'REVOKED' } }),
      this.prisma.offlineLicense.updateMany({ where: { deviceRowId: d.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: 'device revoked' } }),
    ]);
    return { ok: true };
  }

  @Post('offline/licenses') @Roles('LEARNER')
  async license(@Body() b: any, @CurrentActor() a: Actor) {
    need(b, { deviceId: 'string', topicId: 'string' });
    const device = await this.prisma.device.findUnique({ where: { userId_deviceId: { userId: a.id, deviceId: b.deviceId } } });
    if (!device || device.status !== 'ACTIVE') throw new ForbiddenException('device not registered');
    const { topic, ent } = await this.prog.context(this.prisma, a.id, b.topicId);
    const asset = this.pick(topic, b.language);
    const label = asset && OFFLINE_LABELS.find((l) => (asset.files as any)[l]);
    if (!asset || !label) throw new NotFoundException('nothing to download');
    const file = (asset.files as any)[label];

    // Encrypt once per (asset,label); concurrent requests converge via the unique key.
    let pkg = await this.prisma.offlinePackage.findUnique({ where: { assetId_label: { assetId: asset.id, label } } });
    if (!pkg) {
      const enc = encryptBuffer(await this.storage.get(file.key));
      const key = `offline/${asset.id}/${label}.enc`;
      await this.storage.put(key, enc.data);
      pkg = await this.prisma.offlinePackage.upsert({ where: { assetId_label: { assetId: asset.id, label } }, update: {}, create: { assetId: asset.id, label, storageKey: key, wrappedKey: sealWith(masterKeys(), enc.key), iv: enc.iv.toString('base64'), tag: enc.tag.toString('base64') } });
    }
    const expiresAt = new Date(Math.min(ent.endAt.getTime(), Date.now() + OFFLINE_DAYS * 86_400_000));
    const lic = await this.prisma.offlineLicense.create({ data: { deviceRowId: device.id, entitlementId: ent.id, assetId: asset.id, packageId: pkg.id, wrappedKey: wrapForDevice(device.publicKeyPem, openWith(masterKeys(), pkg.wrappedKey)), expiresAt } });
    return { licenseId: lic.id, assetId: asset.id, label, expiresAt, wrappedKey: lic.wrappedKey, iv: pkg.iv, tag: pkg.tag, cipher: 'AES-256-GCM', keyWrap: 'RSA-OAEP-SHA256',
      downloadUrl: this.url(pkg.storageKey, a.id, 60 * 60_000, 'application/octet-stream'), interactions: publicInteractions(asset.interactions as any[]), durationSec: asset.durationSec };
  }

  /** Clients poll this on connect; a licence is valid only while ACTIVE, unexpired, and the entitlement still grants access. */
  @Get('offline/licenses') @Roles('LEARNER')
  async licenses(@Query('deviceId') deviceId: string, @CurrentActor() a: Actor) {
    const d = await this.prisma.device.findUnique({ where: { userId_deviceId: { userId: a.id, deviceId } } });
    if (!d) throw new NotFoundException();
    const ls = await this.prisma.offlineLicense.findMany({ where: { deviceRowId: d.id }, orderBy: { createdAt: 'desc' } });
    const ents = new Map((await this.prisma.entitlement.findMany({ where: { id: { in: ls.map((l) => l.entitlementId) } } })).map((e) => [e.id, e]));
    const now = new Date();
    return ls.map((l) => { const e = ents.get(l.entitlementId); return { licenseId: l.id, assetId: l.assetId, expiresAt: l.expiresAt, status: l.status, valid: l.status === 'ACTIVE' && l.expiresAt > now && !!e && hasLearningAccess(e, now) }; });
  }
}
