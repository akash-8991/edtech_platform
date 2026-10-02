import type { SaveResult } from '../api/types';

export type SaveStatus = { state: 'idle' } | { state: 'saving' } | { state: 'saved'; at: number } | { state: 'retrying'; attempt: number } | { state: 'closed' };
export interface AutosaveOptions {
  attemptId: string;
  send: (body: { seq: number; answers: Record<string, unknown> }) => Promise<SaveResult>;
  onStatus?: (s: SaveStatus) => void;
  onClock?: (r: SaveResult) => void;
  store?: Storage; debounceMs?: number; retryMs?: number[]; initialSeq?: number; initialAnswers?: Record<string, unknown>;
}
/** An error that means saving can never succeed (time is up, session replaced). Stops retrying. */
export class FatalSaveError extends Error {}

/**
 * Autosave for an exam answer sheet:
 *  - answers are kept locally the instant they change (a backup survives a crash or reload) and sent debounced with an increasing `seq`;
 *  - the server applies a save only if seq is newer, so a duplicate or reordered request is harmless; when it answers `saved:false` we
 *    adopt its sequence number and RESEND, so an answer is never silently dropped;
 *  - failures retry with backoff while the learner keeps working; only a fatal error (time up / other window) stops it.
 */
export class Autosaver {
  private answers: Record<string, unknown>; private dirty = new Set<string>(); private seq: number; private timer?: ReturnType<typeof setTimeout>;
  private inflight = false; private again = false; private failures = 0; private closed = false;
  private o: Required<Pick<AutosaveOptions, 'debounceMs' | 'retryMs'>> & AutosaveOptions;
  constructor(opts: AutosaveOptions) {
    this.o = { debounceMs: 1500, retryMs: [2000, 5000, 10000], ...opts };
    this.answers = { ...(opts.initialAnswers ?? {}) }; this.seq = opts.initialSeq ?? 0;
    const b = this.readBackup();
    if (b) { for (const k of b.dirty) if (k in b.answers) { this.answers[k] = b.answers[k]; this.dirty.add(k); } } // unsent work from before a crash wins over the server copy
  }
  private key() { return `edtech.exam.${this.o.attemptId}`; }
  private store() { return this.o.store ?? localStorage; }
  private readBackup(): { answers: Record<string, unknown>; dirty: string[] } | null { try { return JSON.parse(this.store().getItem(this.key()) ?? 'null'); } catch { return null; } }
  private writeBackup() { try { this.store().setItem(this.key(), JSON.stringify({ answers: this.answers, dirty: [...this.dirty] })); } catch { /* storage full or blocked: server saves still work */ } }
  clearBackup() { try { this.store().removeItem(this.key()); } catch { /* ignore */ } }

  get current() { return { ...this.answers }; }
  get pending() { return this.dirty.size; }
  get lastSeq() { return this.seq; }
  /** Starts sending anything restored from a backup. */
  start() { if (this.dirty.size) this.schedule(0); }

  set(questionId: string, value: unknown) {
    if (this.closed) return; this.answers[questionId] = value; this.dirty.add(questionId); this.writeBackup(); this.schedule(this.o.debounceMs);
  }
  private schedule(ms: number) { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), ms); }
  stop() { this.closed = true; if (this.timer) clearTimeout(this.timer); }

  /** Sends pending answers now. Resolves when the queue is empty, the attempt is closed, or a retry has been scheduled. */
  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.inflight) { this.again = true; return; }
    if (!this.dirty.size) { this.o.onStatus?.({ state: 'saved', at: Date.now() }); return; }
    this.inflight = true; this.o.onStatus?.({ state: 'saving' });
    const keys = [...this.dirty]; const payload: Record<string, unknown> = {}; for (const k of keys) payload[k] = this.answers[k];
    try {
      const r = await this.o.send({ seq: this.seq + 1, answers: payload });
      this.o.onClock?.(r); this.seq = Math.max(this.seq, r.saveSeq);
      if (r.saved) { for (const k of keys) if (JSON.stringify(this.answers[k]) === JSON.stringify(payload[k])) this.dirty.delete(k); this.failures = 0; this.writeBackup(); this.o.onStatus?.({ state: 'saved', at: Date.now() }); }
      else this.again = true; // server was ahead of us: resend with its sequence number
    } catch (e) {
      if (e instanceof FatalSaveError) { this.closed = true; this.o.onStatus?.({ state: 'closed' }); this.inflight = false; return; }
      this.failures++; this.o.onStatus?.({ state: 'retrying', attempt: this.failures }); this.schedule(this.o.retryMs[Math.min(this.failures - 1, this.o.retryMs.length - 1)]); this.inflight = false; this.again = false; return;
    }
    this.inflight = false;
    if (this.again || this.dirty.size) { this.again = false; if (this.dirty.size) await this.flush(); }
  }
}
