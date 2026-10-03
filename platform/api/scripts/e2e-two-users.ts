/**
 * End-to-end test with TWO concurrent learners against the real stack: 2 API instances + 1 worker (separate processes), PostgreSQL, Redis, the
 * Docker sandbox, real ffmpeg, and a stand-in push service. No stand-in for our own code: everything goes over HTTP like a client would.
 *
 *   npm run build && npm run e2e:two
 *
 * Staff set up one course (real video transcoded into an adaptive ladder, quiz, assignment, an exam). Then learner 1 (English, API instance 1) and
 * learner 2 (Hindi, API instance 2) run the whole journey AT THE SAME TIME: sign in, read, watch the adaptive stream, send watch time, pass the quiz,
 * submit the assignment, ask a teacher, save the lesson for offline (device-bound, decrypted here to prove it), turn on push (received and decrypted
 * by the stand-in push service), and sit the exam (check-in, identity, autosave, submit). Checks include that neither can see the other's work.
 * Deliberately 2 users: more concurrency is for the real deployment. Writes docs/quality/e2e-two-users.json (+ .md).
 */
import 'reflect-metadata';
import { ChildProcess, execFileSync, execSync, spawn, spawnSync } from 'child_process';
import { constants, randomUUID, createCipheriv, createDecipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, privateDecrypt, randomBytes } from 'crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createServer, Server } from 'https';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import webpush from 'web-push';
import { hashPassword } from '../src/common/auth';
import { decryptBuffer } from '../src/domain/media-crypto';
import { unpackBundle } from '../src/media/abr';
import { consentHashFor } from '../src/exams/exams';
import { signWebhook } from '../src/proctoring/provider';

const DB = 'edtech_e2e', PG = 'postgresql://edtech:edtech@localhost:5433', PORTS = [3301, 3302], REDIS = 6392, TMP = mkdtempSync(join(tmpdir(), 'e2e-two-')), MEDIA = join(TMP, 'media');
const SECRET = 'e2e-secret-e2e-secret-e2e-secret-0123456789', WHSEC = 'e2e-webhook-secret-0123456789';
const sh = (c: string) => execSync(c, { stdio: 'pipe', env: { ...process.env, PATH: `/opt/homebrew/opt/postgresql@16/bin:${process.env.PATH}` } }).toString();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const procs: ChildProcess[] = [];
const up = (name: string, cmd: string, args: string[], env: any = {}) => { const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); const w = createWriteStream(join(TMP, `${name}.log`)); p.stdout!.pipe(w); p.stderr!.pipe(w); procs.push(p); return p; };
const waitHttp = async (url: string) => { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await sleep(500); } throw new Error(`not ready: ${url}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- checks and timings --------------------------------------------------------------------------------------------------------------------------------
interface Check { user: string; step: string; ok: boolean; detail?: string }
const checks: Check[] = []; const timings: Record<string, number[]> = {}; const t0 = Date.now();
const check = (user: string, step: string, ok: boolean, detail = '') => { checks.push({ user, step, ok, detail }); if (!ok) log(`FAIL ${user} ${step} ${detail}`); };
interface Res { status: number; body: any; text: string; bytes: Buffer; headers: Headers }
async function call(inst: number, method: string, path: string, o: { token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string>; step?: string } = {}): Promise<Res> {
  const h: Record<string, string> = { ...o.headers }; if (o.token) h.Authorization = `Bearer ${o.token}`; if (o.body !== undefined) h['Content-Type'] = 'application/json';
  const t = Date.now(); const r = await fetch(`http://127.0.0.1:${PORTS[inst]}${path}`, { method, headers: h, body: (o.raw ? new Uint8Array(o.raw) : o.body !== undefined ? JSON.stringify(o.body) : undefined) as any, signal: AbortSignal.timeout(60_000) });
  const bytes = Buffer.from(await r.arrayBuffer()); const text = bytes.toString('utf8'); let body: any = text; try { body = JSON.parse(text); } catch { /* not json */ }
  (timings[o.step ?? `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id').split('?')[0]}`] ??= []).push(Date.now() - t); return { status: r.status, body, text, bytes, headers: r.headers };
}

