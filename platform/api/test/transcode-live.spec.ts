// REAL ffmpeg/ffprobe, real encode, real segments, played back through the API's signed-playlist delivery. Skipped when ffmpeg is not installed.
import 'reflect-metadata';
import { execFileSync, spawnSync } from 'child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { constants, generateKeyPairSync, privateDecrypt } from 'crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret'; process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'media-live-')); process.env.OFFLINE_MASTER_KEY = 'ab'.repeat(32);
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { JobWorker } from '../src/ai/generation';
import { unpackBundle } from '../src/media/abr';
import { decryptBuffer } from '../src/domain/media-crypto';

const has = (b: string) => spawnSync(b, ['-version']).status === 0;
const ready = has('ffmpeg') && has('ffprobe');
const d = ready ? describe : describe.skip;
jest.setTimeout(240_000);

const prisma = new PrismaClient(); let app: INestApplication; let http: any; const tok: Record<string, string> = {}; const uid: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
const probe = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
let A1 = '', T1 = '';

d('adaptive video, real ffmpeg, end to end', () => {
  beforeAll(async () => {
    const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
    for (const [k, r] of [['author', 'CONTENT_AUTHOR'], ['faculty', 'FACULTY_REVIEWER'], ['approver', 'APPROVER_PUBLISHER'], ['admin', 'ACADEMIC_ADMIN'], ['learner', 'LEARNER']] as const) {
      const u = await prisma.user.create({ data: { email: `${k}@x.test`, name: k, passwordHash: hashPassword('pw'), roles: { create: { role: r as any } } } }); uid[k] = u.id;
      tok[k] = (await http.post('/v1/auth/login').send({ email: `${k}@x.test`, password: 'pw' })).body.accessToken;
    }
    await http.post('/v1/authoring/programmes').set(as('author')).send({ code: 'PLIVE', title: 'Live', discipline: 'AI' }).expect(201);
    const v = await http.post('/v1/authoring/programmes/PLIVE/versions').set(as('author')).send({ hours: 1, languages: ['en'], modules: [{ title: 'M', topics: [{ title: 'T', hours: 1 }] }] }).expect(201);
    T1 = (await prisma.topic.findFirstOrThrow({ where: { module: { versionId: v.body.id } } })).id;
    A1 = (await http.post(`/v1/authoring/topics/${T1}/assets`).set(as('author')).send({ language: 'en', durationSec: 14, provenance: { model: 'm' }, interactions: [] }).expect(201)).body.id;
    // a genuine 14 s, 1280x720, 25 fps test video with a tone, made by ffmpeg itself
    const src = join(process.env.MEDIA_ROOT!, 'src.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    await http.put(`/v1/authoring/assets/${A1}/files/master`).set(as('author')).set('content-type', 'application/octet-stream').send(readFileSync(src)).expect(200);
    for (const l of ['360p', 'audio', 'transcript']) await http.put(`/v1/authoring/assets/${A1}/files/${l}`).set(as('author')).set('content-type', 'application/octet-stream').send(Buffer.from('x')).expect(200);
    await http.put(`/v1/authoring/topics/${T1}/quiz`).set(as('author')).send({ passPercent: 60, maxAttempts: 2, questions: [{ type: 'MCQ_SINGLE', text: 'q', options: ['a', 'b'], answer: 1, points: 1 }] }).expect(200);
    await http.put(`/v1/authoring/topics/${T1}/assignment`).set(as('author')).send({ instructions: 'x', maxSubmissions: 1 }).expect(200);
    for (const [u, to] of [['author', 'FACULTY_REVIEW'], ['faculty', 'FACULTY_APPROVED'], ['faculty', 'ADMIN_APPROVAL'], ['approver', 'PUBLISHED']] as const) await http.post(`/v1/authoring/versions/${v.body.id}/transition`).set(as(u)).send({ to }).expect(201);
    await prisma.entitlement.create({ data: { learnerId: uid.learner, versionId: v.body.id, duration: 'M12', cohort: 'C1', startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() + 300 * 86400000), approvedById: uid.admin } });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('transcodes a real 720p video into 4 rungs (never 1080p) with aligned segments', async () => {
    await http.post(`/v1/authoring/assets/${A1}/transcode`).set(as('author')).expect(201); expect(await app.get(JobWorker).runOnce()).toBe(true);
    const s = (await http.get(`/v1/authoring/assets/${A1}/renditions`).set(as('author')).expect(200)).body; expect(s.job.error).toBeNull(); expect(s.job.status).toBe('SUCCEEDED');
    expect(s.hls.rungs.map((r: any) => `${r.name}:${r.width}x${r.height}`)).toEqual(['240p:426x240', '360p:640x360', '480p:854x480', '720p:1280x720']);
    for (const r of s.hls.rungs) {
      const dir = join(process.env.MEDIA_ROOT!, 'hls', A1, r.name); const pl = readFileSync(join(dir, 'index.m3u8'), 'utf8'); const segs = pl.split('\n').filter((l) => l.endsWith('.ts'));
      expect(segs.length).toBe(3); expect(pl).toContain('#EXT-X-ENDLIST'); expect(pl).toMatch(/#EXT-X-TARGETDURATION:6/);
      const p = probe(join(dir, segs[0])); const v = p.streams.find((x: any) => x.codec_type === 'video'); expect(v.codec_name).toBe('h264'); expect(v.height).toBe(r.height); expect(p.streams.some((x: any) => x.codec_type === 'audio' && x.codec_name === 'aac')).toBe(true);
    }
    const master = readFileSync(join(process.env.MEDIA_ROOT!, 'hls', A1, 'master.m3u8'), 'utf8'); expect(master.indexOf('240p/index.m3u8')).toBeLessThan(master.indexOf('720p/index.m3u8'));
  });

  it('the learner plays it through signed playlists, and every rung reassembles into a valid full-length video', async () => {
    const p = (await http.get(`/v1/topics/${T1}/playback`).set(as('learner')).expect(200)).body; expect(p.streams[0].label).toBe('hls');
    const master = await http.get(p.streams[0].url).expect(200); const variants = master.text.split('\n').filter((l: string) => l.startsWith('/v1/media/hls/')); expect(variants).toHaveLength(4);
    for (const [i, v] of variants.entries()) {
      const media = await http.get(v).expect(200); const segs = media.text.split('\n').filter((l: string) => l.startsWith('/v1/media/stream/')); expect(segs).toHaveLength(3);
      const bytes = Buffer.concat(await Promise.all(segs.map(async (u: string) => { const r = await http.get(u).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200); return r.body as Buffer; })));
      const f = join(process.env.MEDIA_ROOT!, `rung${i}.ts`); require('fs').writeFileSync(f, bytes); const pr = probe(f);
      expect(Number(pr.format.duration)).toBeGreaterThan(13.5); expect(Number(pr.format.duration)).toBeLessThan(14.6);
      const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']); expect(dec.stderr.toString()).toBe(''); expect(dec.status).toBe(0); // decodes cleanly end to end
    }
  });

  it('offline: each rung downloads as one encrypted bundle that only the registered device can open, and plays after reassembly', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }); const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await http.post('/v1/offline/devices').set(as('learner')).send({ deviceId: 'phone', publicKeyPem: pem }).expect(201);
    const pb = (await http.get(`/v1/topics/${T1}/playback`).set(as('learner')).expect(200)).body; expect(pb.adaptive.rungs.map((r: any) => r.name)).toEqual(['240p', '360p', '480p', '720p']); expect(pb.adaptive.rungs[0].approxBytes).toBeGreaterThan(0);
    await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'phone', topicId: T1, label: 'hls-1080p' }).expect(404); // not in the ladder
    await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'phone', topicId: T1, label: 'nope' }).expect(404);
    const sizes: Record<string, number> = {};
    for (const rung of ['240p', '720p']) {
      const lic = (await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'phone', topicId: T1, label: `hls-${rung}` }).expect(201)).body; expect(lic.label).toBe(`hls-${rung}`); expect(lic.rung.name).toBe(rung);
      const enc = (await http.get(lic.downloadUrl).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200)).body as Buffer;
      const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(lic.wrappedKey, 'base64'));
      const plain = decryptBuffer(enc, key, Buffer.from(lic.iv, 'base64'), Buffer.from(lic.tag, 'base64')); const { header, segments } = unpackBundle(plain);
      expect(header.rung).toBe(rung); expect(segments).toHaveLength(3); expect(header.playlist).toContain('#EXT-X-ENDLIST'); sizes[rung] = plain.length;
      const f = join(process.env.MEDIA_ROOT!, `offline-${rung}.ts`); require('fs').writeFileSync(f, Buffer.concat(segments.map((s) => s.data)));
      const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']); expect(dec.stderr.toString()).toBe(''); expect(Number(probe(f).format.duration)).toBeGreaterThan(13.5);
    }
    expect(sizes['240p']).toBeLessThan(sizes['720p']);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; const lic2 = (await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'phone', topicId: T1, label: 'hls-240p' }).expect(201)).body;
    expect(() => privateDecrypt({ key: other, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(lic2.wrappedKey, 'base64'))).toThrow();
  });

  it('a lower rung is genuinely smaller than a higher one', async () => {
    const size = (r: string) => require('fs').readdirSync(join(process.env.MEDIA_ROOT!, 'hls', A1, r)).filter((f: string) => f.endsWith('.ts')).reduce((n: number, f: string) => n + require('fs').statSync(join(process.env.MEDIA_ROOT!, 'hls', A1, r, f)).size, 0);
    expect(size('240p')).toBeLessThan(size('480p')); expect(size('480p')).toBeLessThan(size('720p'));
  });
});
