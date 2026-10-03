import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'crypto';
import { packBundle } from '../../../api/src/media/abr'; // the SERVER's packer: the two sides must agree on the layout
import { OfflineLessons, licenseIdsOf } from '../lib/offline/lessons';
import { localPlaylist, masterFor, parseBundle, pickRungs, canPlayAdaptiveOffline } from '../lib/offline/bundle';
import { idbGet, resetDb } from '../lib/offline/idb';
import { DownloadButton } from '../components/DownloadButton';
import { LocaleProvider } from '../lib/i18n';

configure({ asyncUtilTimeout: 5000 });
const RUNGS = [{ name: '240p', width: 426, height: 240, bandwidth: 450_000, approxBytes: 2_000_000 }, { name: '360p', width: 640, height: 360, bandwidth: 900_000, approxBytes: 5_000_000 }, { name: '720p', width: 1280, height: 720, bandwidth: 2_900_000, approxBytes: 20_000_000 }];
const seg = (rung: string, i: number) => Buffer.from(`${rung}-segment-${i}-`.repeat(40));
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nseg_00000.ts\n#EXTINF:6.000,\nseg_00001.ts\n#EXT-X-ENDLIST\n';
let blobs: Map<string, Blob>; let n = 0;
beforeEach(async () => {
  resetDb(); await new Promise<void>((r) => { const q = indexedDB.deleteDatabase('edtech-offline'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); resetDb(); blobs = new Map(); n = 0;
  (URL as any).createObjectURL = (b: Blob) => { const u = `blob:t/${++n}`; blobs.set(u, b); return u; }; (URL as any).revokeObjectURL = (u: string) => { blobs.delete(u); };
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); (window as any).MediaSource = class {};
});
const readBlob = (b: Blob) => new Promise<ArrayBuffer>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.onerror = () => rej(r.error); r.readAsArrayBuffer(b); });
const text = async (u: string) => Buffer.from(await readBlob(blobs.get(u)!)).toString();

