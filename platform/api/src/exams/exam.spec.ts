import http from 'http';
import { AddressInfo } from 'net';
import { accepting, answersHash, buildPaper, deadlineFor, defaultRules, evaluateDevice, evaluateEligibility, EligibilityFacts, GRACE_MS, receiptCode, resultStateFor, scoreAttempt, signalIncidents, validateBlueprint, watermarkFor, BankItem } from '../domain/exam';
import { HttpProctor, MockProctor, proctorContract, signWebhook, verifyWebhook, learnerToken } from '../proctoring/provider';

const now = new Date('2026-10-05T06:00:00Z');
const facts = (o: Partial<EligibilityFacts> = {}): EligibilityFacts => ({ entitlementActive: true, programmePercent: 100, labsCompleted: ['L1', 'L2'], labsMandatory: ['L1', 'L2'], assignmentAverage: 80, assignmentsPending: 0, integrityConcerns: 0, attemptsUsed: 0, maxAttempts: 2, lastAttemptAt: null, cooldownDays: 7, now, ...o });

describe('eligibility (EXM-001)', () => {
  it('explains every failed condition in plain language', () => {
    const e = evaluateEligibility(defaultRules(), facts({ programmePercent: 80, labsCompleted: ['L1'], assignmentsPending: 2 }));
    expect(e.eligible).toBe(false); const bad = e.checks.filter((c) => !c.ok).map((c) => c.key); expect(bad).toEqual(['programme_progress', 'labs', 'assignments_released']);
    expect(e.checks.find((c) => c.key === 'labs')!.detail).toMatch(/L2/); expect(evaluateEligibility(defaultRules(), facts()).eligible).toBe(true);
  });
  it('required labs can be a named subset; assignment average rule is optional', () => {
    const r = { ...defaultRules(), requiredLabs: ['L1'], minAssignmentAveragePercent: 70 };
    expect(evaluateEligibility(r, facts({ labsCompleted: ['L1'] })).eligible).toBe(true); expect(evaluateEligibility(r, facts({ assignmentAverage: 60 })).eligible).toBe(false); expect(evaluateEligibility(r, facts({ assignmentAverage: null })).eligible).toBe(false);
  });
  it('attempt limits and cooldown', () => {
    expect(evaluateEligibility(defaultRules(), facts({ attemptsUsed: 2 })).eligible).toBe(false);
    expect(evaluateEligibility(defaultRules(), facts({ attemptsUsed: 1, lastAttemptAt: new Date('2026-10-01T00:00:00Z') })).eligible).toBe(false);
    expect(evaluateEligibility(defaultRules(), facts({ attemptsUsed: 1, lastAttemptAt: new Date('2026-09-20T00:00:00Z') })).eligible).toBe(true);
  });
  it('an exception waives academic checks but never entitlement or an integrity case', () => {
    expect(evaluateEligibility(defaultRules(), facts({ programmePercent: 50, labsCompleted: [] }), true)).toMatchObject({ eligible: true, overridden: true });
    expect(evaluateEligibility(defaultRules(), facts({ entitlementActive: false }), true).eligible).toBe(false);
    expect(evaluateEligibility(defaultRules(), facts({ integrityConcerns: 1 }), true).eligible).toBe(false);
  });
});

const bank: BankItem[] = [...Array(30)].map((_, i) => ({ id: `q${i}`, tag: i < 20 ? 'sensors' : 'networks', difficulty: 1 + (i % 3), points: 1 + (i % 2), optionCount: 4 }));
describe('paper construction (EXM-002)', () => {
  const bp = [{ tag: 'sensors', count: 5 }, { tag: 'networks', count: 4, minDifficulty: 2 }];
  it('is deterministic per seed, distinct across seeds, respects blueprint and difficulty, no duplicates', () => {
    const a = buildPaper(bp, bank, 'attempt-1', true), a2 = buildPaper(bp, bank, 'attempt-1', true), b = buildPaper(bp, bank, 'attempt-2', true);
    expect(a.items).toEqual(a2.items); expect(a.items.map((i) => i.questionId)).not.toEqual(b.items.map((i) => i.questionId));
    expect(a.items).toHaveLength(9); expect(new Set(a.items.map((i) => i.questionId)).size).toBe(9);
    expect(a.items.filter((i) => i.tag === 'sensors')).toHaveLength(5); a.items.filter((i) => i.tag === 'networks').forEach((i) => expect(bank.find((q) => q.id === i.questionId)!.difficulty).toBeGreaterThanOrEqual(2));
    expect(a.items.every((i) => [...i.optionOrder].sort().join() === '0,1,2,3')).toBe(true); expect(a.shortfalls).toEqual([]);
  });
  it('reports shortfalls and validates blueprints before an exam can be published', () => {
    expect(buildPaper([{ tag: 'networks', count: 50 }], bank, 's', true).shortfalls).toEqual([{ tag: 'networks', need: 50, have: 10 }]);
    const v = validateBlueprint([{ tag: 'sensors', count: 15 }, { tag: 'networks', count: 11 }, { tag: 'ghost', count: 1 }], bank);
    expect(v.errors.join()).toMatch(/networks.*needs 11 questions, bank has 10/); expect(v.errors.join()).toMatch(/ghost/); expect(v.warnings.join()).toMatch(/sensors.*overlap/); expect(validateBlueprint([], bank).errors).toHaveLength(1);
  });
  it('can keep option order when shuffling is off', () => { expect(buildPaper([{ tag: 'sensors', count: 2 }], bank, 'x', false).items[0].optionOrder).toEqual([0, 1, 2, 3]); });
});