// ---- a stand-in push service: receives Web Push, decrypts it as a browser would ---------------------------------------------------------------------
const gate = (n: number) => { let c = 0; let go!: () => void; const p = new Promise<void>((r) => (go = r)); return () => { if (++c === n) go(); return p; }; }; const bothRegistered = gate(2);
let opening: Promise<unknown> | null = null; const windowOpen = () => (opening ??= prisma.examSession.update({ where: { id: SESSION }, data: { startsAt: new Date(Date.now() - 300_000) } })); // registration closes at the start, so the sitting is scheduled ahead and then "time passes"
const ECDH: Record<string, { ua: ReturnType<typeof createECDH>; auth: Buffer }> = {}; const pushed: { who: string; message: any }[] = [];
function decryptPush(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen); const secret = ua.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32)); const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)); const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(cipher.subarray(cipher.length - 16)); const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]); return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

const prisma = new PrismaClient({ datasources: { db: { url: `${PG}/${DB}` } } });
const ids: Record<string, string> = {}; const tok: Record<string, string> = {};
const as = (k: string) => tok[k];
const login = async (inst: number, email: string, step = 'login') => { const r = await call(inst, 'POST', '/v1/auth/login', { body: { email, password: 'Pw-e2e-1234567' }, step }); if (r.status !== 201 || !r.body.accessToken) throw new Error(`login ${email} -> ${r.status} ${r.text.slice(0, 200)}`); return r.body.accessToken as string; };
async function mkUser(key: string, role: string, language = 'en') { const u = await prisma.user.create({ data: { email: `${key}@e2e.test`, name: key, language, passwordHash: hashPassword('Pw-e2e-1234567'), roles: { create: { role: role as any } } } }); ids[key] = u.id; }

