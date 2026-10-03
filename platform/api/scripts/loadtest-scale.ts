/**
 * Scale load test. Builds the production topology on one machine and drives the TRD demand model at it with an OPEN-LOOP generator:
 *   N API instances (PROCESS_ROLE=api) -> PgBouncer (transaction pooling) -> PostgreSQL, shared Redis (rate limits + session revocation), one worker.
 * Seeds 50,000 learners (entitlements, progress, sessions) and 10,000 in-progress exam attempts, then runs a plan of steps and writes
 * docs/perf/loadtest-scale-<date>-<tag>.json. Every step is judged against the stated criteria (docs/capacity-model.md): p95 < 2 s, p99 < 5 s,
 * error rate < 0.1 %, achieved rate >= 97 % of target; plus integrity checks (no lost heartbeat events, no lost acknowledged autosaves).
 *
 *   npm run build && npx ts-node scripts/loadtest-scale.ts
 *   LT_INSTANCES=1 LT_PLAN=ramp LT_TAG=single npx ts-node scripts/loadtest-scale.ts
 *
 * Env: LT_USERS (50000) LT_EXAM_USERS (10000) LT_INSTANCES (3) LT_GENS (3) LT_STEP (45 s) LT_SOAK (300 s) LT_PLAN (ramp,exam,login,soak) LT_REUSE=1 (keep the seeded DB)
 * ONE MACHINE runs the generator, the API instances, PgBouncer, Redis, PostgreSQL and the worker: it shows where the stack saturates and what each
 * component costs, not what a real multi-host deployment will do. See docs/quality/load-test-report.md.
 */
