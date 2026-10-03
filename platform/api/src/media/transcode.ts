import { BadRequestException, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Optional, Param, Post } from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, posix } from 'path';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, Roles } from '../common/auth';
import { AuditService } from '../audit';
import { StorageService } from '../storage';
import { Planned, ffmpegArgs, masterPlaylist, parseProbe, planLadder, probeArgs, SEGMENT_SEC } from './abr';

export type Run = (bin: 'ffmpeg' | 'ffprobe', args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs a media tool with a hard wall-clock limit. The binary names come from env so a deployment can point at its own build. */
export const spawnRun: Run = (bin, args) => new Promise((resolve, reject) => {
  const exe = bin === 'ffmpeg' ? process.env.FFMPEG_BIN ?? 'ffmpeg' : process.env.FFPROBE_BIN ?? 'ffprobe';
  const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${bin} timed out`)); }, Number(process.env.TRANSCODE_TIMEOUT_MIN ?? 90) * 60_000);
  p.stdout.on('data', (d) => { if (out.length < 5_000_000) out += d; }); p.stderr.on('data', (d) => { if (err.length < 20_000) err += d; });
  p.on('error', (e) => { clearTimeout(timer); reject(new Error(`${bin} could not start: ${e.message}`)); });
  p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
});
export const RUNNER = 'TRANSCODE_RUN';

export interface HlsInfo { key: string; segmentSec: number; rungs: { name: string; width: number; height: number; bandwidth: number }[]; generatedAt: string; sourceChecksum?: string }

/**
 * Builds the adaptive-bitrate (HLS) ladder for a video asset from its master file and records it under files.hls. The master stays
 * the source of truth; the ladder is derived and can be rebuilt. Output is written under hls/<assetId>/ in the object store.
 */
@Injectable()
export class TranscodeService {
  constructor(private prisma: PrismaService, private storage: StorageService, private audit: AuditService, @Optional() @Inject(RUNNER) private runner: Run = spawnRun) {}

  async enqueue(assetId: string, actor: Actor) {
    const asset = await this.prisma.contentAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.kind !== 'VIDEO') throw new NotFoundException('video asset not found');
    if (!(asset.files as any)?.master) throw new BadRequestException('asset has no master file to transcode');
    const open = await this.prisma.generationJob.findFirst({ where: { kind: 'TRANSCODE', status: { in: ['QUEUED', 'RUNNING'] }, input: { path: ['assetId'], equals: assetId } } });
    if (open) throw new ConflictException({ error: 'already_queued', jobId: open.id });
    const job = await this.prisma.generationJob.create({ data: { kind: 'TRANSCODE', input: { assetId }, topicId: asset.topicId, requestedById: actor.id } });
    return { jobId: job.id, status: job.status };
  }

  async status(assetId: string) {
    const asset = await this.prisma.contentAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundException();
    const job = await this.prisma.generationJob.findFirst({ where: { kind: 'TRANSCODE', input: { path: ['assetId'], equals: assetId } }, orderBy: { createdAt: 'desc' } });
    return { assetId, hls: ((asset.files as any)?.hls as HlsInfo | undefined) ?? null, job: job && { id: job.id, status: job.status, error: job.error, attempts: job.attempts, finishedAt: job.finishedAt } };
  }

  /** Worker entry. Idempotent: a re-run replaces the ladder. */
  async run(job: { id: string; input: any; requestedById: string }) {
    const assetId = String(job.input?.assetId);
    const asset = await this.prisma.contentAsset.findUniqueOrThrow({ where: { id: assetId } });
    const master = (asset.files as any)?.master as { key: string; checksum?: string } | undefined;
    if (!master) throw new Error('asset has no master file');
    const dir = await fs.mkdtemp(join(tmpdir(), 'abr-'));
    try {
      const src = join(dir, 'source'); await fs.writeFile(src, await this.storage.get(master.key));
      const pr = await this.runner('ffprobe', probeArgs(src)); if (pr.code !== 0) throw new Error(`ffprobe failed: ${pr.stderr.slice(0, 300)}`);
      const probe = parseProbe(pr.stdout); const rungs = planLadder(probe);
      const prefix = `hls/${assetId}`; const uploaded: string[] = [];
      for (const r of rungs) {
        const out = join(dir, r.name); await fs.mkdir(out, { recursive: true });
        const x = await this.runner('ffmpeg', ffmpegArgs(src, out, r, probe)); if (x.code !== 0) throw new Error(`ffmpeg ${r.name} failed: ${x.stderr.slice(0, 300)}`);
        for (const f of await fs.readdir(out)) { const key = posix.join(prefix, r.name, f); await this.storage.put(key, await fs.readFile(join(out, f))); uploaded.push(key); }
      }
      const key = `${prefix}/master.m3u8`; await this.storage.put(key, Buffer.from(masterPlaylist(rungs)));
      const info: HlsInfo = { key, segmentSec: SEGMENT_SEC, rungs: rungs.map(({ name, width, height, bandwidth }: Planned) => ({ name, width, height, bandwidth })), generatedAt: new Date().toISOString(), sourceChecksum: master.checksum ?? createHash('sha256').update(master.key).digest('hex') };
      await this.prisma.$transaction(async (tx) => {
        const cur = await tx.contentAsset.findUniqueOrThrow({ where: { id: assetId } });
        await tx.contentAsset.update({ where: { id: assetId }, data: { files: { ...(cur.files as object), hls: info } as any, durationSec: cur.durationSec ?? (probe.durationSec || null) } });
        await this.audit.record(tx, { actor: null, action: 'media.transcoded', objectType: 'ContentAsset', objectId: assetId, after: { rungs: info.rungs.map((r) => r.name), jobId: job.id } });
      });
      return { assetId, rungs: info.rungs.map((r) => r.name), objects: uploaded.length + 1 };
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
}

@Controller('v1/authoring')
export class TranscodeController {
  constructor(private svc: TranscodeService) {}
  @Post('assets/:id/transcode') @Roles('CONTENT_AUTHOR', 'ACADEMIC_ADMIN') enqueue(@Param('id') id: string, @CurrentActor() a: Actor) { return this.svc.enqueue(id, a); }
  @Get('assets/:id/renditions') @Roles('CONTENT_AUTHOR', 'ACADEMIC_ADMIN', 'FACULTY_REVIEWER', 'APPROVER_PUBLISHER', 'AUDITOR') status(@Param('id') id: string) { return this.svc.status(id); }
}