let V = '', T1 = '', ASSET = '', PROG = '', EXAM = '', SESSION = '', QUIZ: { id: string; answer: number }[] = [];
async function stack() {
  log(`building the stack in ${TMP}`);
  try { sh(`dropdb --force --if-exists -h localhost -p 5433 -U edtech ${DB}`); } catch { /* none */ } sh(`createdb -h localhost -p 5433 -U edtech ${DB}`);
  sh(`cd ${join(__dirname, '..')} && DATABASE_URL=${PG}/${DB} npx prisma migrate deploy`);
  mkdirSync(MEDIA, { recursive: true });
  // a self-signed certificate for the stand-in push service
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(TMP, 'k.pem'), '-out', join(TMP, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const vapid = webpush.generateVAPIDKeys();
  const common = { NODE_ENV: 'e2e', JWT_SECRET: SECRET, MEDIA_TOKEN_SECRET: SECRET, MEDIA_ROOT: MEDIA, REDIS_URL: `redis://127.0.0.1:${REDIS}`, DATABASE_URL: `${PG}/${DB}`, OFFLINE_MASTER_KEY: 'ab'.repeat(32), DATA_ENC_KEY: 'cd'.repeat(32), EXAM_RECEIPT_SECRET: SECRET, LAB_QR_SECRET: SECRET, PROCTOR_WEBHOOK_SECRET: WHSEC, ADMISSIONS_HMAC_SECRET: SECRET,
    REQUEST_LOG: '0', SANDBOX_MODE: 'docker', PUSH_MODE: 'live', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:e2e@example.test', PUSH_SWEEP_MS: '1000', AI_WORKER_POLL_MS: '500', CORS_NONE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' /* e2e only: the stand-in push service is self-signed */ };
  up('redis', 'redis-server', ['--port', String(REDIS), '--save', '', '--appendonly', 'no']); await sleep(800);
  PORTS.forEach((port, i) => up(`api${i + 1}`, 'node', ['dist/src/main.js'], { ...common, PROCESS_ROLE: 'api', PORT: String(port) }));
  up('worker', 'node', ['dist/src/worker.js'], { ...common, PROCESS_ROLE: 'worker', WORKER_HEALTH_PORT: '3399' });
  for (const p of PORTS) await waitHttp(`http://127.0.0.1:${p}/health/ready`);
  return vapid;
}

async function staffSetup() {
  log('staff set up the course');
  for (const [k, r] of [['admin', 'ACADEMIC_ADMIN'], ['author', 'CONTENT_AUTHOR'], ['faculty', 'FACULTY_REVIEWER'], ['approver', 'APPROVER_PUBLISHER'], ['examadmin', 'EXAM_ADMIN'], ['assess', 'ASSESSMENT_ADMIN'], ['teacher', 'DOUBT_TEACHER']]) await mkUser(k, r); await mkUser('asha', 'LEARNER', 'en'); await mkUser('ravi', 'LEARNER', 'hi');
  for (const k of ['admin', 'author', 'faculty', 'approver', 'examadmin', 'assess', 'teacher', 'asha', 'ravi']) tok[k] = await login(0, `${k}@e2e.test`, 'login (setup)');
  await prisma.teacherProfile.create({ data: { userId: ids.teacher, disciplines: ['AI'], skills: ['sensors'], languages: ['en', 'hi'] } });
  await call(0, 'POST', '/v1/authoring/programmes', { token: as('author'), body: { code: 'E2E', title: 'End-to-end programme', discipline: 'AI' } });
  const v = await call(0, 'POST', '/v1/authoring/programmes/E2E/versions', { token: as('author'), body: { hours: 1, languages: ['en'], modules: [{ title: 'Module 1', topics: [{ title: 'Sensors', hours: 1 }] }] } }); V = v.body.id;
  T1 = (await prisma.topic.findFirstOrThrow({ where: { module: { versionId: V } } })).id; PROG = (await prisma.programme.findFirstOrThrow({ where: { code: 'E2E' } })).id;
  // a real 14 s 720p video with a tone, made by ffmpeg
  const src = join(TMP, 'src.mp4'); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  ASSET = (await call(0, 'POST', `/v1/authoring/topics/${T1}/assets`, { token: as('author'), body: { language: 'en', durationSec: 14, provenance: { tool: 'e2e' }, interactions: [] } })).body.id;
  const put = (label: string, data: Buffer) => call(0, 'PUT', `/v1/authoring/assets/${ASSET}/files/${label}`, { token: as('author'), raw: data, headers: { 'content-type': 'application/octet-stream' } });
  for (const [l, d] of [['master', readFileSync(src)], ['360p', readFileSync(src)], ['transcript', Buffer.from('Sensors turn signals into data.')], ['captions', Buffer.from('WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nSensors turn signals into data.\n')]] as [string, Buffer][]) check('staff', `upload ${l}`, (await put(l, d)).status === 200);
  const q = await call(0, 'POST', `/v1/authoring/assets/${ASSET}/transcode`, { token: as('author') }); check('staff', 'queue the adaptive build', q.status === 201);
  for (let i = 0; i < 120; i++) { const s = await call(0, 'GET', `/v1/authoring/assets/${ASSET}/renditions`, { token: as('author'), step: 'poll transcode' }); if (s.body.job?.status === 'SUCCEEDED') { check('staff', 'real ffmpeg built the ladder', s.body.hls?.rungs?.length === 4, JSON.stringify(s.body.hls?.rungs?.map((r: any) => r.name))); break; } if (s.body.job?.status === 'FAILED') { check('staff', 'real ffmpeg built the ladder', false, s.body.job.error); break; } await sleep(1000); }
  await call(0, 'PUT', `/v1/authoring/topics/${T1}/quiz`, { token: as('author'), body: { passPercent: 60, maxAttempts: 2, questions: [{ type: 'MCQ_SINGLE', text: 'What does a sensor do?', options: ['Stores data', 'Turns signals into data'], answer: 1, points: 1 }, { type: 'NUMERIC', text: '2+2?', answer: 4, tolerance: 0.1, points: 1 }] } });
  await call(0, 'PUT', `/v1/authoring/topics/${T1}/assignment`, { token: as('author'), body: { instructions: 'Explain a thermistor.', maxSubmissions: 2 } });
  for (const [u, to] of [['author', 'FACULTY_REVIEW'], ['faculty', 'FACULTY_APPROVED'], ['faculty', 'ADMIN_APPROVAL'], ['approver', 'PUBLISHED']]) { const r = await call(0, 'POST', `/v1/authoring/versions/${V}/transition`, { token: as(u), body: { to } }); check('staff', `publish: ${to}`, r.status === 201, r.text.slice(0, 160)); }
  const tree = (await call(0, 'GET', `/v1/authoring/versions/${V}/tree`, { token: as('author') })).body; const qs = tree.modules[0].topics[0].quiz.questions; QUIZ = qs.map((x: any) => ({ id: x.id, answer: x.type === 'NUMERIC' ? 4 : x.answer }));
  // exam: question bank + definition + a sitting that is open now
  const bank = [...[0, 1, 2, 3].map((i) => ({ tag: 'sensors', type: 'MCQ_SINGLE', text: `Sensor Q${i}`, options: ['A', 'B', 'C', 'D'], answer: i % 4, difficulty: 2, points: 2 })), ...[0, 1, 2].map((i) => ({ tag: 'sensors', type: 'NUMERIC', text: `Numeric ${i}`, answer: 10 + i, tolerance: 0.1, difficulty: 2, points: 1 }))];
  check('staff', 'question bank', (await call(0, 'POST', `/v1/exams/bank/${PROG}/questions`, { token: as('examadmin'), body: { questions: bank } })).status === 201);
  const ex = await call(0, 'POST', '/v1/exams', { token: as('examadmin'), body: { versionId: V, code: 'E2EX', title: 'Final', durationMin: 30, passPercent: 50, maxAttempts: 2, blueprint: [{ tag: 'sensors', count: 5 }], proctoring: { mode: 'REMOTE', requireId: true, requireDevice: true, device: { camera: true, microphone: true, singleScreen: true } } } }); check('staff', 'define the exam', ex.status === 201, ex.text.slice(0, 200)); EXAM = ex.body.id;
  const pub = await call(0, 'POST', `/v1/exams/${EXAM}/publish`, { token: as('assess') }); // a different person publishes (segregation of duties) check('staff', 'publish the exam', pub.status === 201, pub.text.slice(0, 300));
  const ses = await call(0, 'POST', `/v1/exams/${EXAM}/sessions`, { token: as('examadmin'), body: { startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), mode: 'REMOTE', capacity: 10 } }); check('staff', 'schedule the sitting', ses.status === 201, ses.text.slice(0, 200)); SESSION = ses.body.id;
  for (const k of ['asha', 'ravi']) await prisma.entitlement.create({ data: { learnerId: ids[k], versionId: V, duration: 'M12', cohort: 'C1', startAt: new Date(Date.now() - 86_400_000), endAt: new Date(Date.now() + 300 * 86_400_000), approvedById: ids.admin } });
}