import 'reflect-metadata';
import { ChildProcess, execSync, fork, spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const USERS = env('LT_USERS', 50_000), EXAM_USERS = Math.min(USERS, env('LT_EXAM_USERS', 10_000)), INST = env('LT_INSTANCES', 3), GENS = env('LT_GENS', 3), STEP = env('LT_STEP', 45), SOAK = env('LT_SOAK', 300);
const PLAN = (process.env.LT_PLAN ?? 'ramp,exam,login,soak').split(','); const DB = 'edtech_perf'; const PG = 'postgresql://edtech:edtech@localhost:5433';
const BG = Number(process.env.LT_BG ?? 0.25), SOAK_X = Number(process.env.LT_SOAK_X ?? 0.5); const PORTS = Array.from({ length: INST }, (_, i) => 3201 + i); const BOUNCER = 6439, REDIS = 6391; const SECRET = 'loadtest-secret';
const TMP = mkdtempSync(join(tmpdir(), 'lt-scale-')); const SEEDFILE = join(TMP, 'seed.json'); const SEEDMETA = join(tmpdir(), 'lt-scale-seed-meta.json');
const sh = (c: string, e: any = {}) => execSync(c, { stdio: 'pipe', maxBuffer: 1 << 28, env: { ...process.env, ...e, PATH: `/opt/homebrew/opt/postgresql@16/bin:${process.env.PATH}` } }).toString();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const id = (p: number, i: number) => `${p}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

async function seed() {
  if (process.env.LT_REUSE === '1' && existsSync(SEEDMETA)) { log('reusing the seeded database'); const m = JSON.parse(readFileSync(SEEDMETA, 'utf8')); return m; }
  log(`seeding ${USERS} learners + ${EXAM_USERS} exam attempts into ${DB} ...`);
  try { sh(`psql -h localhost -p 5433 -U edtech -d postgres -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)"`); } catch { /* ignore */ }
  sh(`psql -h localhost -p 5433 -U edtech -d postgres -c "CREATE DATABASE ${DB}"`); sh('npx prisma migrate deploy', { DATABASE_URL: `${PG}/${DB}` });
  const prisma = new PrismaClient({ datasources: { db: { url: `${PG}/${DB}` } } });
  const { hashPassword } = require('../src/common/auth'); const pw = hashPassword('Load-Test-Pass-1');
  const prog = await prisma.programme.create({ data: { code: 'LT', title: 'Load', discipline: 'AI/ML' } });
  const v = await prisma.programmeVersion.create({ data: { programmeId: prog.id, version: 1, state: 'PUBLISHED', authorId: 'x', hours: 12, publishedAt: new Date(), languages: ['en'], modules: { create: [1, 2, 3].map((m) => ({ position: m, title: `M${m}`, topics: { create: [1, 2, 3, 4].map((t) => ({ position: t, title: `T${m}.${t}`, hours: 1, outcomes: ['o'] })) } })) } }, include: { modules: { include: { topics: true } } } });
  const topics = v.modules.flatMap((m) => m.topics); const t0 = topics.sort((a, b) => a.position - b.position)[0];
  const asset = await prisma.contentAsset.create({ data: { topicId: t0.id, language: 'en', durationSec: 600, createdById: 'x', files: { master: { key: 'a/master', checksum: 'c', size: 10 }, '360p': { key: 'a/360p', checksum: 'c', size: 10 } } } });
  const MEDIA = join(TMP, 'media'); mkdirSync(join(MEDIA, 'a'), { recursive: true }); writeFileSync(join(MEDIA, 'a/master'), 'x'.repeat(1000)); writeFileSync(join(MEDIA, 'a/360p'), 'x'.repeat(1000));
  const ids = Array.from({ length: USERS }, (_, i) => id(0, i)); const chunk = async <T,>(rows: T[], f: (c: T[]) => Promise<unknown>, n = 5000) => { for (let i = 0; i < rows.length; i += n) await f(rows.slice(i, i + n)); };
  await chunk(ids, (c) => prisma.user.createMany({ data: c.map((u) => ({ id: u, email: `lt${parseInt(u.slice(-12), 10)}@x.test`, name: `LT ${u.slice(-6)}`, passwordHash: pw })) }));
  await chunk(ids, (c) => prisma.userRole.createMany({ data: c.map((u) => ({ userId: u, role: 'LEARNER' as const })) }));
  const ents = ids.map((u, i) => ({ id: id(1, i), learnerId: u, versionId: v.id, duration: 'M12' as const, cohort: 'C', startAt: new Date(Date.now() - 86_400_000), endAt: new Date(Date.now() + 300 * 86_400_000), approvedById: 'x' }));
  await chunk(ents, (c) => prisma.entitlement.createMany({ data: c }));
  await chunk(ents, (c) => prisma.topicProgress.createMany({ data: c.map((e) => ({ entitlementId: e.id, topicId: t0.id, videoDone: true, videoRanges: { [asset.id]: [[0, 600]] } as any })) }));
  const sessions = ids.map((u, i) => ({ id: id(2, i), userId: u, authMethod: 'PASSWORD', expiresAt: new Date(Date.now() + 6 * 3600_000) }));
  await chunk(sessions, (c) => prisma.userSession.createMany({ data: c }));
  // staff (exam admin) for the dashboards an invigilator polls during an exam
  const staffId = id(9, 1); await prisma.user.create({ data: { id: staffId, email: 'staff@x.test', name: 'Staff', passwordHash: pw, roles: { create: { role: 'EXAM_ADMIN' } } } }); await prisma.userSession.create({ data: { id: id(9, 2), userId: staffId, authMethod: 'PASSWORD', expiresAt: new Date(Date.now() + 6 * 3600_000) } });
  const jwt = require('jsonwebtoken'); const tokens = ids.map((u, i) => jwt.sign({ sub: u, roles: ['LEARNER'], sid: sessions[i].id }, SECRET, { expiresIn: '6h' })); const staffToken = jwt.sign({ sub: staffId, roles: ['EXAM_ADMIN'], sid: id(9, 2) }, SECRET, { expiresIn: '6h' });
  const exam = await prisma.examDefinition.create({ data: { versionId: v.id, code: 'LT', title: 'LT', status: 'PUBLISHED', durationMin: 60, eligibility: {}, blueprint: [], proctoring: { mode: 'CENTRE' }, createdById: 'x' } });
  const sess = await prisma.examSession.create({ data: { examId: exam.id, startsAt: new Date(Date.now() - 600_000), endsAt: new Date(Date.now() + 6 * 3600_000), mode: 'CENTRE', capacity: 1e6, createdById: 'x' } });
  const qs = await prisma.examQuestion.createManyAndReturn({ data: Array.from({ length: 10 }, (_, i) => ({ programmeId: prog.id, tag: 't', type: 'MCQ_SINGLE' as const, text: `q${i}`, options: ['a', 'b', 'c', 'd'], answer: 0, createdById: 'x' })) });
  const paper = qs.map((q) => ({ questionId: q.id, tag: 't', points: 1, optionOrder: [0, 1, 2, 3] })); const examTok = ids.slice(0, EXAM_USERS).map((_, i) => `examtok-${i}`);
  const regs = ids.slice(0, EXAM_USERS).map((u, i) => ({ id: id(3, i), examId: exam.id, sessionId: sess.id, learnerId: u, entitlementId: ents[i].id }));
  await chunk(regs, (c) => prisma.examRegistration.createMany({ data: c }));
  await chunk(regs, (c) => prisma.examAttempt.createMany({ data: c.map((r) => { const i = parseInt(r.id.slice(-12), 10); return { id: id(4, i), examId: exam.id, sessionId: sess.id, registrationId: r.id, learnerId: r.learnerId, entitlementId: r.entitlementId, attemptNo: 1, status: 'IN_PROGRESS', startedAt: new Date(), deadlineAt: new Date(Date.now() + 6 * 3600_000), paper: paper as any, sessionTokenHash: createHash('sha256').update(examTok[i]).digest('hex') }; }) }));
  await prisma.$disconnect();
  const data = { users: USERS, examUsers: EXAM_USERS, tokens, ents: ents.map((e) => e.id), topic1: t0.id, assetId: asset.id, examTok, paper, attempts: Array.from({ length: EXAM_USERS }, (_, i) => id(4, i)), staffToken, examId: exam.id };
  writeFileSync(SEEDFILE, JSON.stringify(data)); writeFileSync(SEEDMETA, JSON.stringify({ media: MEDIA, seedFile: SEEDFILE }));
  log('seeded'); return { media: MEDIA, seedFile: SEEDFILE };
}

