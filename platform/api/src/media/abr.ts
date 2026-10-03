import { posix } from 'path';

/** One rung of the adaptive-bitrate ladder. Bitrates are targets for H.264 Main + AAC-LC lesson video (talking head, slides, screen capture). */
export interface Rung { name: string; height: number; videoKbps: number; audioKbps: number }
export const LADDER: readonly Rung[] = [
  { name: '240p', height: 240, videoKbps: 350, audioKbps: 64 },
  { name: '360p', height: 360, videoKbps: 700, audioKbps: 96 },
  { name: '480p', height: 480, videoKbps: 1200, audioKbps: 128 },
  { name: '720p', height: 720, videoKbps: 2500, audioKbps: 128 },
  { name: '1080p', height: 1080, videoKbps: 4500, audioKbps: 192 },
];
export const SEGMENT_SEC = 6;
export const HLS_MIME = 'application/vnd.apple.mpegurl';

export interface Probe { width: number; height: number; durationSec: number; hasAudio: boolean; fps: number }
export interface Planned extends Rung { width: number; bandwidth: number }

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Rungs at or below the source height (never upscale). A source smaller than the lowest rung gets one rung at its own size. */
export function planLadder(src: Pick<Probe, 'width' | 'height'>): Planned[] {
  if (!(src.width > 0) || !(src.height > 0)) throw new Error('source has no video dimensions');
  const rungs = LADDER.filter((r) => r.height <= src.height);
  const use = rungs.length ? rungs : [{ ...LADDER[0], name: `${even(src.height)}p`, height: even(src.height) }];
  return use.map((r) => ({ ...r, width: even((src.width * r.height) / src.height), bandwidth: Math.round((r.videoKbps + r.audioKbps) * 1000 * 1.1) }));
}

/** ffmpeg arguments for one rung: closed GOP aligned to the segment length so every rung switches at the same instants. */
export function ffmpegArgs(input: string, outDir: string, r: Planned, p: Pick<Probe, 'fps' | 'hasAudio'>, segmentSec = SEGMENT_SEC): string[] {
  const gop = Math.max(1, Math.round((p.fps || 25) * segmentSec));
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-map', '0:v:0', ...(p.hasAudio ? ['-map', '0:a:0'] : []),
    '-vf', `scale=${r.width}:${r.height}:flags=bicubic,format=yuv420p`,
    '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast', '-crf', '23',
    '-maxrate', `${r.videoKbps}k`, '-bufsize', `${r.videoKbps * 2}k`,
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${segmentSec})`,
    ...(p.hasAudio ? ['-c:a', 'aac', '-b:a', `${r.audioKbps}k`, '-ac', '2', '-ar', '48000'] : ['-an']),
    '-f', 'hls', '-hls_time', String(segmentSec), '-hls_playlist_type', 'vod', '-hls_list_size', '0', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', posix.join(outDir, 'seg_%05d.ts'), posix.join(outDir, 'index.m3u8'),
  ];
}

export const probeArgs = (input: string) => ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', input];

export function parseProbe(json: string): Probe {
  const d = JSON.parse(json); const streams: any[] = d.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video'); if (!v) throw new Error('no video stream in source');
  const [n, den] = String(v.avg_frame_rate ?? v.r_frame_rate ?? '25/1').split('/').map(Number);
  const fps = den ? n / den : n;
  return { width: Number(v.width), height: Number(v.height), durationSec: Number(d.format?.duration ?? v.duration ?? 0), hasAudio: streams.some((s) => s.codec_type === 'audio'), fps: fps > 0 && fps < 121 ? fps : 25 };
}

/** Master playlist: lowest bandwidth first so a player with no estimate starts on the cheapest rung. */
export function masterPlaylist(rungs: Planned[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of [...rungs].sort((a, b) => a.bandwidth - b.bandwidth)) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${Math.round(r.bandwidth / 1.1)},RESOLUTION=${r.width}x${r.height},CODECS="avc1.4d401f,mp4a.40.2",NAME="${r.name}"`, `${r.name}/index.m3u8`);
  }
  return lines.join('\n') + '\n';
}

/** Rewrites every URI in a playlist (bare lines and URI="..." attributes). `resolve` returns the replacement or throws to refuse. */
export function rewritePlaylist(text: string, resolve: (uri: string) => string): string {
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (_m, u) => `URI="${resolve(u)}"`);
    return resolve(line.trim());
  }).join('\n');
}

/** Resolves a playlist-relative URI against its own key. Refuses anything that leaves the asset's folder or is not a plain relative path. */
export function childKey(parentKey: string, uri: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/') || uri.includes('\0') || uri.includes('?') || uri.includes('#')) throw new Error('unsafe playlist reference');
  const base = posix.dirname(parentKey); const joined = posix.normalize(posix.join(base, uri));
  const root = base.split('/').slice(0, 2).join('/'); // hls/<assetId>
  if (!(joined === root || joined.startsWith(root + '/'))) throw new Error('playlist reference escapes the asset');
  return joined;
}
export const segmentMime = (key: string) => (key.endsWith('.ts') ? 'video/mp2t' : key.endsWith('.m4s') || key.endsWith('.mp4') ? 'video/mp4' : key.endsWith('.aac') ? 'audio/aac' : 'application/octet-stream');