describe('clock', () => {
  it('deadline = start + duration (+ accommodation), never beyond the session window; small grace for in-flight saves', () => {
    const start = new Date('2026-10-05T10:00:00Z'), end = new Date('2026-10-05T12:00:00Z');
    expect(deadlineFor(start, 60, 0, end).toISOString()).toBe('2026-10-05T11:00:00.000Z'); expect(deadlineFor(start, 60, 25, end).toISOString()).toBe('2026-10-05T11:15:00.000Z');
    expect(deadlineFor(new Date('2026-10-05T11:30:00Z'), 60, 0, end).toISOString()).toBe('2026-10-05T12:00:00.000Z'); // late starters lose time, they don't extend the window
    const d = new Date('2026-10-05T11:00:00Z'); expect(accepting(d, new Date(d.getTime() + GRACE_MS))).toBe(true); expect(accepting(d, new Date(d.getTime() + GRACE_MS + 1))).toBe(false);
  });
});

describe('scoring', () => {
  const keys = new Map<string, any>([['a', { type: 'MCQ_SINGLE', answer: 2, tolerance: 0, points: 2, tag: 's' }], ['b', { type: 'MCQ_MULTI', answer: [0, 3], tolerance: 0, points: 3, tag: 's' }], ['c', { type: 'NUMERIC', answer: 10, tolerance: 0.5, points: 1, tag: 't' }]]);
  const items = [{ questionId: 'a', tag: 's', points: 2, optionOrder: [3, 2, 1, 0] }, { questionId: 'b', tag: 's', points: 3, optionOrder: [1, 0, 3, 2] }, { questionId: 'c', tag: 't', points: 1, optionOrder: [] }];
  it('maps displayed option positions back through the stored permutation', () => {
    // a: correct original option 2 sits at displayed position 1; b: originals {0,3} sit at displayed {1,2}
    const r = scoreAttempt(items, keys, { a: 1, b: [2, 1], c: 10.4 }); expect(r).toMatchObject({ rawPoints: 6, maxPoints: 6, percent: 100 });
    const w = scoreAttempt(items, keys, { a: 2, b: [1], c: 'x' }); expect(w.rawPoints).toBe(0); expect(w.sections).toEqual({ s: { points: 0, max: 5 }, t: { points: 0, max: 1 } });
    expect(scoreAttempt(items, keys, { a: 99, b: 'bad', c: 10 }).rawPoints).toBe(1); expect(scoreAttempt(items, keys, {}).percent).toBe(0);
  });
});