interface Proc { name: string; p: ChildProcess; pid: number }
const procs: Proc[] = [];
const up = (name: string, cmd: string, args: string[], e: any = {}, logFile?: string) => { const p = spawn(cmd, args, { env: { ...process.env, ...e }, stdio: ['ignore', logFile ? 'pipe' : 'ignore', logFile ? 'pipe' : 'inherit'] }); if (logFile) { const w = createWriteStream(logFile); p.stdout?.pipe(w); p.stderr?.pipe(w); } procs.push({ name, p, pid: p.pid! }); return p; };
async function waitHttp(url: string) { for (let i = 0; i < 90; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`not ready: ${url}`); }

// CPU seconds per process from `ps` (cumulative cputime has 10 ms resolution; macOS %cpu is a decaying average and unsuitable)
const cpuSecs = (t: string) => t.split(':').reduce((a, x) => a * 60 + parseFloat(x), 0);
function sample() {
  const lines = sh('ps -axo pid=,cputime=,rss=,command=').split('\n').filter(Boolean); const by: Record<string, { cpu: number; rssMB: number }> = {}; const add = (k: string, cpu: number, rss: number) => { by[k] = { cpu: (by[k]?.cpu ?? 0) + cpu, rssMB: (by[k]?.rssMB ?? 0) + rss / 1024 }; };
  const mine = new Map(procs.map((x) => [x.pid, x.name]));
  for (const l of lines) { const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(l); if (!m) continue; const pid = Number(m[1]), cpu = cpuSecs(m[2]), rss = Number(m[3]), cmd = m[4];
    if (mine.has(pid)) add(mine.get(pid)!, cpu, rss); else if (/postgres: /.test(cmd) || /\/postgres( |$)/.test(cmd)) add('postgres', cpu, rss); }
  return by;
}