function server(over: { adaptive?: boolean; revoke?: string[] } = {}) {
  let pem = ''; const calls: string[] = []; const issued = new Map<string, string>(); // licenceId -> label
  const bundle = (rung: string) => packBundle(rung, PLAYLIST, [{ name: 'seg_00000.ts', data: seg(rung, 0) }, { name: 'seg_00001.ts', data: seg(rung, 1) }]);
  const encrypted = new Map<string, Buffer>(); const exp = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const fake = {
    baseUrl: '', async get<T>(path: string): Promise<T> { calls.push(`GET ${path}`);
      if (path.startsWith('/v1/topics/t1/playback')) return { streams: [], ...(over.adaptive === false ? {} : { adaptive: { rungs: RUNGS } }) } as T;
      if (path.startsWith('/v1/offline/licenses')) return [...issued.keys()].map((id) => ({ licenseId: id, assetId: 'asset1', expiresAt: exp, status: 'ACTIVE', valid: !over.revoke?.includes(issued.get(id)!) })) as T; throw new Error(path); },
    async post<T>(path: string, body?: any): Promise<T> { calls.push(`POST ${path} ${body?.label ?? ''}`.trim());
      if (path === '/v1/offline/devices') { pem = body.publicKeyPem; return {} as T; }
      const label: string = body.label ?? 'master'; const rung = label.replace('hls-', ''); const key = randomBytes(32), iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
      const plain = label.startsWith('hls-') ? bundle(rung) : Buffer.from('SINGLE-FILE'.repeat(100)); const data = Buffer.concat([c.update(plain), c.final()]); const id = `lic-${label}`; issued.set(id, label); encrypted.set(label, data);
      return { licenseId: id, assetId: 'asset1', label, expiresAt: exp, wrappedKey: publicEncrypt({ key: createPublicKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'),
        downloadUrl: `/v1/media/stream/${label}`, interactions: [], durationSec: 12, ...(label.startsWith('hls-') && { rung: RUNGS.find((r) => r.name === rung) }) } as T; },
  };
  const fetchImpl = vi.fn(async (u: any) => { const label = String(u).split('/').pop()!; const d = encrypted.get(label); return d ? new Response(d, { headers: { 'Content-Length': String(d.length) } }) : new Response(''); });
  return { fake, fetchImpl: fetchImpl as unknown as typeof fetch, calls, issued };
}
const arg = { topicId: 't1', entitlementId: 'e1', title: 'Sensors', language: 'en', userId: 'u1' };
const mgr = (s: ReturnType<typeof server>) => new OfflineLessons(s.fake as any, s.fetchImpl);

describe('bundle helpers', () => {
  it('parse what the server packs, and refuse anything else', () => {
    const b = packBundle('360p', PLAYLIST, [{ name: 'seg_00000.ts', data: Buffer.from('aaa') }, { name: 'seg_00001.ts', data: Buffer.from('bb') }]); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const p = parseBundle(ab); expect(p.header.rung).toBe('360p'); expect(p.segments.map((s) => s.length)).toEqual([3, 2]); expect(Buffer.from(ab.slice(p.segments[1].start, p.segments[1].start + 2)).toString()).toBe('bb');
    expect(() => parseBundle(new ArrayBuffer(4))).toThrow(); expect(() => parseBundle(ab.slice(0, ab.byteLength - 1))).toThrow(/mismatch/);
    expect(() => localPlaylist(PLAYLIST, () => undefined)).toThrow(/not in the bundle/);
    expect(localPlaylist(PLAYLIST, (s) => `blob:${s}`)).toContain('blob:seg_00001.ts');
  });
  it('picks rungs by quality, always keeps at least one, and builds a master with the cheapest first', () => {
    const names = (q: any, r = RUNGS) => pickRungs(r, q).map((x) => x.name); expect(names('small')).toEqual(['240p', '360p']); expect(names('standard')).toEqual(['360p', '720p']); expect(names('best')).toEqual(['240p', '360p', '720p']);
    expect(names('standard', [RUNGS[0]])).toEqual(['240p']); expect(names('small', [RUNGS[2]])).toEqual(['720p']); expect(pickRungs([], 'best')).toEqual([]);
    const m = masterFor([{ info: RUNGS[2], url: 'u720' }, { info: RUNGS[0], url: 'u240' }]); expect(m.indexOf('u240')).toBeLessThan(m.indexOf('u720')); expect(m).toContain('RESOLUTION=1280x720');
  });
  it('needs Media Source Extensions for adaptive playback', () => { delete (window as any).MediaSource; expect(canPlayAdaptiveOffline()).toBe(false); (window as any).ManagedMediaSource = class {}; expect(canPlayAdaptiveOffline()).toBe(true); delete (window as any).ManagedMediaSource; });
});

describe('saving and playing an adaptive lesson offline', () => {
  it('saves the chosen rungs as one licence each and opens as a ladder the player can adapt over', async () => {
    const s = server(); const m = mgr(s); const progress: number[] = [];
    const l = await m.download(arg, (f) => progress.push(f), { quality: 'standard' });
    expect(l.rungs!.map((r) => r.name)).toEqual(['360p', '720p']); expect(l.label).toBe('hls'); expect(s.calls.filter((c) => c.startsWith('POST /v1/offline/licenses'))).toEqual(['POST /v1/offline/licenses hls-360p', 'POST /v1/offline/licenses hls-720p']);
    expect(progress.at(-1)).toBe(1); expect(progress.every((x, i) => i === 0 || x >= progress[i - 1] - 1e-9)).toBe(true); expect(licenseIdsOf(l)).toEqual(['lic-hls-360p', 'lic-hls-720p']);
    expect((await idbGet<ArrayBuffer>('blobs', 'asset1|360p'))!.byteLength).toBeGreaterThan(500); expect(await idbGet('blobs', 'asset1')).toBeUndefined(); // ciphertext per rung, nothing under the single-file key
    const o = await m.open('asset1'); expect(o.playback.streams[0]).toMatchObject({ label: 'offline-hls', mime: 'application/vnd.apple.mpegurl' });
    const master = await text(o.playback.streams[0].url); expect(master).toContain('RESOLUTION=640x360'); expect(master).toContain('RESOLUTION=1280x720'); expect(master).not.toContain('426x240');
    const variants = master.split('\n').filter((x) => x.startsWith('blob:')); expect(variants).toHaveLength(2);
    for (const [i, v] of variants.entries()) { const pl = await text(v); const segs = pl.split('\n').filter((x) => x.startsWith('blob:')); expect(segs).toHaveLength(2); expect(pl).toContain('#EXT-X-ENDLIST'); expect(await text(segs[1])).toContain(`${i === 0 ? '360p' : '720p'}-segment-1-`); expect(blobs.get(segs[0])!.type).toBe('video/mp2t'); }
    o.release(); expect(blobs.size).toBe(0);
  });
  it('small saves the two lowest; best saves all; remove deletes every rung', async () => {
    const s = server(); const m = mgr(s); expect((await m.download(arg, undefined, { quality: 'small' })).rungs!.map((r) => r.name)).toEqual(['240p', '360p']);
    await m.remove('asset1'); expect(await idbGet('blobs', 'asset1|240p')).toBeUndefined(); expect(await m.has('asset1')).toBe(false);
    expect((await mgr(server()).download(arg, undefined, { quality: 'best' })).rungs).toHaveLength(3);
  });
  it('a lesson is only as valid as its weakest rung: one revoked licence removes all of it', async () => {
    const s = server(); await mgr(s).download(arg); const r = server({ revoke: ['hls-720p'] }); for (const [id, l] of s.issued) r.issued.set(id, l);
    expect(await mgr(r).sync('u1')).toEqual(['asset1']); expect(await idbGet('blobs', 'asset1|360p')).toBeUndefined();
  });
  it('falls back to the single file when the browser cannot play an adaptive lesson, or the lesson has no ladder', async () => {
    delete (window as any).MediaSource; const a = await mgr(server()).download(arg); expect(a.rungs).toBeUndefined(); expect(a.label).toBe('master');
    resetDb(); await new Promise<void>((r) => { const q = indexedDB.deleteDatabase('edtech-offline'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); resetDb(); (window as any).MediaSource = class {};
    const s2 = server({ adaptive: false }); const b = await mgr(s2).download(arg); expect(b.rungs).toBeUndefined(); const o = await mgr(s2).open('asset1'); expect(o.playback.streams[0].label).toBe('offline');
  });
  it('a damaged bundle is reported, not played', async () => {
    const s = server(); const m = mgr(s); await m.download(arg, undefined, { quality: 'small' }); const bad = new Uint8Array(await idbGet<ArrayBuffer>('blobs', 'asset1|240p') as ArrayBuffer); bad[40] ^= 0xff;
    const { idbPut } = await import('../lib/offline/idb'); await idbPut('blobs', 'asset1|240p', bad.buffer); await expect(m.open('asset1')).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('quality choice on the topic page', () => {
  it('offers three sizes with estimates, saves with the chosen one, and hides the choice for a lesson with no ladder', async () => {
    const s = server(); vi.stubGlobal('fetch', vi.fn(async (u: any, init?: any) => { const url = String(u); const method = init?.method ?? 'GET';
      if (url === '/v1/offline/devices') { await s.fake.post(url, JSON.parse(init.body)); return new Response('{}', { status: 201 }); } if (url === '/v1/offline/licenses' && method === 'POST') return new Response(JSON.stringify(await s.fake.post(url, JSON.parse(init.body))), { status: 201 });
      if (url.startsWith('/v1/topics/t1/playback')) return new Response(JSON.stringify(await s.fake.get(url))); return s.fetchImpl(u); }));
    const { api } = await import('../api/client'); api.setTokens({ accessToken: 'A', refreshToken: 'R' });
    const view = (rungs?: typeof RUNGS) => <MemoryRouter><LocaleProvider lang="en"><DownloadButton {...arg} assetId="asset1" adaptive={rungs} /></LocaleProvider></MemoryRouter>;
    const a = render(view(RUNGS)); const sel = await screen.findByLabelText('Quality for offline'); expect(screen.getByRole('option', { name: /Small \(up to 360p, about 7 MB\)/ })).toBeInTheDocument(); expect(screen.getByRole('option', { name: /Best \(all qualities, about 26 MB\)/ })).toBeInTheDocument();
    await userEvent.selectOptions(sel, 'small'); await userEvent.click(screen.getByRole('button', { name: 'Save for offline' })); await screen.findByText(/Adapts to your device: 240p, 360p/, {}, { timeout: 4000 }); a.unmount();
    render(view(undefined)); await screen.findByRole('button', { name: 'Save for offline' }); expect(screen.queryByLabelText('Quality for offline')).toBeNull();
  });
});
