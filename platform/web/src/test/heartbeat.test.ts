import { describe, expect, it, vi } from 'vitest';
import { EventOutbox, HeartbeatTracker, MAX_CHUNK_SEC } from '../lib/heartbeat';
import type { LearningEvent } from '../api/types';

const play = (t: HeartbeatTracker, from: number, to: number, step = 1) => { const out: LearningEvent[] = []; for (let s = from; s <= to; s += step) out.push(...t.tick(s)); return out; };
const range = (e: LearningEvent) => [e.payload.from as number, e.payload.to as number];

describe('HeartbeatTracker', () => {
  it('turns continuous playback into bounded, gap-free chunks the server will accept (<= 30 s)', () => {
    const t = new HeartbeatTracker('T', 'A'); const ev = [...play(t, 0, 65), ...t.flush()];
    expect(ev.every((e) => e.type === 'VIDEO_HEARTBEAT' && (e.payload.to as number) - (e.payload.from as number) <= MAX_CHUNK_SEC && (e.payload.to as number) - (e.payload.from as number) <= 30)).toBe(true);
    expect(ev.map(range)).toEqual([[0, 20], [20, 40], [40, 60], [60, 65]]);
    expect(new Set(ev.map((e) => e.eventId)).size).toBe(ev.length); // unique ids: the server de-duplicates replays by id
  });
  it('never counts a seek as watched time', () => {
    const t = new HeartbeatTracker('T', 'A'); const ev = [...play(t, 0, 10), ...play(t, 90, 100), ...t.flush()];
    const watched = ev.reduce((s, e) => s + (e.payload.to as number) - (e.payload.from as number), 0); expect(watched).toBeLessThanOrEqual(20); expect(ev.some((e) => (e.payload.from as number) < 90 && (e.payload.to as number) > 11)).toBe(false);
  });
  it('seeked() closes the range so the next tick cannot bridge the jump', () => {
    const t = new HeartbeatTracker('T', 'A'); play(t, 0, 5); const before = t.flush(); t.seeked(50); const after = [...play(t, 51, 55), ...t.flush()];
    expect(before.map(range)).toEqual([[0, 5]]); expect(after.map(range)).toEqual([[50, 55]]);
  });
  it('ignores backwards movement and sub-second noise', () => {
    const t = new HeartbeatTracker('T', 'A'); play(t, 10, 12); t.tick(5); expect(t.flush()).toEqual([]); const t2 = new HeartbeatTracker('T', 'A'); t2.tick(0); t2.tick(0.5); expect(t2.flush()).toEqual([]);
  });
  it('uses the injected clock for occurredAt', () => {
    const t = new HeartbeatTracker('T', 'A', () => new Date('2026-01-01T00:00:00Z')); const ev = [...play(t, 0, 3), ...t.flush()]; expect(ev[0].occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('EventOutbox', () => {
  const ev = (id: string): LearningEvent => ({ eventId: id, topicId: 'T', type: 'VIDEO_HEARTBEAT', occurredAt: 'x', payload: {} });
  it('persists events, removes what the server answered, keeps them on network failure', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async (es: LearningEvent[]) => es.map((e) => ({ eventId: e.eventId, status: 'accepted' })));
    const o = new EventOutbox(send); o.add([ev('1'), ev('2')]);
    expect(await o.flush()).toEqual([]); expect(o.pending).toBe(2); // offline: nothing lost
    expect(new EventOutbox(send).pending).toBe(2); // survives a reload
    expect((await o.flush()).length).toBe(2); expect(o.pending).toBe(0);
  });
  it('drops events the server rejected (resending cannot help) and treats duplicates as done', async () => {
    const o = new EventOutbox(async (es) => es.map((e) => ({ eventId: e.eventId, status: e.eventId === 'bad' ? 'rejected' : 'duplicate' }))); o.add([ev('bad'), ev('dup')]); await o.flush(); expect(o.pending).toBe(0);
  });
  it('caps the stored backlog and sends in batches', async () => {
    const sizes: number[] = []; const o = new EventOutbox(async (es) => { sizes.push(es.length); return es.map((e) => ({ eventId: e.eventId, status: 'accepted' })); });
    o.add(Array.from({ length: 700 }, (_, i) => ev(String(i)))); expect(o.pending).toBe(500); await o.flush(); expect(sizes[0]).toBe(100); expect(o.pending).toBe(400);
  });
  it('survives corrupt storage', () => { localStorage.setItem('edtech.events', '{not json'); expect(new EventOutbox(async () => []).pending).toBe(0); });
});