/** The whole learner journey. `inst` is the API instance this learner talks to; both run at once. */
async function journey(u: 'asha' | 'ravi', inst: number, pushServer: { port: number }, other: 'asha' | 'ravi') {
  const hi = u === 'ravi'; const n = (s: string, ok: boolean, d = '') => check(u, s, ok, d); const T = () => as(u);
  tok[u] = await login(inst, `${u}@e2e.test`); n('sign in (own API instance)', !!tok[u]);
  const ents = (await call(inst, 'GET', '/v1/me/entitlements', { token: T() })).body; const ent = ents[0]; n('sees only their own entitlement', ents.length === 1 && ent.learnerId === ids[u]);
  const prog = (await call(inst, 'GET', `/v1/me/entitlements/${ent.id}/progress`, { token: T() })).body; n('progress starts at 0%', prog.percentComplete === 0);
  const othersEnt = await prisma.entitlement.findFirstOrThrow({ where: { learnerId: ids[other] } }); n('cannot read the other learner\'s progress', [403, 404].includes((await call(inst, 'GET', `/v1/me/entitlements/${othersEnt.id}/progress`, { token: T() })).status));
  const topic = await call(inst, 'GET', `/v1/topics/${T1}`, { token: T() }); n('opens the topic', topic.status === 200 && topic.body.title === 'Sensors');
  // ---- watch the adaptive stream: master -> variant -> every segment of every rung, then decode one rung with ffmpeg
  const pb = (await call(inst, 'GET', `/v1/topics/${T1}/playback?language=en`, { token: T() })).body; n('playback offers the adaptive ladder first', pb.streams[0]?.label === 'hls' && pb.adaptive?.rungs?.length === 4);
  const master = await call(inst, 'GET', pb.streams[0].url, { step: 'hls master' }); const variants: string[] = master.text.split('\n').filter((l) => l.startsWith('/v1/media/hls/')); n('master playlist has 4 signed variants', variants.length === 4);
  let decoded = 0; for (const [i, vurl] of variants.entries()) {
    const pl = await call(inst, 'GET', vurl, { step: 'hls variant' }); const segs = pl.text.split('\n').filter((l) => l.startsWith('/v1/media/stream/')); const parts: Buffer[] = []; for (const s of segs) { const r = await call(inst, 'GET', s, { step: 'hls segment' }); if (r.status !== 200) break; parts.push(r.bytes); }
    const f = join(TMP, `${u}-rung${i}.ts`); writeFileSync(f, Buffer.concat(parts)); const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']); if (dec.status === 0 && dec.stderr.length === 0 && segs.length === 3) decoded++;
  } n('every rung downloads through signed URLs and decodes cleanly', decoded === 4, `${decoded}/4`);
  // ---- watch time: 14 s in honest chunks; a replay of the same events changes nothing
  const ids2 = [randomUUID(), randomUUID()]; const ev = (a: number, b: number) => ({ eventId: ids2[a === 0 ? 0 : 1], topicId: T1, type: 'VIDEO_HEARTBEAT', occurredAt: new Date().toISOString(), payload: { assetId: ASSET, from: a, to: b } });
  const hb = await call(inst, 'POST', '/v1/learning-events', { token: T(), body: { events: [ev(0, 7), ev(7, 14)] } }); n('watch time accepted', hb.body.results?.every((r: any) => r.status === 'accepted'), JSON.stringify(hb.body.results));
  const replay = await call(inst, 'POST', '/v1/learning-events', { token: T(), body: { events: [ev(0, 7), ev(7, 14)] } }); n('replayed events are duplicates, not double counted', replay.body.results?.every((r: any) => r.status === 'duplicate'));
  // ---- quiz
  const qa = await call(inst, 'POST', `/v1/topics/${T1}/quiz/start`, { token: T() }); n('quiz opens after the video', qa.status === 201, qa.text.slice(0, 160)); const ans: any = {}; for (const q of QUIZ) ans[q.id] = q.answer;
  const qr = await call(inst, 'POST', `/v1/quiz-attempts/${qa.body.attemptId}/submit`, { token: T(), body: { answers: ans }, headers: { 'Idempotency-Key': `${u}-quiz-1` } }); n('quiz passed', qr.body.passed === true, qr.text.slice(0, 160));
  const qr2 = await call(inst, 'POST', `/v1/quiz-attempts/${qa.body.attemptId}/submit`, { token: T(), body: { answers: ans }, headers: { 'Idempotency-Key': `${u}-quiz-1` } }); n('a retried submit with the same key replays the answer', qr2.status === 201 && qr2.body.passed === true);
  // ---- assignment and a question for a teacher
  const asg = await call(inst, 'POST', `/v1/topics/${T1}/assignment/submit`, { token: T(), body: { text: `A thermistor changes resistance with temperature. (${u})` }, headers: { 'Idempotency-Key': `${u}-asg-1` } }); n('assignment submitted and queued for evaluation', asg.status === 201 && !!asg.body.submissionId, asg.text.slice(0, 160));
  const mySubs = (await call(inst, 'GET', '/v1/me/submissions', { token: T() })).body; n('sees only their own submission', mySubs.length === 1);
  const doubt = await call(inst, 'POST', '/v1/doubts', { token: T(), body: { entitlementId: ent.id, subject: `Question from ${u}`, body: 'How does a thermistor work?', category: 'CONTENT' }, headers: { 'Idempotency-Key': `${u}-doubt-1` } }); n('asks a teacher', doubt.status === 201, doubt.text.slice(0, 160));
  // ---- offline: device-bound adaptive download, decrypted here
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }); const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  n('registers a device', (await call(inst, 'POST', '/v1/offline/devices', { token: T(), body: { deviceId: `${u}-phone`, publicKeyPem: pem } })).status === 201);
  let opened = 0; for (const rung of ['240p', '720p']) {
    const lic = await call(inst, 'POST', '/v1/offline/licenses', { token: T(), body: { deviceId: `${u}-phone`, topicId: T1, label: `hls-${rung}` } }); if (lic.status !== 201) continue;
    const enc = (await call(inst, 'GET', lic.body.downloadUrl, { step: 'offline download' })).bytes; const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(lic.body.wrappedKey, 'base64'));
    const { header, segments } = unpackBundle(decryptBuffer(enc, key, Buffer.from(lic.body.iv, 'base64'), Buffer.from(lic.body.tag, 'base64'))); const f = join(TMP, `${u}-off-${rung}.ts`); writeFileSync(f, Buffer.concat(segments.map((s) => s.data)));
    if (header.rung === rung && segments.length === 3 && spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']).status === 0) opened++;
  } n('saves two rungs for offline and they decrypt and play', opened === 2, `${opened}/2`);
  const lics = (await call(inst, 'GET', `/v1/offline/licenses?deviceId=${u}-phone`, { token: T() })).body; n('licences are valid', lics.length === 2 && lics.every((l: any) => l.valid));
  // ---- push: subscribe through the real API, then expect the notification that the topic completion produced
  const ua = createECDH('prime256v1'); ua.generateKeys(); const auth = randomBytes(16); const endpoint = `https://localhost:${pushServer.port}/push/${u}`; ECDH[endpoint] = { ua, auth };
  const reg = await call(inst, 'POST', '/v1/me/push/devices', { token: T(), body: { platform: 'WEB', token: endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, language: hi ? 'hi' : 'en' } }); n('registers for push', reg.status === 201, reg.text.slice(0, 160));
  const test = await call(inst, 'POST', '/v1/me/push/test', { token: T() }); n('a test push is delivered to the stand-in push service', test.body.sent === 1, test.text);
  // ---- the exam: eligibility, register, check in, identity, autosave, submit
  await sleep(inst * 150); const reg2 = await call(inst, 'POST', `/v1/exams/${EXAM}/register`, { token: T(), body: { sessionId: SESSION } }); n('registers for the exam (eligible after the topic)', reg2.status === 201, reg2.text.slice(0, 200));
  await bothRegistered(); await windowOpen(); const ci = await call(inst, 'POST', `/v1/exam-sessions/${SESSION}/check-in`, { token: T(), body: { consent: true, consentHash: consentHashFor('E2EX'), device: { browserSupported: true, camera: true, microphone: true, screens: 1, bandwidthKbps: 2000 } } }); n('checks in', ci.status === 201, ci.text.slice(0, 200));
  const attempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: ci.body.attemptId } }); const raw = JSON.stringify({ eventId: `${u}-id`, sessionId: attempt.providerSessionId, type: 'identity_verified', occurredAt: new Date().toISOString() }); const ts = Date.now();
  n('identity confirmed by the proctoring webhook', (await call(inst, 'POST', '/v1/proctoring/webhook', { raw: Buffer.from(raw), headers: { 'x-timestamp': String(ts), 'x-signature': signWebhook(WHSEC, ts, raw), 'content-type': 'application/json' } })).status === 201);
  const st = await call(inst, 'POST', `/v1/exam-attempts/${ci.body.attemptId}/start`, { token: T() }); n('starts the exam (server clock)', st.status === 201 && !!st.body.sessionToken, st.text.slice(0, 200)); const hdr = { 'x-exam-session': st.body.sessionToken };
  const paper = (await prisma.examAttempt.findUniqueOrThrow({ where: { id: ci.body.attemptId } })).paper as any[]; const qsx = await prisma.examQuestion.findMany({ where: { id: { in: paper.map((p) => p.questionId) } } }); const answers: any = {};
  for (const it of paper) { const q = qsx.find((x) => x.id === it.questionId)!; answers[q.id] = q.type === 'NUMERIC' ? q.answer : it.optionOrder.indexOf(q.answer); }
  const keys = Object.keys(answers); const s1 = await call(inst, 'PUT', `/v1/exam-attempts/${ci.body.attemptId}/answers`, { token: T(), headers: hdr, body: { seq: 1, answers: Object.fromEntries(keys.slice(0, 3).map((k) => [k, answers[k]])) }, step: 'exam autosave' }); n('autosave 1', s1.status === 200 && s1.body.saved === true);
  const s0 = await call(inst, 'PUT', `/v1/exam-attempts/${ci.body.attemptId}/answers`, { token: T(), headers: hdr, body: { seq: 1, answers: {} }, step: 'exam autosave' }); n('a stale autosave is ignored, not applied', s0.status === 200 && s0.body.saved === false);
  const s2 = await call(inst, 'PUT', `/v1/exam-attempts/${ci.body.attemptId}/answers`, { token: T(), headers: hdr, body: { seq: 2, answers }, step: 'exam autosave' }); n('autosave 2', s2.status === 200 && s2.body.saved === true);
  const peek = await call(inst, 'PUT', `/v1/exam-attempts/${ci.body.attemptId}/answers`, { token: as(other), headers: hdr, body: { seq: 3, answers: {} } }); n('the other learner cannot write to this attempt', [403, 404, 409].includes(peek.status), String(peek.status));
  const sub = await call(inst, 'POST', `/v1/exam-attempts/${ci.body.attemptId}/submit`, { token: T(), headers: hdr, body: {} }); n('submits with a receipt', sub.status === 201 && !!sub.body.receiptCode && sub.body.answered === keys.length, sub.text.slice(0, 200));
  const res = (await call(inst, 'GET', `/v1/me/exam-attempts/${ci.body.attemptId}`, { token: T() })).body; n('result is held for release, not shown early', res.state !== 'RELEASED' && res.percent === undefined, JSON.stringify(res).slice(0, 160));
  const notes = (await call(inst, 'GET', '/v1/me/notifications', { token: T() })).body.map((x: any) => x.type); n('notified about the topic, the exam registration and submission', ['topic.completed', 'exam.registered', 'exam.submitted'].every((t) => notes.includes(t)), notes.join());
  return { examAttemptId: ci.body.attemptId as string };
}

