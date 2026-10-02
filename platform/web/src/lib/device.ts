import type { DeviceReport } from '../api/types';

export interface DeviceEnv {
  nav: { mediaDevices?: { getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream> }; connection?: { downlink?: number } };
  screen: { isExtended?: boolean };
  hasFetch: boolean; hasCrypto: boolean;
  measureBandwidthKbps?: () => Promise<number | null>;
}
const stop = (s?: MediaStream) => s?.getTracks().forEach((t) => t.stop());
/** A permission prompt nobody answers never settles: give each probe a deadline and treat silence as "not available". */
const within = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> => new Promise((resolve) => { const t = setTimeout(() => resolve(fallback), ms); p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); }); });
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * Builds the device report the server evaluates against the exam's policy. Camera/microphone are probed only when the exam needs them
 * (asking for permission otherwise would be intrusive), and every probe stream is stopped immediately.
 */
export async function collectDeviceReport(needs: { camera: boolean; microphone: boolean }, env: DeviceEnv = browserEnv()): Promise<DeviceReport> {
  const probe = (c: MediaStreamConstraints) => within(env.nav.mediaDevices!.getUserMedia!(c).then((s) => { stop(s); return true; }), PROBE_TIMEOUT_MS, false);
  const canMedia = typeof env.nav.mediaDevices?.getUserMedia === 'function';
  // probes run in parallel so the worst case is one timeout, not three
  const [camera, microphone, measured] = await Promise.all([
    needs.camera ? (canMedia ? probe({ video: true }) : Promise.resolve(false)) : Promise.resolve(canMedia),
    needs.microphone ? (canMedia ? probe({ audio: true }) : Promise.resolve(false)) : Promise.resolve(canMedia),
    env.measureBandwidthKbps ? within(env.measureBandwidthKbps(), PROBE_TIMEOUT_MS, null) : Promise.resolve(null),
  ]);
  const bw = measured ? Math.round(measured) : env.nav.connection?.downlink ? Math.round(env.nav.connection.downlink * 1000) : 0;
  return { browserSupported: env.hasFetch && env.hasCrypto, camera, microphone, screens: env.screen.isExtended ? 2 : 1, bandwidthKbps: bw };
}

/** Times a download of this app's own script (same origin, cache-busted). A coarse estimate, deliberately conservative. */
export async function measureBandwidthKbps(url?: string): Promise<number | null> {
  const src = url ?? (document.querySelector('script[type=module][src]') as HTMLScriptElement | null)?.src; if (!src) return null;
  const t0 = performance.now(); const r = await fetch(`${src}${src.includes('?') ? '&' : '?'}bw=${Date.now()}`, { cache: 'no-store' }); const bytes = (await r.arrayBuffer()).byteLength;
  const ms = performance.now() - t0; return ms > 0 && bytes > 20_000 ? (bytes * 8) / ms : null; // bits per ms == kbps
}
export const browserEnv = (): DeviceEnv => ({ nav: navigator as any, screen: window.screen as any, hasFetch: typeof fetch === 'function', hasCrypto: !!globalThis.crypto?.subtle, measureBandwidthKbps: () => measureBandwidthKbps() });
