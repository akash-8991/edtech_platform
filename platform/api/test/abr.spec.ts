import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
process.env.MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'media-abr-'));
process.env.OFFLINE_MASTER_KEY = 'ab'.repeat(32);
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { JobWorker } from '../src/ai/generation';
import { RUNNER, Run } from '../src/media/transcode';
import { packBundle, unpackBundle, segmentNames } from '../src/media/abr';

const prisma = new PrismaClient();
let app: INestApplication; let http: any; const tok: Record<string, string> = {}; const uid: Record<string, string> = {};
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
async function mkUser(key: string, role: string) {
  const u = await prisma.user.create({ data: { email: `${key}@x.test`, name: key, passwordHash: hashPassword('pw'), roles: { create: { role: role as any } } } });
  uid[key] = u.id; tok[key] = (await http.post('/v1/auth/login').send({ email: `${key}@x.test`, password: 'pw' })).body.accessToken;
}
const MP4 = Buffer.from('FAKE-MP4'.repeat(50));
let T1: string, A1: string, AD: string; let failFfmpeg = false; const calls: { bin: string; args: string[] }[] = [];

/** A stand-in for ffmpeg/ffprobe: probe reports a 720p source; ffmpeg "encodes" by writing a playlist and two segments where asked. */
const fake: Run = async (bin, args) => {
  calls.push({ bin, args });
  if (bin === 'ffprobe') return { code: 0, stderr: '', stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '25/1' }, { codec_type: 'audio' }], format: { duration: '12' } }) };
  if (failFfmpeg) return { code: 1, stdout: '', stderr: 'boom' };
  const idx = args[args.length - 1]; const dir = idx.slice(0, idx.lastIndexOf('/'));
  await fs.writeFile(idx, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg_00000.ts\n#EXTINF:6,\nseg_00001.ts\n#EXT-X-ENDLIST\n');
  await fs.writeFile(`${dir}/seg_00000.ts`, Buffer.alloc(300, 1)); await fs.writeFile(`${dir}/seg_00001.ts`, Buffer.alloc(200, 2));
  return { code: 0, stdout: '', stderr: '' };
};

