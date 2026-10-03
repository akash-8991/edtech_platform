import { LADDER, childKey, ffmpegArgs, masterPlaylist, parseProbe, planLadder, rewritePlaylist, segmentMime } from './abr';

describe('ladder planning', () => {
  it('never upscales: a 720p source gets 240..720 only', () => {
    expect(planLadder({ width: 1280, height: 720 }).map((r) => r.name)).toEqual(['240p', '360p', '480p', '720p']);
    expect(planLadder({ width: 1920, height: 1080 })).toHaveLength(LADDER.length);
  });
  it('a source below the lowest rung gets one rung at its own size', () => {
    const r = planLadder({ width: 320, height: 180 }); expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ height: 180, width: 320 });
  });
  it('keeps aspect ratio with even widths (portrait and 4:3)', () => {
    expect(planLadder({ width: 1440, height: 1080 }).find((r) => r.name === '360p')!.width).toBe(480);
    for (const r of planLadder({ width: 1080, height: 1920 })) expect(r.width % 2).toBe(0);
  });
  it('rejects a source without dimensions', () => { expect(() => planLadder({ width: 0, height: 0 })).toThrow(); });
});

describe('ffmpeg arguments', () => {
  const r = planLadder({ width: 1280, height: 720 })[1];
  it('aligns keyframes to segment length so rungs switch at the same instants', () => {
    const a = ffmpegArgs('in.mp4', 'out', r, { fps: 25, hasAudio: true });
    expect(a[a.indexOf('-g') + 1]).toBe('150'); expect(a[a.indexOf('-keyint_min') + 1]).toBe('150'); expect(a).toContain('-sc_threshold');
    expect(a[a.indexOf('-hls_playlist_type') + 1]).toBe('vod'); expect(a.join(' ')).toContain('-b:a 96k');
  });
  it('drops audio mapping for a silent source and is shell-free (no joined command string)', () => {
    const a = ffmpegArgs('in.mp4', 'out', r, { fps: 30, hasAudio: false });
    expect(a).toContain('-an'); expect(a).not.toContain('0:a:0'); expect(a.every((x) => typeof x === 'string')).toBe(true);
  });
});

describe('probe parsing', () => {
  it('reads size, fps, duration and audio presence', () => {
    const p = parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '30000/1001' }, { codec_type: 'audio' }], format: { duration: '61.5' } }));
    expect(p).toMatchObject({ width: 1280, height: 720, durationSec: 61.5, hasAudio: true }); expect(p.fps).toBeCloseTo(29.97, 1);
  });
  it('falls back to 25 fps for a nonsense rate and fails on audio-only input', () => {
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 2, height: 2, avg_frame_rate: '0/0' }] })).fps).toBe(25);
    expect(() => parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio' }] }))).toThrow(/no video/);
  });
});

describe('playlists', () => {
  const rungs = planLadder({ width: 1920, height: 1080 });
  it('master lists rungs cheapest first with bandwidth, resolution and codecs', () => {
    const m = masterPlaylist([...rungs].reverse()); const lines = m.split('\n');
    expect(lines[0]).toBe('#EXTM3U'); expect(lines.indexOf('240p/index.m3u8')).toBeLessThan(lines.indexOf('1080p/index.m3u8'));
    expect(m).toMatch(/BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+,RESOLUTION=1920x1080,CODECS=/);
  });
  it('rewrites bare URIs and URI="..." attributes, leaving tags alone', () => {
    const out = rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg_00001.ts\n', (u) => `/s/${u}`);
    expect(out).toBe('#EXTM3U\n#EXT-X-MAP:URI="/s/init.mp4"\n#EXTINF:6,\n/s/seg_00001.ts\n');
  });
  it('childKey stays inside the asset folder and refuses absolute, scheme, query and traversal references', () => {
    expect(childKey('hls/a1/master.m3u8', '360p/index.m3u8')).toBe('hls/a1/360p/index.m3u8');
    expect(childKey('hls/a1/360p/index.m3u8', 'seg_00001.ts')).toBe('hls/a1/360p/seg_00001.ts');
    expect(childKey('hls/a1/360p/index.m3u8', '../720p/index.m3u8')).toBe('hls/a1/720p/index.m3u8');
    for (const bad of ['../../a2/master.m3u8', '/etc/passwd', 'http://evil/x.ts', 'seg.ts?x=1', '../../../secret', 'seg\0.ts']) expect(() => childKey('hls/a1/360p/index.m3u8', bad)).toThrow();
  });
  it('segment types', () => { expect(segmentMime('x.ts')).toBe('video/mp2t'); expect(segmentMime('x.m4s')).toBe('video/mp4'); expect(segmentMime('x.bin')).toBe('application/octet-stream'); });
});
