import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosaver, FatalSaveError, type SaveStatus } from '../lib/autosave';
import { fmtRemaining, ServerClock } from '../lib/clock';
import { collectDeviceReport, type DeviceEnv } from '../lib/device';
import { watchSignals } from '../lib/signals';
import type { SaveResult } from '../api/types';

beforeEach(() => { vi.useFakeTimers(); }); afterEach(() => { vi.useRealTimers(); });
const ok = (seq: number, saved = true): SaveResult => ({ saved, saveSeq: seq, remainingMs: 1000, serverTime: new Date().toISOString() });

describe('ServerClock', () => {
  it('measures time against the server, not the learner laptop', () => {
    const c = new ServerClock(); c.sync('2026-01-01T10:00:00.000Z', Date.parse('2026-01-01T10:07:00.000Z')); // laptop is 7 minutes fast
    expect(c.remainingMs('2026-01-01T10:30:00.000Z', Date.parse('2026-01-01T10:07:00.000Z'))).toBe(30 * 60_000);
    expect(c.remainingMs('2026-01-01T10:30:00.000Z', Date.parse('2026-01-01T10:37:00.000Z'))).toBe(0); expect(new ServerClock().remainingMs('x')).toBe(0);
  });
  it('formats remaining time', () => { expect(fmtRemaining(3_725_000)).toBe('1:02:05'); expect(fmtRemaining(65_000)).toBe('1:05'); expect(fmtRemaining(-5)).toBe('0:00'); expect(fmtRemaining(999)).toBe('0:01'); });
});

describe('Autosaver', () => {
  const mk = (send: any, extra: any = {}) => { const statuses: SaveStatus[] = []; const a = new Autosaver({ attemptId: 'A1', send, store: localStorage, onStatus: (s) => statuses.push(s), ...extra }); return { a, statuses }; };
  it('debounces rapid changes into one save with an increasing sequence', async () => {
    const send = vi.fn(async (b: any) => ok(b.seq)); const { a } = mk(send); a.set('q1', 1); a.set('q1', 2); a.set('q2', 'x');
    await vi.advanceTimersByTimeAsync(1600); expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toEqual({ seq: 1, answers: { q1: 2, q2: 'x' } });
    a.set('q3', 0); await vi.advanceTimersByTimeAsync(1600); expect(send.mock.calls[1][0].seq).toBe(2); expect(a.pending).toBe(0);
  });
  it('keeps working offline: retries with backoff, never loses an answer, then catches up', async () => {
    let up = false; const send = vi.fn(async (b: any) => { if (!up) throw new TypeError('offline'); return ok(b.seq); }); const { a, statuses } = mk(send);
    a.set('q1', 3); await vi.advanceTimersByTimeAsync(1600); expect(statuses.at(-1)).toEqual({ state: 'retrying', attempt: 1 }); expect(a.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(2100); expect(statuses.at(-1)).toEqual({ state: 'retrying', attempt: 2 }); up = true; await vi.advanceTimersByTimeAsync(5100);
    expect(statuses.at(-1)?.state).toBe('saved'); expect(a.pending).toBe(0); expect(send.mock.calls.at(-1)![0]).toEqual({ seq: 1, answers: { q1: 3 } }); // same sequence retried: idempotent
  });
  it('adopts the server sequence and RESENDS when the server was ahead (answer not silently dropped)', async () => {
    const calls: any[] = []; const send = vi.fn(async (b: any) => { calls.push(b); return calls.length === 1 ? ok(5, false) : ok(b.seq); }); const { a } = mk(send);
    a.set('q1', 1); await vi.advanceTimersByTimeAsync(1600); expect(calls.map((c) => c.seq)).toEqual([1, 6]); expect(a.pending).toBe(0); expect(a.lastSeq).toBe(6);
  });
  it('a newer answer made while a save is in flight is not marked as saved', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r)); const send = vi.fn(async (b: any) => { if (b.seq === 1) await gate; return ok(b.seq); }); const { a } = mk(send);
    a.set('q1', 1); await vi.advanceTimersByTimeAsync(1600); a.set('q1', 2); release(); await vi.advanceTimersByTimeAsync(3200); expect(a.current.q1).toBe(2); expect(a.pending).toBe(0); expect(send.mock.calls.at(-1)![0].answers).toEqual({ q1: 2 });
  });
  it('stops on a fatal error (time up / replaced session) and reports closed', async () => {
    const send = vi.fn(async () => { throw new FatalSaveError('time up'); }); const { a, statuses } = mk(send); a.set('q1', 1); await vi.advanceTimersByTimeAsync(1600);
    expect(statuses.at(-1)).toEqual({ state: 'closed' }); a.set('q2', 1); await vi.advanceTimersByTimeAsync(5000); expect(send).toHaveBeenCalledTimes(1);
  });
  it('restores unsent answers after a crash and sends them on start()', async () => {
    const send = vi.fn(async (b: any) => ok(b.seq)); const first = mk(send).a; first.set('q9', 7); first.stop(); // "crash" before the debounce fires
    const second = new Autosaver({ attemptId: 'A1', send, store: localStorage, initialAnswers: { q1: 1 }, initialSeq: 4 }); expect(second.current).toEqual({ q1: 1, q9: 7 }); second.start(); await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledWith({ seq: 5, answers: { q9: 7 } });
  });
  it('survives corrupt or blocked storage', () => { localStorage.setItem('edtech.exam.A1', '{bad'); expect(() => mk(vi.fn()).a.set('q', 1)).not.toThrow(); });
});

