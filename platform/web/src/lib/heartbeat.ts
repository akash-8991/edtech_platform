import type { LearningEvent } from '../api/types';

/** The server rejects a heartbeat claiming more than 30 s of viewing, so chunks are cut well under that. */
export const MAX_CHUNK_SEC = 20;
/** Playback advances about 1 s per timeupdate tick; a bigger forward jump is a seek, which is not watched time. */
export const MAX_NATURAL_STEP_SEC = 2.5;
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

/**
 * Turns the video element's time updates into verifiable "I really watched seconds a..b" events.
 * Seeks are never counted, pausing flushes, and chunks are bounded, mirroring the server's plausibility rules.
 */
export class HeartbeatTracker {
  private last: number | null = null;
  private from: number | null = null;
  private to = 0;
  constructor(private topicId: string, private assetId: string, private now: () => Date = () => new Date()) {}

  /** Call on every `timeupdate` while playing. Returns events ready to send (usually none). */
  tick(currentTime: number): LearningEvent[] {
    const out: LearningEvent[] = [];
    if (this.last !== null) {
      const d = currentTime - this.last;
      if (d > 0 && d <= MAX_NATURAL_STEP_SEC) {
        if (this.from === null) this.from = this.last;
        this.to = currentTime;
        while (this.to - (this.from ?? 0) >= MAX_CHUNK_SEC) { out.push(this.make(this.from!, this.from! + MAX_CHUNK_SEC)); this.from! += MAX_CHUNK_SEC; }
      } else { out.push(...this.flush()); } // seek or backwards jump: close the current range, start fresh at the new position
    }
    this.last = currentTime; return out;
  }
  /** Call on pause, end, tab hide or unload. */
  flush(): LearningEvent[] {
    const out: LearningEvent[] = [];
    if (this.from !== null && this.to - this.from >= 1) out.push(this.make(this.from, this.to));
    this.from = null; return out;
  }
  /** After a seek the next tick must not bridge the gap. */
  seeked(currentTime: number) { this.flush(); this.last = currentTime; }
  private make(from: number, to: number): LearningEvent {
    return { eventId: uuid(), topicId: this.topicId, type: 'VIDEO_HEARTBEAT', occurredAt: this.now().toISOString(), payload: { assetId: this.assetId, from: Math.round(from * 10) / 10, to: Math.round(to * 10) / 10 } };
  }
}

const QKEY = 'edtech.events';
/** Durable outbox: events survive offline periods and reloads, are re-sent in batches, and the server de-duplicates by eventId. */
export class EventOutbox {
  constructor(private send: (events: LearningEvent[]) => Promise<{ eventId: string; status: string }[]>, private store: Storage = localStorage) {}
  private read(): LearningEvent[] { try { return JSON.parse(this.store.getItem(QKEY) ?? '[]'); } catch { return []; } }
  private write(e: LearningEvent[]) { try { this.store.setItem(QKEY, JSON.stringify(e.slice(-500))); } catch { /* storage full: drop oldest silently */ } }
  get pending() { return this.read().length; }
  add(events: LearningEvent[]) { if (events.length) this.write([...this.read(), ...events]); }
  /** Sends everything pending. Returns the results; rejected events are dropped (resending cannot help), network failures keep them. */
  async flush(): Promise<{ eventId: string; status: string; reason?: string }[]> {
    const batch = this.read().slice(0, 100); if (!batch.length) return [];
    try {
      const results = await this.send(batch); const done = new Set(results.map((r) => r.eventId));
      this.write(this.read().filter((e) => !done.has(e.eventId))); return results;
    } catch { return []; }
  }
}