const BASE_RATES: Record<string, number> = { hb: 583, progress: 200, playback: 150, entitlements: 100, notifications: 50, me: 80, catalogue: 50, myexams: 37 }; // = 1,250 req/s: the TRD steady-state demand (capacity-model.md)
const scale = (m: number, extra: Record<string, number> = {}) => ({ ...Object.fromEntries(Object.entries(BASE_RATES).map(([k, v]) => [k, v * m])), staffstatus: 3, ...extra });
interface StepDef { name: string; seconds: number; rates: Record<string, number>; note?: string }
function steps(): StepDef[] {
  const out: StepDef[] = [];
  if (PLAN.includes('ramp')) for (const m of (process.env.LT_RAMP ?? '0.25,0.5,0.75,1,1.5').split(',').map(Number)) out.push({ name: `steady x${m}`, seconds: STEP, rates: scale(m), note: `${Math.round(1250 * m)} req/s of the learner mix` });
  if (PLAN.includes('exam')) { out.push({ name: 'exam 10k attempts (500 autosave/s) + background', seconds: STEP, rates: scale(BG, { autosave: 500, staffreport: 0.2 }) }); out.push({ name: 'exam 25k-equivalent (1,250 autosave/s) + background', seconds: STEP, rates: scale(BG, { autosave: 1250, staffreport: 0.2 }) }); }
  if (PLAN.includes('login')) { out.push({ name: 'morning sign-in burst 55/s + quarter steady', seconds: STEP, rates: scale(0.25, { login: 55 }) }); out.push({ name: 'sign-in burst 110/s + quarter steady', seconds: STEP, rates: scale(0.25, { login: 110 }) }); }
  if (PLAN.includes('soak')) out.push({ name: `soak: steady x${SOAK_X} for ${SOAK}s`, seconds: SOAK, rates: scale(SOAK_X), note: 'drift in latency, memory and errors over time' });
  return out;
}

const pctl = (hist: number[], p: number) => { const n = hist.reduce((a, b) => a + b, 0); if (!n) return null; let c = 0; const t = n * p; for (let i = 0; i < hist.length; i++) { c += hist[i]; if (c >= t) return i; } return hist.length - 1; };