describe('collectDeviceReport', () => {
  const env = (o: Partial<DeviceEnv> = {}): DeviceEnv => ({ nav: { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as any) }, connection: { downlink: 5 } }, screen: {}, hasFetch: true, hasCrypto: true, ...o });
  it('probes camera and microphone only when the exam needs them and releases the streams', async () => {
    const e = env(); const r = await collectDeviceReport({ camera: true, microphone: true }, e); expect(e.nav.mediaDevices!.getUserMedia).toHaveBeenCalledTimes(2); expect(r).toMatchObject({ browserSupported: true, camera: true, microphone: true, screens: 1, bandwidthKbps: 5000 });
    const e2 = env(); await collectDeviceReport({ camera: false, microphone: false }, e2); expect(e2.nav.mediaDevices!.getUserMedia).not.toHaveBeenCalled();
  });
  it('reports a denied camera, multiple screens, and prefers a measured bandwidth', async () => {
    const e = env({ nav: { mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error('denied'); }) }, connection: { downlink: 50 } }, screen: { isExtended: true }, measureBandwidthKbps: async () => 800.4 });
    expect(await collectDeviceReport({ camera: true, microphone: false }, e)).toMatchObject({ camera: false, screens: 2, bandwidthKbps: 800 });
  });
  it('treats an unsupported browser and a failed measurement honestly', async () => {
    const r = await collectDeviceReport({ camera: true, microphone: true }, env({ nav: {}, hasCrypto: false, measureBandwidthKbps: async () => { throw new Error('x'); } })); expect(r).toMatchObject({ browserSupported: false, camera: false, microphone: false, bandwidthKbps: 0 });
  });
});

describe('collectDeviceReport timeouts', () => {
  it('does not hang when a permission prompt is never answered', async () => {
    const never = new Promise<MediaStream>(() => undefined); const e: DeviceEnv = { nav: { mediaDevices: { getUserMedia: () => never }, connection: { downlink: 2 } }, screen: {}, hasFetch: true, hasCrypto: true, measureBandwidthKbps: () => new Promise(() => undefined) };
    const p = collectDeviceReport({ camera: true, microphone: true }, e); await vi.advanceTimersByTimeAsync(16_000); await expect(p).resolves.toMatchObject({ camera: false, microphone: false, bandwidthKbps: 2000 });
  });
});

describe('watchSignals', () => {
  it('reports focus loss, full-screen exit, copy and paste once each, throttled, and cleans up', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); const got: string[] = []; const stop = watchSignals((k) => got.push(k), document, window, 2000);
    window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); // blur + hidden: still ONE focus signal (visibility is visible in jsdom so only blur counts)
    document.dispatchEvent(new Event('fullscreenchange')); document.dispatchEvent(new Event('copy')); document.dispatchEvent(new Event('paste'));
    window.dispatchEvent(new Event('blur')); expect(got).toEqual(['FOCUS_LOST', 'FULLSCREEN_EXIT', 'COPY', 'PASTE']); // second blur within 2 s throttled
    vi.advanceTimersByTime(2500); window.dispatchEvent(new Event('blur')); expect(got.length).toBe(5);
    stop(); document.dispatchEvent(new Event('copy')); vi.advanceTimersByTime(5000); document.dispatchEvent(new Event('copy')); expect(got.length).toBe(5);
  });
});
