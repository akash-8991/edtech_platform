/**
 * Load-test harness. Seeds an isolated database, starts the REAL server as a separate process, drives realistic request mixes
 * (TRD §4 capacity model) with a keep-alive HTTP client, and reports throughput + latency percentiles + server CPU/RSS.
 *
 *   npm run build && npm run loadtest            (defaults: 10s per scenario, concurrency 64)
 *   LT_SECONDS=20 LT_CONC=128 LT_USERS=1500 npm run loadtest
 *
 * Numbers are for ONE machine running client, server and Postgres together: indicative, not a 50,000-user validation.
 */
import 'reflect-metadata';
import { execSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const SECS = Number(process.env.LT_SECONDS ?? 10), CONC = Number(process.env.LT_CONC ?? 64), USERS = Number(process.env.LT_USERS ?? 600), PORT = Number(process.env.LT_PORT ?? 3099);
const DB = process.env.LT_DB ?? 'edtech_perf'; const URL_DB = `postgresql://edtech:edtech@localhost:5433/${DB}`; const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'loadtest-secret'; const MEDIA = mkdtempSync(join(tmpdir(), 'lt-media-'));
const sh = (c: string, env: any = {}) => execSync(c, { stdio: 'pipe', env: { ...process.env, ...env, PATH: `/opt/homebrew/opt/postgresql@16/bin:${process.env.PATH}` } }).toString();

async function seed() {
  try { sh(`psql -h localhost -p 5433 -U edtech -d postgres -c "DROP DATABASE IF EXISTS ${DB}"`); } catch { /* ignore */ }
  sh(`psql -h localhost -p 5433 -U edtech -d postgres -c "CREATE DATABASE ${DB}"`); sh('npx prisma migrate deploy', { DATABASE_URL: URL_DB });
  const prisma = new PrismaClient({ datasources: { db: { url: URL_DB } } });
  const { hashPassword } = require('../src/common/auth'); const pw = hashPassword('Load-Test-Pass-1'); // one hash shared by all users: scrypt per user would dominate seeding
  const prog = await prisma.programme.create({ data: { code: 'LT', title: 'Load', discipline: 'AI/ML' } });
  const v = await prisma.programmeVersion.create({ data: { programmeId: prog.id, version: 1, state: 'PUBLISHED', authorId: 'x', hours: 12, publishedAt: new Date(), languages: ['en'],
    modules: { create: [1, 2, 3].map((m) => ({ position: m, title: `M${m}`, topics: { create: [1, 2, 3, 4].map((t) => ({ position: t, title: `T${m}.${t}`, hours: 1, outcomes: ['o'] })) } })) } }, include: { modules: { include: { topics: true } } } });
  const topics = v.modules.flatMap((m) => m.topics); const t0 = topics.sort((a, b) => a.position - b.position)[0];
  // a video topic with a real (tiny) rendition on disk
  const asset = await prisma.contentAsset.create({ data: { topicId: t0.id, language: 'en', durationSec: 600, createdById: 'x', files: { master: { key: 'a/master', checksum: 'c', size: 10 }, '360p': { key: 'a/360p', checksum: 'c', size: 10 } } } });
  mkdirSync(join(MEDIA, 'a'), { recursive: true }); writeFileSync(join(MEDIA, 'a/master'), 'x'.repeat(1000)); writeFileSync(join(MEDIA, 'a/360p'), 'x'.repeat(1000));
  await prisma.user.createMany({ data: Array.from({ length: USERS }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `lt${i}@x.test`, name: `LT ${i}`, passwordHash: pw })) });
  const ids = Array.from({ length: USERS }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  await prisma.userRole.createMany({ data: ids.map((id) => ({ userId: id, role: 'LEARNER' as const })) });
  const ents = ids.map((id, i) => ({ id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, learnerId: id, versionId: v.id, duration: 'M12' as const, cohort: 'C', startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() + 300 * 86400000), approvedById: 'x' }));
  await prisma.entitlement.createMany({ data: ents });
  // each learner is partway through: the first topic is complete (so topic 2 is unlocked), as in steady state
  await prisma.topicProgress.createMany({ data: ents.map((e) => ({ entitlementId: e.id, topicId: t0.id, videoDone: true, videoRanges: { [asset.id]: [[0, 600]] } as any })) });
  const sessions = ids.map((id, i) => ({ id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, userId: id, authMethod: 'PASSWORD', expiresAt: new Date(Date.now() + 3600_000) }));
  await prisma.userSession.createMany({ data: sessions });
  const jwt = require('jsonwebtoken'); const tokens = ids.map((id, i) => jwt.sign({ sub: id, roles: ['LEARNER'], sid: sessions[i].id }, SECRET, { expiresIn: '1h' }));
  // exam: one in-progress attempt per learner (paper of 10, session token known to the client)
  const exam = await prisma.examDefinition.create({ data: { versionId: v.id, code: 'LT', title: 'LT', status: 'PUBLISHED', durationMin: 60, eligibility: {}, blueprint: [], proctoring: { mode: 'CENTRE' }, createdById: 'x' } });
  const sess = await prisma.examSession.create({ data: { examId: exam.id, startsAt: new Date(Date.now() - 600_000), endsAt: new Date(Date.now() + 7200_000), mode: 'CENTRE', capacity: 1e6, createdById: 'x' } });
  const qs = await prisma.examQuestion.createManyAndReturn({ data: Array.from({ length: 10 }, (_, i) => ({ programmeId: prog.id, tag: 't', type: 'MCQ_SINGLE' as const, text: `q${i}`, options: ['a', 'b', 'c', 'd'], answer: 0, createdById: 'x' })) });
  const paper = qs.map((q) => ({ questionId: q.id, tag: 't', points: 1, optionOrder: [0, 1, 2, 3] }));
  const examTok = ids.map((_, i) => `examtok-${i}`);
  const regs = ids.map((id, i) => ({ id: `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`, examId: exam.id, sessionId: sess.id, learnerId: id, entitlementId: ents[i].id }));
  await prisma.examRegistration.createMany({ data: regs });
  await prisma.examAttempt.createMany({ data: ids.map((id, i) => ({ id: `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`, examId: exam.id, sessionId: sess.id, registrationId: regs[i].id, learnerId: id, entitlementId: ents[i].id, attemptNo: 1, status: 'IN_PROGRESS', startedAt: new Date(), deadlineAt: new Date(Date.now() + 3600_000), paper: paper as any, sessionTokenHash: createHash('sha256').update(examTok[i]).digest('hex') })) });
  const topicIds = topics.map((t) => t.id); await prisma.$disconnect();
  return { tokens, ids, ents: ents.map((e) => e.id), topic1: t0.id, topic2: topics.find((t) => t.position === 2 && t.title.startsWith('T1'))!.id, assetId: asset.id, topicIds, examTok, paper, attempts: ids.map((_, i) => `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`) };
}