(async () => {
  const S = await seed(); const seedFile = (S as any).seedFile ?? SEEDFILE; const MEDIA = (S as any).media;
  const directDb = new PrismaClient({ datasources: { db: { url: `${PG}/${DB}` } } });
  log(`starting redis, pgbouncer, ${INST} API instance(s), 1 worker`);
  up('redis', 'redis-server', ['--port', String(REDIS), '--save', '', '--appendonly', 'no']);
  writeFileSync(join(TMP, 'userlist.txt'), '"edtech" "edtech"\n');
  writeFileSync(join(TMP, 'pgb.ini'), `[databases]\n${DB} = host=127.0.0.1 port=5433 dbname=${DB}\n[pgbouncer]\nlisten_addr=127.0.0.1\nlisten_port=${BOUNCER}\nauth_type=plain\nauth_file=${join(TMP, 'userlist.txt')}\npool_mode=transaction\ndefault_pool_size=${env('LT_POOL', 40)}\nmax_client_conn=2000\nlogfile=${join(TMP, 'pgb.log')}\npidfile=${join(TMP, 'pgb.pid')}\nignore_startup_parameters=extra_float_digits\n`);
  up('pgbouncer', 'pgbouncer', [join(TMP, 'pgb.ini')]);
  await new Promise((r) => setTimeout(r, 1500));
  const common = { NODE_ENV: 'loadtest', JWT_SECRET: SECRET, AI_WORKER: '0', MEDIA_ROOT: MEDIA, MEDIA_TOKEN_SECRET: SECRET, REQUEST_LOG: '0', REDIS_URL: `redis://127.0.0.1:${REDIS}`, RL_IP_PER_MIN: '100000000', RL_LOGIN_PER_MIN: '100000000', /* one IP drives all virtual users; the per-IP limits are tested separately (a campus NAT matters, see the report) */ DB_PGBOUNCER: '1' };
  const dbUrl = (limit: number) => `postgresql://edtech:edtech@127.0.0.1:${BOUNCER}/${DB}?pgbouncer=true&connection_limit=${limit}`;
  PORTS.forEach((port, i) => up(`api${i + 1}`, 'node', ['dist/src/main.js'], { ...common, PROCESS_ROLE: 'api', PORT: String(port), DATABASE_URL: dbUrl(env('LT_DB_CONN', 20)) }, join(TMP, `api${i + 1}.log`)));
  up('worker', 'node', ['dist/src/worker.js'], { ...common, PROCESS_ROLE: 'worker', DATABASE_URL: dbUrl(5) }, join(TMP, 'worker.log'));
  for (const port of PORTS) await waitHttp(`http://127.0.0.1:${port}/health/ready`);
  log('stack is up');
  if (process.env.LT_REUSE === '1') await directDb.$executeRawUnsafe(`TRUNCATE "LearningEvent","ExamEvent"; UPDATE "ExamAttempt" SET "saveSeq" = 0, answers = '{}'`); // a reused database starts every run from the same state
  const bases = PORTS.map((p) => `http://127.0.0.1:${p}`);
  const gens: ChildProcess[] = []; const pend = new Map<number, (m: any) => void>();
  for (let g = 0; g < GENS; g++) { const c = fork(join(__dirname, 'loadgen.js'), [], { execArgv: ['--max-old-space-size=3072'] }); procs.push({ name: `gen${g + 1}`, p: c, pid: c.pid! }); gens.push(c); c.on('message', (m: any) => { if (m.type === 'result') pend.get(m.id * 100 + g)?.(m); }); await new Promise<void>((r) => { c.once('message', () => r()); c.send({ type: 'init', file: seedFile, bases, gen: g, gens: GENS }); }); }
  let runId = 0;
  const runStep = (d: StepDef) => new Promise<any[]>((resolve) => { const rid = ++runId; const got: any[] = []; gens.forEach((c, g) => { pend.set(rid * 100 + g, (m) => { got.push(m); if (got.length === GENS) resolve(got); }); c.send({ type: 'run', id: rid, durationMs: d.seconds * 1000, rates: Object.fromEntries(Object.entries(d.rates).map(([k, v]) => [k, v / GENS])) }); }); });

  // background sampler: process CPU and RSS, PostgreSQL connections and lock waits
  let samples: { t: number; ps: Record<string, { cpu: number; rssMB: number }>; pg: { active: number; waiting: number; total: number } }[] = [];
  let lastPg = { active: 0, waiting: 0, total: 0 }; // sampled on their own timers so a slow database never starves the CPU samples
  const sampler = setInterval(() => { try { samples.push({ t: Date.now(), ps: sample(), pg: lastPg }); } catch { /* ignore */ } }, 2000);
  const pgSampler = setInterval(async () => { try { const [r] = await directDb.$queryRawUnsafe<any[]>(`SELECT count(*) FILTER (WHERE state='active')::int active, count(*) FILTER (WHERE wait_event_type='Lock')::int waiting, count(*)::int total FROM pg_stat_activity WHERE datname='${DB}'`); lastPg = r; } catch { /* busy */ } }, 1000);

  const report: any[] = []; await runStep({ name: 'warmup', seconds: 20, rates: scale(0.1) }); log('warm');
  for (const d of steps()) {
    samples = []; log(`>> ${d.name} (${d.seconds}s)`); const t0 = Date.now(); const res = await runStep(d); const secs = (Date.now() - t0) / 1000;
    const ops: Record<string, any> = {}; let sent = 0, errors = 0, dropped = 0, ok = 0;
    for (const k of Object.keys(d.rates)) { const hist = new Array(30001).fill(0); let s = 0, o = 0, e = 0; const statuses: Record<string, number> = {}; let hbAcc = 0; for (const g of res) { const x = g.ops[k]; if (!x) continue; s += x.sent; o += x.ok; e += x.err; x.hist.forEach((n: number, i: number) => { hist[i] += n; }); for (const [st, n] of Object.entries(x.statuses)) statuses[st] = (statuses[st] ?? 0) + (n as number); hbAcc += x.hbAccepted; }
      sent += s; errors += e; ok += o; ops[k] = { targetRps: d.rates[k], sent: s, ok: o, errors: e, errorPct: s ? Math.round((e / s) * 1e4) / 100 : 0, p50: pctl(hist, 0.5), p95: pctl(hist, 0.95), p99: pctl(hist, 0.99), statuses, ...(k === 'hb' ? { eventsAccepted: hbAcc } : {}) }; }
    dropped = res.reduce((a, g) => a + g.dropped, 0); const stuck = res.reduce((a, g) => a + g.stuck, 0); const maxInflight = res.reduce((a, g) => a + g.maxInflight, 0);
    const target = Object.values(d.rates).reduce((a, b) => a + b, 0); const achieved = Math.round(ok / d.seconds);
    const cpuOf = (name: string) => { const a = samples[0]?.ps[name], b = samples[samples.length - 1]?.ps[name]; return a && b && samples.length > 1 ? Math.round(((b.cpu - a.cpu) / ((samples[samples.length - 1].t - samples[0].t) / 1000)) * 100) / 100 : null; };
    const apiCpu = PORTS.map((_, i) => cpuOf(`api${i + 1}`)); const rss = (name: string, last = true) => { const x = samples[last ? samples.length - 1 : 0]?.ps[name]; return x ? Math.round(x.rssMB) : null; };
    const worst = (f: 'p95' | 'p99') => Math.max(0, ...Object.values(ops).map((o: any) => o[f] ?? 0));
    const verdict = { p95Ok: worst('p95') < 2000, p99Ok: worst('p99') < 5000, errorsOk: sent ? errors / sent < 0.001 : true, rateOk: achieved >= 0.97 * target, droppedOk: dropped === 0 };
    const row = { step: d.name, note: d.note, seconds: d.seconds, targetRps: Math.round(target), achievedRps: achieved, sent, errors, errorPct: sent ? Math.round((errors / sent) * 1e4) / 100 : 0, dropped, stuck, maxInflight, worstP95: worst('p95'), worstP99: worst('p99'), pass: Object.values(verdict).every(Boolean), verdict,
      cpuCores: { api: apiCpu, worker: cpuOf('worker'), pgbouncer: cpuOf('pgbouncer'), redis: cpuOf('redis'), postgres: cpuOf('postgres'), generators: [1, 2, 3, 4].map((i) => cpuOf(`gen${i}`)).filter((x) => x !== null) }, rssMB: { api: PORTS.map((_, i) => rss(`api${i + 1}`)), apiAtStart: PORTS.map((_, i) => rss(`api${i + 1}`, false)), postgres: rss('postgres') },
      pg: { maxActive: Math.max(0, ...samples.map((s) => s.pg.active)), maxWaitingOnLock: Math.max(0, ...samples.map((s) => s.pg.waiting)), maxConnections: Math.max(0, ...samples.map((s) => s.pg.total)) }, ops };
    report.push(row); log(`   target ${row.targetRps}/s achieved ${achieved}/s errors ${row.errorPct}% p95 ${row.worstP95}ms p99 ${row.worstP99}ms ${row.pass ? 'PASS' : 'FAIL'} api cpu ${JSON.stringify(apiCpu)} pg ${cpuOf('postgres')}`);
    (row as any)._acks = res.map((g) => g.ops.autosave?.acks ?? {}); (row as any)._hb = res.map((g) => g.ops.hb?.hbAccepted ?? 0);
  }
  clearInterval(sampler); clearInterval(pgSampler);
  // ---- integrity: nothing acknowledged may be lost ----------------------------------------------------------------------------------------
  const hbAcked = report.reduce((a, r) => a + (r._hb as number[]).reduce((x, y) => x + y, 0), 0) + 0;
  const dbEvents = Number((await directDb.$queryRawUnsafe<any[]>(`SELECT count(*)::bigint n FROM "LearningEvent"`))[0].n);
  const lastAck = new Map<number, number>(); for (const r of report) for (const m of r._acks as Record<string, number>[]) for (const [a, s] of Object.entries(m)) lastAck.set(Number(a), Math.max(lastAck.get(Number(a)) ?? 0, s));
  const saved = await directDb.$queryRawUnsafe<any[]>(`SELECT id, "saveSeq" FROM "ExamAttempt"`); const dbSeq = new Map(saved.map((x) => [x.id, x.saveSeq as number])); let lostAutosaves = 0, checked = 0;
  for (const [a, s] of lastAck) { checked++; if ((dbSeq.get(id(4, a)) ?? 0) < s) lostAutosaves++; }
  const sizes = await directDb.$queryRawUnsafe<any[]>(`SELECT relname, n_live_tup::bigint rows, pg_total_relation_size(relid)::bigint bytes FROM pg_stat_user_tables WHERE relname IN ('LearningEvent','ExamEvent','AuditEvent','TopicProgress','ExamAttempt') ORDER BY relname`);
  const apiErrors = PORTS.map((_, i) => { try { return Number(sh(`grep -c '"level":"error"' ${join(TMP, `api${i + 1}.log`)} || true`).trim() || 0); } catch { return 0; } });
  const integrity = { heartbeatEventsAcknowledged: hbAcked, heartbeatEventsInDatabase: dbEvents, lost: Math.max(0, hbAcked - dbEvents), autosaveAttemptsChecked: checked, lostAcknowledgedAutosaves: lostAutosaves, apiErrorLogLines: apiErrors, tables: sizes.map((s) => ({ table: s.relname, rows: Number(s.rows), mb: Math.round(Number(s.bytes) / 1048576) })) };
  log('integrity', JSON.stringify(integrity));
  for (const r of report) { delete r._acks; delete r._hb; }
  const file = join(__dirname, '../../docs/perf', `loadtest-scale-${new Date().toISOString().slice(0, 10)}${process.env.LT_TAG ? '-' + process.env.LT_TAG : ''}.json`); mkdirSync(join(__dirname, '../../docs/perf'), { recursive: true });
  writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), machine: sh('sysctl -n machdep.cpu.brand_string').trim(), cpus: require('os').cpus().length, memGB: Math.round(require('os').totalmem() / 2 ** 30), topology: { apiInstances: INST, generators: GENS, pgbouncerPool: env('LT_POOL', 40), perInstanceDbConnections: env('LT_DB_CONN', 20), redis: true, worker: 1 }, seeded: { learners: USERS, examAttempts: EXAM_USERS }, criteria: { p95Ms: 2000, p99Ms: 5000, errorPct: 0.1, achievedPctOfTarget: 97 }, steps: report, integrity }, null, 1));
  log(`wrote ${file}`);
  for (const g of gens) g.send({ type: 'exit' }); await directDb.$disconnect(); for (const p of procs) { try { p.p.kill('SIGTERM'); } catch { /* gone */ } }
  process.exit(0);
})().catch((e) => { console.error(e); for (const p of procs) { try { p.p.kill('SIGKILL'); } catch { /* gone */ } } process.exit(1); });
