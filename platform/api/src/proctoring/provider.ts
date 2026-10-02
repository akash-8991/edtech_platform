import { external, traceHeaders } from '../platform/trace';
import { createHmac, timingSafeEqual } from 'crypto';

export interface ProctorSessionReq { attemptId: string; examCode: string; learnerToken: string; mode: 'REMOTE' | 'CENTRE'; startsAt: Date; endsAt: Date; consent: true; checks: { identity: boolean; device: boolean } }
export interface ProctorSession { providerSessionId: string; launchUrl?: string }
export interface ProctorReport { final: boolean; incidents: { eventId: string; type: string; severity: string; occurredAt: string; evidenceUrl?: string; evidenceExpiresAt?: string }[] }
/**
 * Provider adapter (TRD §6 Proctoring). The provider never receives the learner's identity: only a tokenised reference and a consent
 * flag; it reports back by signed webhook (see verifyWebhook) and/or a report fetch. Vendor choice is open ([PROCTORING_POLICY]).
 */
export interface ProctorProvider {
  readonly name: string;
  createSession(r: ProctorSessionReq): Promise<ProctorSession>; // idempotent per attemptId
  cancelSession(providerSessionId: string): Promise<void>;
  fetchReport(providerSessionId: string): Promise<ProctorReport>;
  /** Data-subject erasure: ask the vendor to delete everything it holds for this tokenised learner. Optional in the contract. */
  eraseLearner?(learnerToken: string): Promise<void>;
}
export const PROCTOR = Symbol('PROCTOR');

export const learnerToken = (secret: string, learnerId: string) => createHmac('sha256', secret).update(`proctor:${learnerId}`).digest('hex').slice(0, 32);

/** Signed server-to-server webhook: HMAC-SHA256 over `${timestamp}.${rawBody}`, 5-minute replay window. */
export function verifyWebhook(secret: string | undefined, timestamp: string | undefined, signature: string | undefined, rawBody: string, now = Date.now()): boolean {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 5 * 60_000) return false;
  const exp = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest(); const got = Buffer.from(signature, 'hex');
  return got.length === exp.length && timingSafeEqual(got, exp);
}
export const signWebhook = (secret: string, timestamp: number, rawBody: string) => createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

/** In-process provider for development and tests. */
export class MockProctor implements ProctorProvider {
  readonly name = 'mock'; sessions = new Map<string, { req: ProctorSessionReq; cancelled: boolean }>(); byAttempt = new Map<string, string>(); reports = new Map<string, ProctorReport>();
  async createSession(r: ProctorSessionReq) {
    const existing = this.byAttempt.get(r.attemptId); if (existing) return { providerSessionId: existing, launchUrl: `https://mock.proctor/launch/${existing}` };
    const id = `mock-${this.sessions.size + 1}-${r.attemptId.slice(0, 6)}`; this.sessions.set(id, { req: r, cancelled: false }); this.byAttempt.set(r.attemptId, id);
    return { providerSessionId: id, launchUrl: `https://mock.proctor/launch/${id}` };
  }
  async cancelSession(id: string) { const s = this.sessions.get(id); if (s) s.cancelled = true; }
  async fetchReport(id: string) { return this.reports.get(id) ?? { final: false, incidents: [] }; }
  erased: string[] = [];
  async eraseLearner(token: string) { this.erased.push(token); }
}

/** Generic REST adapter. Contract: POST /sessions, DELETE /sessions/:id, GET /sessions/:id/report (see docs/proctor-provider-contract.md). */
export class HttpProctor implements ProctorProvider {
  readonly name = 'http';
  constructor(private baseURL: string, private apiKey: string) {}
  private async call(method: string, path: string, body?: unknown) {
    const res = await external('proctor', `${method} /${path.split('/')[1] ?? ''}`, () => fetch(`${this.baseURL}${path}`, { method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': (body as any)?.attemptId ?? '', ...traceHeaders() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) }));
    if (!res.ok) throw new Error(`proctor provider HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  async createSession(r: ProctorSessionReq) { const j: any = await this.call('POST', '/sessions', { ...r, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString() }); if (!j?.sessionId) throw new Error('provider returned no sessionId'); return { providerSessionId: String(j.sessionId), launchUrl: j.launchUrl }; }
  async cancelSession(id: string) { await this.call('DELETE', `/sessions/${encodeURIComponent(id)}`); }
  async eraseLearner(token: string) { await this.call('DELETE', `/learners/${encodeURIComponent(token)}`); }
  async fetchReport(id: string) { const j: any = await this.call('GET', `/sessions/${encodeURIComponent(id)}/report`); return { final: !!j.final, incidents: Array.isArray(j.incidents) ? j.incidents : [] }; }
}

export function buildProctor(env = process.env): ProctorProvider {
  return env.PROCTOR_BASE_URL && env.PROCTOR_API_KEY ? new HttpProctor(env.PROCTOR_BASE_URL, env.PROCTOR_API_KEY) : new MockProctor();
}

/** Provider contract test (TRD: contract tests for proctoring providers). Run it against any implementation before go-live. */
export async function proctorContract(p: ProctorProvider): Promise<string[]> {
  const fails: string[] = []; const req: ProctorSessionReq = { attemptId: 'attempt-contract-1', examCode: 'FINAL', learnerToken: 'tok_abc', mode: 'REMOTE', startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000), consent: true, checks: { identity: true, device: true } };
  const a = await p.createSession(req);
  if (!a.providerSessionId) fails.push('createSession must return providerSessionId');
  const b = await p.createSession(req);
  if (b.providerSessionId !== a.providerSessionId) fails.push('createSession must be idempotent per attemptId');
  const rep = await p.fetchReport(a.providerSessionId);
  if (typeof rep.final !== 'boolean' || !Array.isArray(rep.incidents)) fails.push('fetchReport must return {final:boolean, incidents:[]}');
  await p.cancelSession(a.providerSessionId).catch(() => fails.push('cancelSession must not throw for a live session'));
  return fails;
}