type Req = (i: number) => { method: string; path: string; headers?: Record<string, string>; body?: any };
async function scenario(name: string, mk: Req, secs = SECS, conc = CONC) {
  const lat: number[] = []; let errors = 0, n = 0; const statuses: Record<number, number> = {};
  const until = Date.now() + secs * 1000; let seq = 0;
  async function worker() {
    while (Date.now() < until) {
      const r = mk(seq++); const t0 = performance.now();
      try { const res = await fetch(BASE + r.path, { method: r.method, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) }, body: r.body ? JSON.stringify(r.body) : undefined }); await res.arrayBuffer(); lat.push(performance.now() - t0); statuses[res.status] = (statuses[res.status] ?? 0) + 1; if (res.status >= 400) errors++; }
      catch { errors++; statuses[0] = (statuses[0] ?? 0) + 1; }
      n++;
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  lat.sort((a, b) => a - b); const q = (p: number) => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] * 10) / 10 : null;
  return { scenario: name, concurrency: conc, requests: n, rps: Math.round(n / secs), errors, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat.length ? Math.round(lat[lat.length - 1]) : null, statuses };
}

(async () => {
  console.log(`seeding ${USERS} learners in ${DB} ...`); const S = await seed();
  const env: any = { ...process.env, NODE_ENV: 'loadtest', PORT: String(PORT), DATABASE_URL: URL_DB, JWT_SECRET: SECRET, RATE_LIMIT_DISABLED: '1', AI_WORKER: '0', MEDIA_ROOT: MEDIA, MEDIA_TOKEN_SECRET: SECRET, REQUEST_LOG: '0', ...(process.env.LT_SERVER_ENV ? JSON.parse(process.env.LT_SERVER_ENV) : {}) };
  const srv = spawn('node', ['dist/src/main.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health/ready`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const tok = (i: number) => ({ Authorization: `Bearer ${S.tokens[i % USERS]}` });
  const hb = (i: number) => { const u = i % USERS; return { eventId: crypto.randomUUID(), topicId: S.topic1, type: 'VIDEO_HEARTBEAT', occurredAt: new Date().toISOString(), payload: { assetId: S.assetId, from: (i * 15) % 585, to: ((i * 15) % 585) + 15 } }; };
  const cpu = () => { try { return sh(`ps -o %cpu=,rss= -p ${srv.pid}`).trim().split(/\s+/).map(Number); } catch { return [0, 0]; } };
  const out: any[] = []; const run = async (s: ReturnType<typeof scenario>) => { const c0 = cpu(); const r = await s; out.push({ ...r, serverRssMB: Math.round(cpu()[1] / 1024) }); void c0; console.log(JSON.stringify(r)); };

  await scenario('warmup', (i) => ({ method: 'GET', path: '/health' }), 2, 16);
  await run(scenario('health (floor: framework overhead)', () => ({ method: 'GET', path: '/health' })));
  await run(scenario('GET auth/me (guard + 1 query)', (i) => ({ method: 'GET', path: '/v1/auth/me', headers: tok(i) })));
  await run(scenario('GET progress (unlock computation)', (i) => ({ method: 'GET', path: `/v1/me/entitlements/${S.ents[i % USERS]}/progress`, headers: tok(i) })));
  await run(scenario('GET topic + playback manifest', (i) => ({ method: 'GET', path: `/v1/topics/${i % 2 ? S.topic1 : S.topic1}/playback`, headers: tok(i) })));
  await run(scenario('POST learning-events (4 heartbeats)', (i) => ({ method: 'POST', path: '/v1/learning-events', headers: tok(i), body: { events: [0, 1, 2, 3].map((k) => hb(i * 4 + k)) } })));
  await run(scenario('PUT exam autosave', (i) => { const u = i % USERS; return { method: 'PUT', path: `/v1/exam-attempts/${S.attempts[u]}/answers`, headers: { ...tok(i), 'x-exam-session': S.examTok[u] }, body: { seq: Math.floor(i / USERS) + 1 + Math.floor(Math.random() * 1e6), answers: { [S.paper[i % 10].questionId]: i % 4 } } }; }));
  await run(scenario('POST login (scrypt, CPU-bound)', (i) => ({ method: 'POST', path: '/v1/auth/login', body: { email: `lt${i % 200}@x.test`, password: 'Load-Test-Pass-1' } }), Math.min(SECS, 8), Math.min(CONC, 32)));
  const [pcpu, rss] = cpu(); srv.kill('SIGTERM');
  const file = join(__dirname, '../../docs/perf', `loadtest-${new Date().toISOString().slice(0, 10)}${process.env.LT_TAG ? '-' + process.env.LT_TAG : ''}.json`); mkdirSync(join(__dirname, '../../docs/perf'), { recursive: true });
  writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), machine: sh('sysctl -n machdep.cpu.brand_string || true').trim(), cpus: require('os').cpus().length, seconds: SECS, concurrency: CONC, users: USERS, note: 'client+server+postgres on one machine: indicative only', results: out, serverCpuPctAtEnd: pcpu, serverRssMB: Math.round(rss / 1024) }, null, 1));
  console.log(`wrote ${file}`); process.exit(0);
})();
