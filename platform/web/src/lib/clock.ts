/** The server's clock is the only one that matters for an exam deadline: the learner's laptop clock can be wrong or changed. */
export class ServerClock {
  private offset = 0;
  /** Call with every response that carries `serverTime`; uses the latest sample. */
  sync(serverTimeIso: string, localNow = Date.now()) { const t = Date.parse(serverTimeIso); if (Number.isFinite(t)) this.offset = t - localNow; }
  now(localNow = Date.now()) { return localNow + this.offset; }
  remainingMs(deadlineIso: string, localNow = Date.now()) { const d = Date.parse(deadlineIso) - this.now(localNow); return Number.isFinite(d) ? Math.max(0, d) : 0; }
}
export function fmtRemaining(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