describe('integrity signals and result hold (EXM-004)', () => {
  it('thresholded signals become incidents of increasing severity; indicators never invalidate by themselves', () => {
    expect(signalIncidents({ FOCUS_LOST: 4 })).toEqual([]); expect(signalIncidents({ FOCUS_LOST: 5 })).toEqual([{ type: 'tab_switch', severity: 'MEDIUM' }]); expect(signalIncidents({ FOCUS_LOST: 20, sessionSwitches: 3, COPY: 1 }).map((x) => x.severity)).toEqual(['HIGH', 'LOW', 'HIGH']);
  });
  const base = { submitted: true, mode: 'CENTRE' as const, proctorFinal: false, reportWaived: false, incidentStatuses: [] as string[], outcome: null as string | null };
  it('holds while incidents are open, until a remote proctor report is final, and until a human rules on confirmed major incidents', () => {
    expect(resultStateFor({ ...base, submitted: false })).toBe('NONE'); expect(resultStateFor(base)).toBe('READY');
    expect(resultStateFor({ ...base, incidentStatuses: ['OPEN'] })).toBe('HELD'); expect(resultStateFor({ ...base, incidentStatuses: ['NEEDS_INFO', 'DISMISSED'] })).toBe('HELD'); expect(resultStateFor({ ...base, incidentStatuses: ['DISMISSED', 'CONFIRMED_MINOR'] })).toBe('READY');
    expect(resultStateFor({ ...base, mode: 'REMOTE' })).toBe('HELD'); expect(resultStateFor({ ...base, mode: 'REMOTE', proctorFinal: true })).toBe('READY'); expect(resultStateFor({ ...base, mode: 'REMOTE', reportWaived: true })).toBe('READY');
    expect(resultStateFor({ ...base, incidentStatuses: ['CONFIRMED_MAJOR'] })).toBe('HELD'); expect(resultStateFor({ ...base, incidentStatuses: ['CONFIRMED_MAJOR'], outcome: 'VALID' })).toBe('READY'); expect(resultStateFor({ ...base, incidentStatuses: ['CONFIRMED_MAJOR'], outcome: 'INVALIDATED' })).toBe('INVALIDATED');
  });
  it('receipts bind attempt and answers; hash ignores key order', () => {
    const h = answersHash({ b: 1, a: [2, 3] }); expect(h).toBe(answersHash({ a: [2, 3], b: 1 })); expect(h).not.toBe(answersHash({ a: [2, 3], b: 2 }));
    const r = receiptCode('s', 'att', h); expect(r).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/); expect(r).toBe(receiptCode('s', 'att', h)); expect(r).not.toBe(receiptCode('s', 'att2', h)); expect(r).not.toBe(receiptCode('s2', 'att', h));
    expect(watermarkFor('att')).toMatch(/^[0-9A-F]{8}$/);
  });
  it('device pre-check', () => {
    const need = { camera: true, microphone: true, minBandwidthKbps: 500, singleScreen: true };
    expect(evaluateDevice({ browserSupported: true, camera: true, microphone: true, screens: 1, bandwidthKbps: 900 }, need).ok).toBe(true);
    expect(evaluateDevice({ browserSupported: false, camera: false, screens: 2, bandwidthKbps: 100 }, need).problems).toHaveLength(5);
  });
});

describe('proctoring provider adapter', () => {
  it('webhook signature: valid, tampered, wrong secret, stale', () => {
    const body = JSON.stringify({ eventId: 'e1' }), ts = Date.now(), sig = signWebhook('s', ts, body);
    expect(verifyWebhook('s', String(ts), sig, body)).toBe(true); expect(verifyWebhook('s', String(ts), sig, body + ' ')).toBe(false); expect(verifyWebhook('x', String(ts), sig, body)).toBe(false);
    expect(verifyWebhook('s', String(ts - 6 * 60_000), signWebhook('s', ts - 6 * 60_000, body), body)).toBe(false); expect(verifyWebhook(undefined, String(ts), sig, body)).toBe(false); expect(verifyWebhook('s', 'abc', sig, body)).toBe(false);
  });
  it('learner token is stable, opaque and not the identity', () => { const t = learnerToken('k', 'learner-uuid'); expect(t).toBe(learnerToken('k', 'learner-uuid')); expect(t).not.toContain('learner'); expect(t).not.toBe(learnerToken('k2', 'learner-uuid')); });
  it('mock provider satisfies the provider contract', async () => { expect(await proctorContract(new MockProctor())).toEqual([]); });
  it('http adapter satisfies the same contract against a stub vendor and sends an idempotency key + bearer auth', async () => {
    const ids = new Map<string, string>(); const seen: http.IncomingHttpHeaders[] = [];
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push(req.headers); res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/sessions') { const j = JSON.parse(b); if (!ids.has(j.attemptId)) ids.set(j.attemptId, `v-${ids.size + 1}`); return res.end(JSON.stringify({ sessionId: ids.get(j.attemptId), launchUrl: 'https://v/launch' })); }
      if (req.method === 'GET') return res.end(JSON.stringify({ final: false, incidents: [] })); res.statusCode = 204; res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try { const p = new HttpProctor(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'KEY'); expect(await proctorContract(p)).toEqual([]); expect(seen[0].authorization).toBe('Bearer KEY'); expect(seen[0]['idempotency-key']).toBe('attempt-contract-1'); }
    finally { srv.close(); }
  });
  it('contract test catches a non-idempotent provider', async () => {
    let n = 0; const bad: any = { name: 'bad', createSession: async () => ({ providerSessionId: `s${++n}` }), cancelSession: async () => undefined, fetchReport: async () => ({ final: false, incidents: [] }) };
    expect((await proctorContract(bad)).join()).toMatch(/idempotent/);
  });
});