beforeAll(async () => {
  const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(RUNNER).useValue(fake).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  for (const [k, r] of [['author', 'CONTENT_AUTHOR'], ['faculty', 'FACULTY_REVIEWER'], ['approver', 'APPROVER_PUBLISHER'], ['admin', 'ACADEMIC_ADMIN'], ['learner', 'LEARNER']] as const) await mkUser(k, r);
  await http.post('/v1/authoring/programmes').set(as('author')).send({ code: 'PABR', title: 'ABR', discipline: 'AI' }).expect(201);
  const v = await http.post('/v1/authoring/programmes/PABR/versions').set(as('author')).send({ hours: 1, languages: ['en'], modules: [{ title: 'M1', topics: [{ title: 'T1', hours: 1 }] }] }).expect(201);
  T1 = (await prisma.topic.findFirstOrThrow({ where: { module: { versionId: v.body.id } } })).id;
  const a = await http.post(`/v1/authoring/topics/${T1}/assets`).set(as('author')).send({ language: 'en', durationSec: 12, provenance: { model: 'm' }, interactions: [] }).expect(201); A1 = a.body.id;
  for (const l of ['master', '360p', 'audio', 'transcript']) await http.put(`/v1/authoring/assets/${A1}/files/${l}`).set(as('author')).set('content-type', 'application/octet-stream').send(MP4).expect(200);
  await http.put(`/v1/authoring/topics/${T1}/quiz`).set(as('author')).send({ passPercent: 60, maxAttempts: 2, questions: [{ type: 'MCQ_SINGLE', text: 'q', options: ['a', 'b'], answer: 1, points: 1 }] }).expect(200);
  await http.put(`/v1/authoring/topics/${T1}/assignment`).set(as('author')).send({ instructions: 'x', maxSubmissions: 1 }).expect(200);
  for (const [u, to] of [['author', 'FACULTY_REVIEW'], ['faculty', 'FACULTY_APPROVED'], ['faculty', 'ADMIN_APPROVAL'], ['approver', 'PUBLISHED']] as const) await http.post(`/v1/authoring/versions/${v.body.id}/transition`).set(as(u)).send({ to }).expect(201);
  await prisma.entitlement.create({ data: { learnerId: uid.learner, versionId: v.body.id, duration: 'M12', cohort: 'C1', startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() + 300 * 86400000), approvedById: uid.admin } });
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('adaptive bitrate (HLS) transcoding', () => {
  it('without a ladder, playback is unchanged (single-file renditions only)', async () => {
    const p = (await http.get(`/v1/topics/${T1}/playback`).set(as('learner')).expect(200)).body;
    expect(p.streams.some((s: any) => s.label === 'hls')).toBe(false);
  });
  it('only authors/admins may start a transcode; learners and unknown assets are refused', async () => {
    await http.post(`/v1/authoring/assets/${A1}/transcode`).set(as('learner')).expect(403);
    await http.post('/v1/authoring/assets/00000000-0000-0000-0000-000000000000/transcode').set(as('author')).expect(404);
  });
  it('queues once, the worker builds the ladder, and the asset records it', async () => {
    const q = await http.post(`/v1/authoring/assets/${A1}/transcode`).set(as('author')).expect(201); expect(q.body.status).toBe('QUEUED');
    await http.post(`/v1/authoring/assets/${A1}/transcode`).set(as('author')).expect(409); // already queued
    expect(await app.get(JobWorker).runOnce()).toBe(true);
    const s = (await http.get(`/v1/authoring/assets/${A1}/renditions`).set(as('author')).expect(200)).body;
    expect(s.job.status).toBe('SUCCEEDED'); expect(s.hls.rungs.map((r: any) => r.name)).toEqual(['240p', '360p', '480p', '720p']);
    expect(calls.filter((c) => c.bin === 'ffmpeg')).toHaveLength(4);
    expect(await prisma.auditEvent.count({ where: { action: 'media.transcoded' } })).toBe(1);
  });
  it('playback offers the adaptive playlist first; every reference inside is a signed, expiring URL', async () => {
    const p = (await http.get(`/v1/topics/${T1}/playback`).set(as('learner')).expect(200)).body;
    expect(p.streams[0]).toMatchObject({ label: 'hls', mime: 'application/vnd.apple.mpegurl' }); expect(p.streams.some((s: any) => s.label === '360p')).toBe(true); // fallback kept
    const master = await http.get(p.streams[0].url).expect(200); expect(master.headers['content-type']).toMatch(/mpegurl/); expect(master.headers['cache-control']).toMatch(/no-store/);
    const variants = master.text.split('\n').filter((l: string) => l.startsWith('/v1/media/hls/')); expect(variants).toHaveLength(4);
    expect(master.text).not.toMatch(/\d+p\/index\.m3u8/);
    const media = await http.get(variants[0]).expect(200); const segs = media.text.split('\n').filter((l: string) => l.startsWith('/v1/media/stream/')); expect(segs).toHaveLength(2);
    const seg = await http.get(segs[0]).expect(200); expect(seg.headers['content-type']).toBe('video/mp2t'); expect(seg.headers['accept-ranges']).toBe('bytes');
    await http.get(segs[0]).set('Range', 'bytes=0-9').expect(206);
    await http.get(variants[0] + 'x').expect(401);
  });
  it('low-bandwidth mode stays audio-first and does not offer the ladder', async () => {
    const p = (await http.get(`/v1/topics/${T1}/playback?mode=low`).set(as('learner')).expect(200)).body;
    expect(p.streams.map((s: any) => s.label)).not.toContain('hls'); expect(p.streams[0].label).toBe('audio');
  });
  it('a stream token cannot be turned into a playlist, and a playlist token cannot reach outside hls/', async () => {
    const p = (await http.get(`/v1/topics/${T1}/playback`).set(as('learner'))).body; const file = p.streams.find((s: any) => s.label === '360p').url.replace('/media/stream/', '/media/hls/');
    await http.get(file).expect(401);
  });
  it('replacing the master drops the stale ladder; a failed encode leaves nothing half-published', async () => {
    const v2 = await http.post('/v1/authoring/programmes/PABR/versions').set(as('author')).send({ hours: 1, languages: ['en'], modules: [{ title: 'M', topics: [{ title: 'D', hours: 1 }] }] }).expect(201);
    const td = (await prisma.topic.findFirstOrThrow({ where: { module: { versionId: v2.body.id } } })).id;
    AD = (await http.post(`/v1/authoring/topics/${td}/assets`).set(as('author')).send({ language: 'en', durationSec: 12, provenance: { model: 'm' }, interactions: [] }).expect(201)).body.id;
    const put = (b: string) => http.put(`/v1/authoring/assets/${AD}/files/master`).set(as('author')).set('content-type', 'application/octet-stream').send(Buffer.from(b)).expect(200);
    await put('MASTER-ONE'); await http.post(`/v1/authoring/assets/${AD}/transcode`).set(as('author')).expect(201); await app.get(JobWorker).runOnce();
    expect((await prisma.contentAsset.findUniqueOrThrow({ where: { id: AD } })).files).toHaveProperty('hls');
    await put('MASTER-TWO'); expect((await prisma.contentAsset.findUniqueOrThrow({ where: { id: AD } })).files).not.toHaveProperty('hls');
    failFfmpeg = true; await http.post(`/v1/authoring/assets/${AD}/transcode`).set(as('author')).expect(201);
    for (let i = 0; i < 3; i++) await app.get(JobWorker).runOnce();
    failFfmpeg = false;
    const s = (await http.get(`/v1/authoring/assets/${AD}/renditions`).set(as('author'))).body; expect(s.hls).toBeNull(); expect(s.job.error).toMatch(/ffmpeg 240p failed/);
  });
});

describe('offline bundle format', () => {
  it('round-trips, and refuses a bundle that is truncated, padded or not a bundle', () => {
    const b = packBundle('360p', '#EXTM3U\n#EXTINF:6,\nseg_00000.ts\n#EXT-X-ENDLIST\n', [{ name: 'seg_00000.ts', data: Buffer.from('abc') }, { name: 'seg_00001.ts', data: Buffer.from('defg') }]);
    const u = unpackBundle(b); expect(u.header.rung).toBe('360p'); expect(u.segments.map((s) => s.data.toString())).toEqual(['abc', 'defg']);
    expect(() => unpackBundle(b.subarray(0, b.length - 1))).toThrow(); expect(() => unpackBundle(Buffer.concat([b, Buffer.from('x')]))).toThrow(/mismatch/); expect(() => unpackBundle(Buffer.from('nope nope nope'))).toThrow(/not a bundle/);
  });
  it('only plain segment names are accepted from a playlist', () => {
    expect(segmentNames('#EXTM3U\nseg_00001.ts\n')).toEqual(['seg_00001.ts']);
    for (const bad of ['../x.ts', '/etc/passwd', 'http://x/y.ts', 'a/b.ts', 'seg.ts?x=1']) expect(() => segmentNames(`#EXTM3U\n${bad}\n`)).toThrow();
  });
  it('an unknown adaptive rendition has no licence', async () => {
    await http.post('/v1/offline/devices').set(as('learner')).send({ deviceId: 'd1', publicKeyPem: require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString() }).expect(201);
    await http.post('/v1/offline/licenses').set(as('learner')).send({ deviceId: 'd1', topicId: T1, label: 'hls-9999p' }).expect(404);
  });
});
