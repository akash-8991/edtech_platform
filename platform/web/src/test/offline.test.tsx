import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'crypto';
import { api } from '../api/client';
import { OfflineLessons, OfflineError } from '../lib/offline/lessons';
import { cachedGet, cacheable, clearCache, setCacheUser } from '../lib/offline/cache';
import { idbAll, idbGet, idbPut, resetDb } from '../lib/offline/idb';
import { deviceKeys } from '../lib/offline/crypto';
import Downloads from '../pages/Downloads';
import OfflineLesson from '../pages/OfflineLesson';
import { DownloadButton } from '../components/DownloadButton';
import { AuthProvider } from '../auth';
import { LocaleProvider } from '../lib/i18n';

configure({ asyncUtilTimeout: 5000 }); // IndexedDB and key generation are slow when the whole suite runs at once
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const VIDEO = Buffer.from('FAKE-MP4-BYTES-'.repeat(200)); // 3000 bytes
let blobs: Map<string, Blob>; let n = 0;
beforeEach(async () => {
  resetDb(); await new Promise<void>((r) => { const q = indexedDB.deleteDatabase('edtech-offline'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); resetDb();
  api.clear(); api.setTokens({ accessToken: 'AT', refreshToken: 'RT' }); blobs = new Map(); n = 0; setCacheUser('u1');
  (URL as any).createObjectURL = (b: Blob) => { const u = `blob:test/${++n}`; blobs.set(u, b); return u; }; (URL as any).revokeObjectURL = (u: string) => { blobs.delete(u); };
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

/** A stand-in for the server's offline module: AES-256-GCM per lesson, key wrapped (RSA-OAEP, SHA-256) for the registering device. */
function server(over: { licenses?: any; expiresAt?: string; failLicense?: number; status?: 'valid' | 'revoked' } = {}) {
  let pem = ''; const calls: string[] = []; const key = randomBytes(32), iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(VIDEO), c.final()]); const tag = c.getAuthTag();
  const fake = {
    baseUrl: '', async get<T>(path: string): Promise<T> { calls.push(`GET ${path}`);
      if (path.startsWith('/v1/topics/t1/playback')) return { streams: [{ label: 'captions', mime: 'text/vtt', url: '/v1/media/stream/cap' }, { label: 'transcript', mime: 'text/plain', url: '/v1/media/stream/tr' }] } as T;
      if (path.startsWith('/v1/offline/licenses')) return [{ licenseId: 'lic1', assetId: 'asset1', expiresAt: over.expiresAt ?? future(), status: over.status === 'revoked' ? 'REVOKED' : 'ACTIVE', valid: over.status !== 'revoked' }] as T; throw new Error(path); },
    async post<T>(path: string, body?: any): Promise<T> { calls.push(`POST ${path}`);
      if (path === '/v1/offline/devices') { pem = body.publicKeyPem; return {} as T; }
      if (over.failLicense) throw Object.assign(new Error('x'), { status: over.failLicense });
      const wrapped = publicEncrypt({ key: createPublicKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64');
      return { licenseId: 'lic1', assetId: 'asset1', label: '360p', expiresAt: over.expiresAt ?? future(), wrappedKey: wrapped, iv: iv.toString('base64'), tag: tag.toString('base64'), cipher: 'AES-256-GCM', downloadUrl: '/v1/media/stream/enc', interactions: [{ id: 'ix1', atSec: 5, kind: 'pause_quiz', prompt: 'q?', options: ['a', 'b'] }], durationSec: 90 } as T; },
  };
  const fetchImpl = vi.fn(async (u: any) => { const url = String(u); calls.push(`FETCH ${url}`); if (url.endsWith('/enc')) return new Response(data, { headers: { 'Content-Length': String(data.length) } }); if (url.endsWith('/cap')) return new Response('WEBVTT\n\n00:00.000 --> 00:02.000\nHello'); return new Response('Transcript text'); });
  return { fake, fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}
const readBlob = (b: Blob) => new Promise<ArrayBuffer>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as ArrayBuffer); r.onerror = () => reject(r.error); r.readAsArrayBuffer(b); });
const future = (days = 7) => new Date(Date.now() + days * 86_400_000).toISOString();
const arg = { topicId: 't1', entitlementId: 'e1', title: 'Sensors', language: 'en', userId: 'u1' };
const mgr = (s: ReturnType<typeof server>, now = Date.now) => new OfflineLessons(s.fake as any, s.fetchImpl, now);

describe('device keys', () => {
  it('are made once, kept, and the private key can never be exported', async () => {
    const a = await deviceKeys(); const b = await deviceKeys(); expect(b.deviceId).toBe(a.deviceId); expect(a.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    await expect(crypto.subtle.exportKey('pkcs8', a.privateKey)).rejects.toThrow(); expect(a.privateKey.extractable).toBe(false);
  });
});

describe('downloading and playing a lesson offline', () => {
  it('stores the ciphertext, never the plain video, and plays it back byte for byte', async () => {
    const s = server(); const m = mgr(s); const seen: number[] = [];
    const l = await m.download(arg, (f) => seen.push(f));
    expect(l).toMatchObject({ assetId: 'asset1', title: 'Sensors', size: VIDEO.length, captions: expect.stringContaining('WEBVTT') }); expect(seen.at(-1)).toBe(1);
    const stored = Buffer.from((await idbGet<ArrayBuffer>('blobs', 'asset1'))!); expect(stored.length).toBe(VIDEO.length); expect(stored.equals(VIDEO)).toBe(false); expect(stored.includes('FAKE-MP4')).toBe(false); // encrypted at rest
    expect(s.calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /v1/offline/devices', 'POST /v1/offline/licenses']);
    const o = await m.open('asset1'); const video = blobs.get(o.playback.streams[0].url)!; expect(Buffer.from(await readBlob(video)).equals(VIDEO)).toBe(true);
    expect(o.playback.streams.map((x) => x.label)).toEqual(['offline', 'captions', 'transcript']); expect(o.playback.interactions).toHaveLength(1); o.release(); expect(blobs.size).toBe(0);
  });
  it('a lesson copied to another device cannot be unlocked there', async () => {
    const s = server(); await mgr(s).download(arg); const lesson = (await idbGet<any>('lessons', 'asset1'))!; const blob = await idbGet<ArrayBuffer>('blobs', 'asset1');
    resetDb(); await new Promise<void>((r) => { const q = indexedDB.deleteDatabase('edtech-offline'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); resetDb();
    await idbPut('lessons', 'asset1', lesson); await idbPut('blobs', 'asset1', blob); // a different browser profile: a different private key
    await expect(mgr(s).open('asset1')).rejects.toMatchObject({ code: 'failed' });
  });
  it('refuses when offline, when there is no room, and when the server says no', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }); await expect(mgr(server()).download(arg)).rejects.toMatchObject({ code: 'network' }); Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    (navigator as any).storage = { estimate: async () => ({ quota: 1000, usage: 900 }), persist: async () => true }; await expect(mgr(server()).download(arg)).rejects.toMatchObject({ code: 'storage' }); delete (navigator as any).storage;
    await expect(mgr(server({ failLicense: 409 })).download(arg)).rejects.toThrow(/3 devices/); await expect(mgr(server({ failLicense: 403 })).download(arg)).rejects.toThrow(/not available/);
    expect(await mgr(server()).list()).toEqual([]);
  });
  it('an expired licence removes the download; a rolled-back clock is refused until the device is online', async () => {
    const s = server(); const m = mgr(s); await m.download(arg);
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await expect(new OfflineLessons(s.fake as any, s.fetchImpl, () => Date.now() - 3 * 86_400_000).open('asset1')).rejects.toMatchObject({ code: 'clock' }); // the clock moved back after a later use
    await expect(new OfflineLessons(s.fake as any, s.fetchImpl, () => Date.now() + 8 * 86_400_000).open('asset1')).rejects.toMatchObject({ code: 'expired' });
    expect(await m.has('asset1')).toBe(false); await expect(m.open('asset1')).rejects.toMatchObject({ code: 'missing' });
  });
  it('while online, revoked access removes the lesson, and one person never judges another person’s lessons', async () => {
    const s = server(); const m = mgr(s); await m.download(arg);
    const other = (await idbGet<any>('lessons', 'asset1'))!; await idbPut('lessons', 'asset2', { ...other, assetId: 'asset2', licenseId: 'licX', userId: 'u2' }); await idbPut('blobs', 'asset2', new ArrayBuffer(4));
    const r = server({ status: 'revoked' }); expect(await mgr(r).sync('u1')).toEqual(['asset1']); expect((await m.list()).map((x) => x.assetId)).toEqual(['asset2']); // u2's lesson untouched by u1's sync
    expect(await mgr(r).sync('u1')).toEqual([]);
  });
  it('opening while online and revoked says so and deletes', async () => {
    const s = server(); await mgr(s).download(arg); await expect(mgr(server({ status: 'revoked' })).open('asset1')).rejects.toMatchObject({ code: 'revoked' }); expect(await mgr(s).has('asset1')).toBe(false);
  });
});

describe('saved screens', () => {
  const ok = { get: vi.fn(async (p: string) => ({ p })) }; const down = { get: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) };
  it('use the network when it answers and the saved copy only when it cannot be reached', async () => {
    expect(await cachedGet('/v1/me/entitlements', ok as any)).toEqual({ data: { p: '/v1/me/entitlements' }, stale: false }); await waitFor(async () => expect((await idbAll('cache')).length).toBe(1));
    const r = await cachedGet('/v1/me/entitlements', down as any); expect(r).toMatchObject({ data: { p: '/v1/me/entitlements' }, stale: true });
    await expect(cachedGet('/v1/me/entitlements/x/progress', down as any)).rejects.toThrow(); // never saved: nothing to show
  });
  it('never hides a server error, never saves unlisted paths, and is per person and wiped on sign-out', async () => {
    const { ApiError } = await import('../api/client'); const bad = { get: vi.fn(async () => { throw new ApiError(500, {}); }) };
    await cachedGet('/v1/me/entitlements', ok as any); await expect(cachedGet('/v1/me/entitlements', bad as any)).rejects.toBeInstanceOf(ApiError);
    expect(cacheable('/v1/admin/users')).toBe(false); expect(cacheable('/v1/topics/abc?x=1')).toBe(true); expect(cacheable('/v1/exam-attempts/a/answers')).toBe(false);
    await cachedGet('/v1/admin/users', ok as any); await new Promise((r) => setTimeout(r, 20)); expect((await idbAll('cache')).map((x) => x.key)).toEqual(['u1|/v1/me/entitlements']);
    setCacheUser('u2'); await expect(cachedGet('/v1/me/entitlements', down as any)).rejects.toThrow(); setCacheUser('u1'); await clearCache('u1'); expect(await idbAll('cache')).toEqual([]);
  });
});

describe('downloads screens', () => {
  const stubFetch = (s: ReturnType<typeof server>) => vi.stubGlobal('fetch', vi.fn(async (u: any, init?: any) => { const url = String(u); const method = init?.method ?? 'GET';
    if (url === '/v1/offline/devices') return res(201, {}); if (url === '/v1/offline/licenses' && method === 'POST') return res(201, await s.fake.post('/v1/offline/licenses'));
    if (url === '/v1/auth/me' || url === '/v1/auth/refresh') return res(401, { message: 'no' });
    if (url.startsWith('/v1/offline/licenses?')) return res(200, await s.fake.get(url)); if (url.startsWith('/v1/topics/t1/playback')) return res(200, await s.fake.get(url)); return s.fetchImpl(u); }));
  it('the button saves a lesson, shows its expiry, and the list can play and remove it', async () => {
    const s = server(); s.fake.post('/v1/offline/devices', { publicKeyPem: (await deviceKeys()).publicKeyPem }); stubFetch(s);
    const { unmount } = render(<MemoryRouter><LocaleProvider lang="en"><DownloadButton {...arg} assetId="asset1" /></LocaleProvider></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Save for offline' })); await screen.findByText(/Saved on this device/); expect(screen.getByRole('link', { name: 'Watch offline' })).toHaveAttribute('href', '/downloads/asset1'); unmount();
    render(<MemoryRouter><AuthProvider><LocaleProvider lang="hi"><Downloads offlineMode /></LocaleProvider></AuthProvider></MemoryRouter>);
    await screen.findByText('Sensors'); expect(screen.getByRole('heading', { name: 'मेरे डाउनलोड' })).toBeInTheDocument();
  });
  it('lists nothing and says why when nothing is saved; removes one and all', async () => {
    const s = server(); await mgr(s).download(arg); await idbPut('kv', 'lastUser', { id: 'u1', name: 'Lena' }); stubFetch(s); api.clear();
    render(<MemoryRouter><AuthProvider><Downloads offlineMode /></AuthProvider></MemoryRouter>);
    await screen.findByText(/Showing downloads for Lena/); await userEvent.click(await screen.findByRole('button', { name: 'Remove' })); await screen.findByText(/Removed “Sensors”/);
    await screen.findByText(/Nothing is saved on this device yet/);
  });
  it('the player page unlocks a saved lesson, and explains when it cannot', async () => {
    const s = server(); await mgr(s).download(arg); stubFetch(s); api.clear();
    const view = <MemoryRouter initialEntries={['/offline/asset1']}><AuthProvider><Routes><Route path="/offline/:assetId" element={<OfflineLesson />} /></Routes></AuthProvider></MemoryRouter>;
    const { unmount } = render(view); await screen.findByRole('heading', { name: 'Sensors' }); expect(document.querySelector('video')).toBeTruthy(); unmount();
    await mgr(s).remove('asset1'); render(view); expect(await screen.findByRole('alert')).toHaveTextContent(/no longer on this device/);
  });
});

describe('OfflineError', () => { it('carries a code the screens can act on', () => { expect(new OfflineError('expired', 'x').code).toBe('expired'); }); });