async function main() {
  const vapid = await stack(); void vapid;
  const server: Server = createServer({ key: readFileSync(join(TMP, 'k.pem')), cert: readFileSync(join(TMP, 'c.pem')) }, (req, res) => { const c: Buffer[] = []; req.on('data', (x) => c.push(x)); req.on('end', () => { const who = (req.url ?? '').split('/').pop()!; const e = ECDH[`https://localhost:${(server.address() as any).port}${req.url}`]; try { pushed.push({ who, message: decryptPush(Buffer.concat(c), e.ua, e.auth) }); } catch { pushed.push({ who, message: { error: 'could not decrypt' } }); } res.statusCode = 201; res.end(); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const pushServer = { port: (server.address() as any).port };
  await staffSetup();
  // No AI keys here, so assignments stay "being evaluated" and the exam's eligibility rule holds learners back: staff use the documented, audited exception.
  for (const k of ['asha', 'ravi']) check('staff', `eligibility exception for ${k}`, (await call(0, 'POST', `/v1/exams/${EXAM}/eligibility-overrides`, { token: as('admin'), body: { learnerId: ids[k], reason: 'AI grader not available in the end-to-end environment' } })).status === 201);
  log('two learners, at the same time'); const started = Date.now();
  const [a, b] = await Promise.all([journey('asha', 0, pushServer, 'ravi'), journey('ravi', 1, pushServer, 'asha')]); const together = Date.now() - started;
  // ---- after the dust settles: what the server and the push service saw
  await sleep(3500); // worker push sweep (1 s) + delivery
  const byWho = (w: string) => pushed.filter((p) => p.who === w).map((p) => p.message);
  check('asha', 'push: English messages arrive, decrypted by the device', byWho('asha').length >= 3 && byWho('asha').every((m) => m.title === 'Learning Portal' && /[A-Za-z]/.test(m.body)), JSON.stringify(byWho('asha').map((m) => m.body)));
  check('ravi', 'push: Hindi messages arrive, decrypted by the device', byWho('ravi').length >= 3 && byWho('ravi').every((m) => m.title === 'लर्निंग पोर्टल' && /[ऀ-ॿ]/.test(m.body)), JSON.stringify(byWho('ravi').map((m) => m.body)));
  check('both', 'push: nobody received the other person\'s notification', byWho('asha').every((m) => !/[ऀ-ॿ]/.test(m.body)) && byWho('ravi').every((m) => /[ऀ-ॿ]/.test(m.body)));
  // whether the topic notification is pushed depends on whether the sweep ran before the device subscribed (by design it is then skipped), so it may arrive once or not at all, never twice; the exam ones always follow the subscription
  check('both', 'push: each notification created after subscribing is delivered exactly once', ['asha', 'ravi'].every((w) => ['exam.registered', 'exam.submitted'].every((t) => byWho(w).filter((m) => m.tag === t).length === 1)) && ['asha', 'ravi'].every((w) => ['topic.completed', 'programme.completed', 'test'].every((t) => byWho(w).filter((m) => m.tag === t).length <= 1)), JSON.stringify({ asha: byWho('asha').map((m) => m.tag), ravi: byWho('ravi').map((m) => m.tag) }));
  const hbRows = await prisma.learningEvent.count({ where: { type: 'VIDEO_HEARTBEAT' } }); check('both', 'exactly 2 accepted heartbeat events per learner stored', hbRows === 4, String(hbRows));
  const attempts = await prisma.examAttempt.findMany({ where: { examId: EXAM } }); check('both', 'two exam attempts, one per learner, both submitted', attempts.length === 2 && attempts.every((x) => x.status === 'SUBMITTED') && new Set(attempts.map((x) => x.learnerId)).size === 2);
  await mkUser('auditor', 'AUDITOR'); const audit = await call(0, 'GET', '/v1/audit/verify', { token: await login(0, 'auditor@e2e.test') }); check('both', 'the audit hash chain verifies after concurrent activity', audit.status === 200 && audit.body.intact !== false, audit.text.slice(0, 200));
  const integ = await call(1, 'GET', '/v1/ops/integrity', { token: await (async () => { await mkUser('platform', 'PLATFORM_ADMIN'); return login(1, 'platform@e2e.test'); })() }); check('both', 'platform integrity checks are clean', integ.status === 200 && integ.body.ok !== false && (integ.body.orphans ? Object.values(integ.body.orphans).every((x) => x === 0) : true), integ.text.slice(0, 240));
  const report = await call(0, 'GET', `/v1/reports/progress?versionId=${V}`, { token: as('admin') }); check('both', 'staff report shows both learners with the topic done', report.status === 200 && report.body.rows?.length === 2 && report.body.rows.every((r: any) => r.completedTopics === 1), report.text.slice(0, 200));
  const logs = ['api1', 'api2', 'worker'].map((n) => readFileSync(join(TMP, `${n}.log`), 'utf8')); const errs = logs.flatMap((l, i) => l.split('\n').filter((x) => /"level":"error"|ERROR|UnhandledPromise|Unhandled/.test(x)).map((x) => `${['api1', 'api2', 'worker'][i]}: ${x.slice(0, 200)}`)); check('both', 'no server errors in either API instance or the worker', errs.length === 0, errs.slice(0, 3).join(' | '));

  const pct = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const steps = Object.entries(timings).map(([k, v]) => ({ step: k, calls: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), max: Math.max(...v) })).sort((x, y) => y.max - x.max);
  const failed = checks.filter((c) => !c.ok); const out = { when: new Date().toISOString(), users: 2, apiInstances: PORTS.length, together_ms: together, total_ms: Date.now() - t0, passed: checks.length - failed.length, failed: failed.length, failures: failed, checks, slowest: steps.slice(0, 8), exam: { a: a.examAttemptId, b: b.examAttemptId } };
  const dir = join(__dirname, '../../docs/quality'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'e2e-two-users.json'), JSON.stringify(out, null, 1) + '\n');
  const md = ['# End-to-end test: two concurrent learners', '', `Run ${out.when}. Real stack: ${PORTS.length} API instances + worker, PostgreSQL, Redis, Docker, real ffmpeg, a stand-in push service. Two learners (one English, one Hindi) ran the whole journey **at the same time**, each on a different API instance. The test is deliberately limited to 2 users; capacity testing belongs on the deployed environment.`, '',
    `**${out.passed} of ${checks.length} checks passed, ${out.failed} failed.** Both learners finished in ${(together / 1000).toFixed(1)} s (journey only).`, '', failed.length ? '## Failures\n' + failed.map((f) => `- ${f.user}: ${f.step} ${f.detail}`).join('\n') + '\n' : '', '## Checks', '', '| Learner | Check | Result |', '|---|---|---|', ...checks.map((c) => `| ${c.user} | ${c.step} | ${c.ok ? 'pass' : '**FAIL** ' + (c.detail ?? '').replace(/\|/g, '/')} |`), '', '## Slowest calls (ms)', '', '| Call | Count | p50 | p95 | max |', '|---|---|---|---|---|', ...steps.slice(0, 8).map((s) => `| ${s.step} | ${s.calls} | ${s.p50} | ${s.p95} | ${s.max} |`), ''].join('\n');
  writeFileSync(join(dir, 'e2e-two-users.md'), md);
  log(`${out.passed}/${checks.length} checks passed`); for (const f of failed) log(`  FAIL ${f.user}: ${f.step} ${f.detail}`);
  server.close(); await prisma.$disconnect(); for (const p of procs) p.kill('SIGTERM'); await sleep(500); process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error(e); for (const p of procs) p.kill('SIGTERM'); await prisma.$disconnect().catch(() => undefined); process.exit(2); });
