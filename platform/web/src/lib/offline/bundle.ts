/**
 * One rung of an adaptive lesson as the server packs it for offline use (see api/src/media/abr.ts, the two must agree):
 * "EDHLS1" | u32 header length (big endian) | header JSON {v, rung, playlist, segments:[{name,length}]} | segment bytes in order.
 */
export interface BundleHeader { v: 1; rung: string; playlist: string; segments: { name: string; length: number }[] }
const MAGIC = 'EDHLS1';

export function parseBundle(buf: ArrayBuffer): { header: BundleHeader; segments: { name: string; start: number; length: number }[] } {
  const u = new Uint8Array(buf); if (u.length < 10 || new TextDecoder().decode(u.subarray(0, 6)) !== MAGIC) throw new Error('not a lesson bundle');
  const n = new DataView(buf).getUint32(6); const header = JSON.parse(new TextDecoder().decode(u.subarray(10, 10 + n))) as BundleHeader;
  if (header.v !== 1 || !Array.isArray(header.segments)) throw new Error('unsupported bundle');
  let at = 10 + n; const segments = header.segments.map((s) => { const x = { name: s.name, start: at, length: s.length }; at += s.length; return x; });
  if (at !== u.length) throw new Error('bundle length mismatch'); return { header, segments };
}

/** Rewrites each segment line of a media playlist to a local URL; refuses a line that is not one of the bundle's own segments. */
export function localPlaylist(playlist: string, urlFor: (segmentName: string) => string | undefined): string {
  return playlist.split(/\r?\n/).map((l) => { const t = l.trim(); if (!t || t.startsWith('#')) return l; const u = urlFor(t); if (!u) throw new Error('playlist names a segment that is not in the bundle'); return u; }).join('\n');
}

export interface RungInfo { name: string; width: number; height: number; bandwidth: number }
export const masterFor = (rungs: { info: RungInfo; url: string }[]) => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS', ...[...rungs].sort((a, b) => a.info.bandwidth - b.info.bandwidth).flatMap((r) => [`#EXT-X-STREAM-INF:BANDWIDTH=${r.info.bandwidth},RESOLUTION=${r.info.width}x${r.info.height},CODECS="avc1.4d401f,mp4a.40.2"`, r.url])].join('\n') + '\n';

export type Quality = 'small' | 'standard' | 'best';
/** Which rungs to keep for a quality choice: small = up to 360p, standard = 360p to 720p, best = all. Always at least one. */
export function pickRungs<T extends { height: number }>(rungs: T[], q: Quality): T[] {
  const sorted = [...rungs].sort((a, b) => a.height - b.height); if (!sorted.length) return [];
  const pick = q === 'small' ? sorted.filter((r) => r.height <= 360) : q === 'standard' ? sorted.filter((r) => r.height >= 360 && r.height <= 720) : sorted;
  return pick.length ? pick : q === 'best' ? sorted : [sorted[0]];
}
/** Adaptive playback needs Media Source Extensions (hls.js); older iPhones lack them and use the single file instead. */
export const canPlayAdaptiveOffline = () => typeof window !== 'undefined' && !!((window as any).MediaSource || (window as any).ManagedMediaSource);
