// Open-loop load generator process (started by loadtest-scale.ts). Plain JS so it can be forked without a TypeScript runtime.
// Open loop: requests are issued at the target rate whether or not earlier ones have finished, so a slow server shows up as latency and
// failures (the real-world behaviour), not as a quietly lower request rate (the "coordinated omission" flaw of fixed-concurrency tests).
const { readFileSync } = require('fs');
const crypto = require('crypto');
const BINS = 30001; // 1 ms resolution up to 30 s
let D, bases, gen, gens, rr = 0, examCursor = 0;
const seqOf = new Map(); // exam autosave: next sequence number per attempt (each attempt belongs to exactly one generator)

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const base = () => bases[rr++ % bases.length];
const myUser = (n) => { const i = Math.floor(Math.random() * Math.floor(n / gens)) * gens + gen; return i < n ? i : gen; };
const auth = (i) => ({ Authorization: `Bearer ${D.tokens[i]}` });
const OPS = {
  hb: () => { const i = myUser(D.users); const t = Date.now(); const k = Math.floor(Math.random() * 580); return { m: 'POST', p: '/v1/learning-events', h: auth(i), b: { events: [0, 1, 2, 3].map((j) => ({ eventId: crypto.randomUUID(), topicId: D.topic1, type: 'VIDEO_HEARTBEAT', occurredAt: new Date(t).toISOString(), payload: { assetId: D.assetId, from: (k + j * 15) % 585, to: ((k + j * 15) % 585) + 15 } })) }, parse: 'hb' }; },
  progress: () => { const i = myUser(D.users); return { m: 'GET', p: `/v1/me/entitlements/${D.ents[i]}/progress`, h: auth(i) }; },
  playback: () => { const i = myUser(D.users); return { m: 'GET', p: `/v1/topics/${D.topic1}/playback`, h: auth(i) }; },
  me: () => { const i = myUser(D.users); return { m: 'GET', p: '/v1/auth/me', h: auth(i) }; },
  entitlements: () => { const i = myUser(D.users); return { m: 'GET', p: '/v1/me/entitlements', h: auth(i) }; },
  notifications: () => { const i = myUser(D.users); return { m: 'GET', p: '/v1/me/notifications', h: auth(i) }; },
  catalogue: () => { const i = myUser(D.users); return { m: 'GET', p: '/v1/catalogue', h: auth(i) }; },
  myexams: () => { const i = myUser(D.users); return { m: 'GET', p: '/v1/me/exams', h: auth(i) }; },
  autosave: () => { // round-robin over this generator's own attempts: one in-flight request per attempt in practice, strictly increasing sequence
    const mine = Math.floor(D.examUsers / gens); const u = (examCursor++ % mine) * gens + gen; const seq = (seqOf.get(u) ?? 0) + 1; seqOf.set(u, seq);
    return { m: 'PUT', p: `/v1/exam-attempts/${D.attempts[u]}/answers`, h: { ...auth(u), 'x-exam-session': D.examTok[u] }, b: { seq, answers: { [D.paper[seq % 10].questionId]: seq % 4 } }, attempt: u, seq };
  },
  login: () => ({ m: 'POST', p: '/v1/auth/login', h: {}, b: { email: `lt${Math.floor(Math.random() * 2000)}@x.test`, password: 'Load-Test-Pass-1' } }),
  staffstatus: () => ({ m: 'GET', p: '/v1/exam-ops/status', h: { Authorization: `Bearer ${D.staffToken}` } }),
  staffreport: () => ({ m: 'GET', p: `/v1/reports/exams?examId=${D.examId}`, h: { Authorization: `Bearer ${D.staffToken}` } }),
};

async function run(msg) {
  const { durationMs, rates } = msg; const stats = {}; for (const k of Object.keys(rates)) stats[k] = { sent: 0, ok: 0, err: 0, hist: new Int32Array(BINS), statuses: {}, hbAccepted: 0, hbOther: {}, acks: {}, };
  let inflight = 0, maxInflight = 0, dropped = 0; const CAP = 5000; const acc = {}; for (const k of Object.keys(rates)) acc[k] = 0;
  const start = Date.now(); let last = start; const pending = [];
  const fire = (name) => {
    if (inflight >= CAP) { dropped++; return; }
    const r = OPS[name](); const s = stats[name]; s.sent++; inflight++; maxInflight = Math.max(maxInflight, inflight); const t0 = performance.now();
    const p = fetch(base() + r.p, { method: r.m, headers: { 'content-type': 'application/json', ...r.h }, body: r.b ? JSON.stringify(r.b) : undefined }).then(async (res) => {
      let txt = null; if (r.parse === 'hb' && res.status < 300) txt = await res.json().catch(() => null); else await res.arrayBuffer();
      const ms = Math.min(BINS - 1, Math.round(performance.now() - t0)); s.hist[ms]++; s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
      if (res.status >= 400) s.err++; else { s.ok++; if (r.attempt !== undefined) s.acks[r.attempt] = Math.max(s.acks[r.attempt] ?? 0, r.seq); }
      if (txt?.results) for (const x of txt.results) { if (x.status === 'accepted') s.hbAccepted++; else s.hbOther[x.status] = (s.hbOther[x.status] ?? 0) + 1; }
    }).catch(() => { s.err++; s.statuses[0] = (s.statuses[0] ?? 0) + 1; s.hist[BINS - 1]++; }).finally(() => { inflight--; });
    pending.push(p); if (pending.length > 20000) pending.splice(0, 10000);
  };
  await new Promise((resolve) => {
    const tick = setInterval(() => { const now = Date.now(); const dt = (now - last) / 1000; last = now; for (const k of Object.keys(rates)) { acc[k] += rates[k] * dt; while (acc[k] >= 1) { acc[k] -= 1; fire(k); } } if (now - start >= durationMs) { clearInterval(tick); resolve(); } }, 4);
  });
  const t = Date.now(); while (inflight > 0 && Date.now() - t < 35000) await new Promise((r) => setTimeout(r, 50)); // let stragglers finish (or count as slow)
  const out = {}; for (const [k, s] of Object.entries(stats)) out[k] = { sent: s.sent, ok: s.ok, err: s.err, hist: Array.from(s.hist), statuses: s.statuses, hbAccepted: s.hbAccepted, hbOther: s.hbOther, acks: s.acks };
  process.send({ type: 'result', id: msg.id, ops: out, dropped, maxInflight, stuck: inflight });
}
process.on('message', async (msg) => {
  if (msg.type === 'init') { D = JSON.parse(readFileSync(msg.file, 'utf8')); bases = msg.bases; gen = msg.gen; gens = msg.gens; process.send({ type: 'ready' }); }
  else if (msg.type === 'run') await run(msg);
  else if (msg.type === 'exit') process.exit(0);
});
