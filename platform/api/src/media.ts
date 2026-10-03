import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createPublicKey } from 'crypto';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor, Public, Roles } from './common/auth';
import { need } from './common/http';
import { ProgressionService } from './learning';
import { StorageService } from './storage';
import { hasLearningAccess } from './domain/entitlement';
import { masterKeys, mediaSecrets, openWith, sealWith, verifyAny } from './security/keyring';
import { HLS_MIME, childKey, packBundle, rewritePlaylist, segmentMime, segmentNames } from './media/abr';
import { decryptBuffer, encryptBuffer, signToken, unwrapWithMaster, verifyToken, wrapForDevice, wrapWithMaster } from './domain/media-crypto';

const secret = () => mediaSecrets().current;
const MIME: Record<string, string> = { master: 'video/mp4', '720p': 'video/mp4', '360p': 'video/mp4', audio: 'audio/mpeg', transcript: 'text/plain; charset=utf-8', captions: 'text/vtt; charset=utf-8', slides: 'application/pdf' };
const OFFLINE_LABELS = ['360p', 'master']; // smallest first: devices on low bandwidth
const HLS_TTL = () => Number(process.env.HLS_TTL_MIN ?? 180) * 60_000; // a lesson's segments are fetched over its whole length; children never outlive the master token
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
    const f = asset.files as Record<string, any>;
    const order = mode === 'low' ? ['audio', 'transcript', 'captions', '360p', 'slides'] : ['720p', '360p', 'master', 'audio', 'transcript', 'captions', 'slides'];
    const streams: { label: string; mime: string; url: string }[] = order.filter((l) => f[l]).map((l) => ({ label: l, mime: MIME[l], url: this.url(f[l].key, a.id) }));
    // Adaptive ladder first (normal mode only): the player picks a rung from measured bandwidth; the single-file renditions stay as fallback.
    if (mode !== 'low' && f.hls?.key) streams.unshift({ label: 'hls', mime: HLS_MIME, url: `/v1/media/hls/${signToken(secret(), { k: f.hls.key, exp: Date.now() + HLS_TTL(), sub: a.id })}` });
    if (!streams.length) throw new NotFoundException('no renditions');
    // what a device could save for offline use: the rungs of the ladder (the client picks how many)
    const adaptive = mode !== 'low' && f.hls?.rungs ? { rungs: (f.hls.rungs as any[]).map((r) => ({ name: r.name, width: r.width, height: r.height, bandwidth: r.bandwidth, approxBytes: Math.round((r.bandwidth * (asset.durationSec ?? 0)) / 8) })) } : undefined;
    return { assetId: asset.id, language: asset.language, durationSec: asset.durationSec, mode: mode === 'low' ? 'low' : 'normal', ...(adaptive && { adaptive }), streams,
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

  /** Adaptive playlist. Every reference inside is re-signed with the same expiry, so the player needs no credentials and nothing outlives the master token. */
  @Public() @Get('media/hls/:token')
  async hls(@Param('token') token: string, @Res() res: any) {
    const c = verifyAny(mediaSecrets().all, token);
    if (!c || !c.k.endsWith('.m3u8') || !c.k.startsWith('hls/')) throw new UnauthorizedException();
    let text: string;
    try { text = (await this.storage.get(c.k)).toString('utf8'); } catch { throw new NotFoundException(); }
    let body: string;
    try {
      body = rewritePlaylist(text, (uri) => {
        const k = childKey(c.k, uri);
        return k.endsWith('.m3u8') ? `/v1/media/hls/${signToken(secret(), { k, exp: c.exp, sub: c.sub })}` : `/v1/media/stream/${signToken(secret(), { k, exp: c.exp, sub: c.sub, n: segmentMime(k) })}`;
      });
    } catch { throw new BadRequestException('playlist references are not allowed'); }
    res.setHeader('Content-Type', HLS_MIME); res.setHeader('Cache-Control', 'private, no-store');
    return res.end(body);
  }

  /** One rung of the ladder as a single bundle (playlist + every segment), read from the object store. */
  private async hlsBundle(_assetId: string, hlsKey: string, rung: string) {
    const base = `${hlsKey.split('/').slice(0, -1).join('/')}/${rung}`;
    const playlist = (await this.storage.get(`${base}/index.m3u8`)).toString('utf8');
    let names: string[]; try { names = segmentNames(playlist); } catch { throw new BadRequestException('adaptive rendition is not downloadable'); }
    const segments = await Promise.all(names.map(async (name) => ({ name, data: await this.storage.get(`${base}/${name}`) })));
    return packBundle(rung, playlist, segments);
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
    if (b.label !== undefined && typeof b.label !== 'string') throw new BadRequestException('label must be a string');
    const device = await this.prisma.device.findUnique({ where: { userId_deviceId: { userId: a.id, deviceId: b.deviceId } } });
    if (!device || device.status !== 'ACTIVE') throw new ForbiddenException('device not registered');
    const { topic, ent } = await this.prog.context(this.prisma, a.id, b.topicId);
    const asset = this.pick(topic, b.language);
    if (asset && b.label?.startsWith('hls-') && !(asset.files as any).hls?.rungs?.some((r: any) => `hls-${r.name}` === b.label)) throw new NotFoundException('no such adaptive rendition');
    const label: string | undefined = b.label?.startsWith('hls-') ? b.label : b.label ? (asset && OFFLINE_LABELS.includes(b.label) && (asset.files as any)[b.label] ? b.label : undefined) : asset && OFFLINE_LABELS.find((l) => (asset.files as any)[l]);
    if (!asset || !label) throw new NotFoundException('nothing to download');
    const file = (asset.files as any)[label]; // undefined for an adaptive rung: its bytes are assembled from the ladder

    // Encrypt once per (asset,label); concurrent requests converge via the unique key.
    let pkg = await this.prisma.offlinePackage.findUnique({ where: { assetId_label: { assetId: asset.id, label } } });
    if (!pkg) {
      const enc = encryptBuffer(label.startsWith('hls-') ? await this.hlsBundle(asset.id, (asset.files as any).hls.key, label.slice(4)) : await this.storage.get(file.key));
      const key = `offline/${asset.id}/${label}.enc`;
      await this.storage.put(key, enc.data);
      pkg = await this.prisma.offlinePackage.upsert({ where: { assetId_label: { assetId: asset.id, label } }, update: {}, create: { assetId: asset.id, label, storageKey: key, wrappedKey: sealWith(masterKeys(), enc.key), iv: enc.iv.toString('base64'), tag: enc.tag.toString('base64') } });
    }
    const expiresAt = new Date(Math.min(ent.endAt.getTime(), Date.now() + OFFLINE_DAYS * 86_400_000));
    const lic = await this.prisma.offlineLicense.create({ data: { deviceRowId: device.id, entitlementId: ent.id, assetId: asset.id, packageId: pkg.id, wrappedKey: wrapForDevice(device.publicKeyPem, openWith(masterKeys(), pkg.wrappedKey)), expiresAt } });
    return { licenseId: lic.id, assetId: asset.id, label, expiresAt, wrappedKey: lic.wrappedKey, iv: pkg.iv, tag: pkg.tag, cipher: 'AES-256-GCM', keyWrap: 'RSA-OAEP-SHA256',
      downloadUrl: this.url(pkg.storageKey, a.id, 60 * 60_000, 'application/octet-stream'),
      ...(label.startsWith('hls-') && { rung: (asset.files as any).hls.rungs.find((r: any) => `hls-${r.name}` === label) }), interactions: publicInteractions(asset.interactions as any[]), durationSec: asset.durationSec };
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
