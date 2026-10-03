import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import vm from 'vm';

/** Loads public/sw.js into a bare sandbox with in-memory Cache Storage so its real fetch logic runs without a browser. */
function load(network: (url: string) => Promise<{ ok: boolean; body: string }>) {
  const store = new Map<string, Map<string, string>>(); const listeners: Record<string, (e: any) => void> = {}; let skipped = false, claimed = false; const fetched: string[] = [];
  const cacheApi = (name: string) => { const m = store.get(name) ?? new Map<string, string>(); store.set(name, m); return { async addAll(urls: string[]) { for (const u of urls) m.set(new URL(u, 'https://app.test').pathname, 'precached'); }, async put(k: any, r: any) { m.set(new URL(typeof k === 'string' ? k : k.url, 'https://app.test').pathname, await r.text()); },
    async match(k: any) { const v = m.get(new URL(typeof k === 'string' ? k : k.url, 'https://app.test').pathname); return v === undefined ? undefined : new FakeResponse(v, true); } }; };
  class FakeResponse { constructor(public body: string, public ok = true, public init: any = {}) {} get status() { return this.init.status ?? 200; } clone() { return new FakeResponse(this.body, this.ok, this.init); } async text() { return this.body; } }
  const self: any = { location: new URL('https://app.test/'), addEventListener: (t: string, f: any) => { listeners[t] = f; }, skipWaiting: () => { skipped = true; }, clients: { claim: async () => { claimed = true; } } };
  const caches = { open: async (n: string) => cacheApi(n), keys: async () => [...store.keys()], delete: async (n: string) => store.delete(n), match: async (k: any) => { for (const [, m] of store) { const v = m.get(new URL(typeof k === 'string' ? k : k.url, 'https://app.test').pathname); if (v !== undefined) return new FakeResponse(v, true); } return undefined; } };
  const fetchFn = async (req: any) => { const url = typeof req === 'string' ? req : req.url; fetched.push(new URL(url).pathname); const r = await network(url); return new FakeResponse(r.body, r.ok); };
  class SwResponse extends FakeResponse { constructor(body: string, init: any = {}) { super(body, true, init); } } // the real constructor is (body, init)
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches, fetch: fetchFn, URL, Response: SwResponse, Promise, console });
  const wait = async (type: string, e: any = {}) => { let p: Promise<any> = Promise.resolve(); listeners[type]({ ...e, waitUntil: (x: Promise<any>) => { p = x; } }); await p; };
  const request = async (url: string, o: { method?: string; mode?: string } = {}) => { let out: any = 'passed'; await new Promise<void>((resolve) => { listeners.fetch({ request: { url: new URL(url, 'https://app.test').href, method: o.method ?? 'GET', mode: o.mode ?? 'cors' }, respondWith: (p: Promise<any>) => { out = p; resolve(); } }); resolve(); }); return out === 'passed' ? 'passed' : await out; };
  return { store, wait, request, fetched, flags: () => ({ skipped, claimed }) };
}

describe('service worker', () => {
  it('precaches the app shell on install and drops old caches on activate', async () => {
    const sw = load(async () => ({ ok: true, body: 'x' })); await sw.wait('install'); expect([...sw.store.get('shell-v1')!.keys()].sort()).toEqual(['/', '/icon.svg', '/manifest.webmanifest']); expect(sw.flags().skipped).toBe(true);
    sw.store.set('shell-v0', new Map()); sw.store.set('assets-v0', new Map()); await sw.wait('activate'); expect([...sw.store.keys()].sort()).toEqual(['shell-v1']); expect(sw.flags().claimed).toBe(true);
  });
  it('never touches the API, other origins or non-GET requests', async () => {
    const sw = load(async () => ({ ok: true, body: 'x' })); await sw.wait('install');
    for (const u of ['/v1/me/entitlements', '/v1/media/stream/abc', '/health', '/metrics']) expect(await sw.request(u), u).toBe('passed');
    expect(await sw.request('https://cdn.example.com/lib.js')).toBe('passed'); expect(await sw.request('/assets/app.js', { method: 'POST' })).toBe('passed'); expect(sw.fetched).toEqual([]);
  });
  it('opens any page offline from the cached shell, and refreshes the shell whenever the network answers', async () => {
    let up = true; const sw = load(async () => { if (!up) throw new TypeError('offline'); return { ok: true, body: '<html>fresh shell</html>' }; }); await sw.wait('install');
    const online = await sw.request('/downloads/abc', { mode: 'navigate' }); expect(online.body).toContain('fresh shell'); await new Promise((r) => setTimeout(r, 5)); expect(sw.store.get('shell-v1')!.get('/')).toBe('<html>fresh shell</html>');
    up = false; const offline = await sw.request('/offline', { mode: 'navigate' }); expect(offline.body).toBe('<html>fresh shell</html>');
    const empty = load(async () => { throw new TypeError('offline'); }); const miss = await empty.request('/', { mode: 'navigate' }); expect(miss.status).toBe(503);
  });
  it('serves fingerprinted assets from cache after the first load, and other files stale-while-revalidate', async () => {
    let n = 0; const sw = load(async (u) => ({ ok: true, body: `${new URL(u).pathname}#${++n}` })); await sw.wait('install');
    expect((await sw.request('/assets/index-abc.js')).body).toBe('/assets/index-abc.js#1'); await new Promise((r) => setTimeout(r, 5)); expect((await sw.request('/assets/index-abc.js')).body).toBe('/assets/index-abc.js#1'); expect(sw.fetched.filter((p) => p === '/assets/index-abc.js')).toHaveLength(1); // second time: no network
    expect((await sw.request('/icon-192.png')).body).toBe('/icon-192.png#2'); await new Promise((r) => setTimeout(r, 5)); expect((await sw.request('/icon-192.png')).body).toBe('/icon-192.png#2'); // served from cache while it refreshes
  });
});
