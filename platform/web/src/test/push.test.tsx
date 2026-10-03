import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'fs';
import vm from 'vm';
import { api } from '../api/client';
import { AuthProvider } from '../auth';
import { PrefsProvider } from '../prefs';
import Privacy from '../pages/Privacy';
import { disablePush, enablePush, isNative, onNativeNotificationTap, pushState, urlBase64ToBytes } from '../lib/push';

configure({ asyncUtilTimeout: 5000 });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let calls: { method: string; url: string; body: any }[] = [];
const route = (map: Record<string, (b: any) => Response | Promise<Response>>) => vi.stubGlobal('fetch', vi.fn(async (u: any, init: any) => { const url = String(u); const method = init?.method ?? 'GET'; const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined; calls.push({ method, url, body });
  const h = map[`${method} ${url}`]; return h ? h(body) : res(404, { message: `no route ${method} ${url}` }); }));
const CFG = { enabled: true, web: true, native: true, webPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' };

/** A browser with a service worker, a push manager and a Notification permission we can steer. */
function browser(o: { permission?: NotificationPermission; request?: NotificationPermission; subscribed?: boolean; secure?: boolean } = {}) {
  const sub = { endpoint: 'https://push.example.test/send/abc', toJSON: () => ({ endpoint: 'https://push.example.test/send/abc', keys: { p256dh: 'P256', auth: 'AUTH' } }), unsubscribe: vi.fn(async () => true) };
  let current: typeof sub | null = o.subscribed ? sub : null; const subscribe = vi.fn(async () => (current = sub));
  const reg = { pushManager: { getSubscription: async () => current, subscribe } };
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), getRegistration: async () => reg }, configurable: true });
  (window as any).PushManager = class {}; (window as any).Notification = class { static permission = o.permission ?? 'default'; static requestPermission = vi.fn(async () => o.request ?? 'granted'); };
  Object.defineProperty(window, 'isSecureContext', { value: o.secure ?? true, configurable: true });
  return { sub, subscribe, reg, current: () => current };
}
const nativeApp = (o: { receive?: string; token?: string; ios?: boolean } = {}) => { const listeners: Record<string, (e: any) => void> = {}; const handle = { remove: vi.fn() };
  const fm = { checkPermissions: vi.fn(async () => ({ receive: o.receive ?? 'prompt' })), requestPermissions: vi.fn(async () => ({ receive: o.receive === 'denied' ? 'denied' : 'granted' })), getToken: vi.fn(async () => ({ token: o.token ?? 'fcm-token-1' })), deleteToken: vi.fn(async () => undefined), addListener: vi.fn(async (n: string, f: any) => { listeners[n] = f; return handle; }) };
  (window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => (o.ios ? 'ios' : 'android'), Plugins: { FirebaseMessaging: fm } }; return { fm, listeners, handle }; };
beforeEach(() => { calls = []; api.clear(); api.setTokens({ accessToken: 'A', refreshToken: 'R' }); });
afterEach(() => { vi.unstubAllGlobals(); for (const k of ['PushManager', 'Notification', 'Capacitor']) delete (window as any)[k]; delete (navigator as any).serviceWorker; Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true }); });

describe('browser push', () => {
  it('turns on: asks permission, subscribes with the server key, and registers the endpoint and keys', async () => {
    const b = browser(); route({ 'GET /v1/push/config': () => res(200, CFG), 'POST /v1/me/push/devices': () => res(201, { id: 'dev1' }) });
    expect(await pushState()).toBe('off'); expect(await enablePush('hi')).toBe('on');
    expect((window as any).Notification.requestPermission).toHaveBeenCalled(); expect(b.subscribe).toHaveBeenCalledTimes(1); const key = (b.subscribe.mock.calls[0] as any)[0]; expect(key.userVisibleOnly).toBe(true); expect(key.applicationServerKey).toBeInstanceOf(Uint8Array); expect(key.applicationServerKey).toHaveLength(65);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ platform: 'WEB', token: 'https://push.example.test/send/abc', keys: { p256dh: 'P256', auth: 'AUTH' }, language: 'hi' }); expect(await pushState()).toBe('on');
  });
  it('reuses an existing subscription instead of making a second one', async () => {
    const b = browser({ subscribed: true }); route({ 'GET /v1/push/config': () => res(200, CFG), 'POST /v1/me/push/devices': () => res(201, { id: 'dev1' }) }); await enablePush('en'); expect(b.subscribe).not.toHaveBeenCalled();
  });
  it('turns off: removes the device on the server and unsubscribes the browser', async () => {
    const b = browser({ subscribed: true }); route({ 'GET /v1/push/config': () => res(200, CFG), 'POST /v1/me/push/devices': () => res(201, { id: 'dev1' }), 'DELETE /v1/me/push/devices/dev1': () => res(200, { ok: true }) });
    await enablePush('en'); await disablePush(); expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/dev1'))).toBe(true); expect(b.sub.unsubscribe).toHaveBeenCalled(); expect(await pushState()).toBe('off');
  });
  it('says plainly why it cannot work: blocked, not secure, unsupported, or not enabled on the server', async () => {
    route({ 'GET /v1/push/config': () => res(200, CFG) }); browser({ permission: 'denied' }); expect(await pushState()).toBe('denied'); expect(await (async () => { browser({ request: 'denied' }); return enablePush('en'); })()).toBe('denied');
    browser({ secure: false }); expect(await pushState()).toBe('insecure'); delete (window as any).PushManager; expect(await pushState()).toBe('unsupported');
    browser(); route({ 'GET /v1/push/config': () => res(200, { enabled: false, web: false, native: false, webPublicKey: null }) }); expect(await pushState()).toBe('unavailable'); expect(await enablePush('en')).toBe('unavailable');
    browser({ request: 'default' }); route({ 'GET /v1/push/config': () => res(200, CFG) }); expect(await enablePush('en')).toBe('off'); // the person dismissed the prompt: not a refusal, ask again later
  });
  it('decodes the server key the way PushManager wants it', () => { expect(Array.from(urlBase64ToBytes('AQID'))).toEqual([1, 2, 3]); expect(Array.from(urlBase64ToBytes('_-8'))).toEqual([255, 239]); });
});

describe('native app push', () => {
  it('registers the Firebase token with the right platform, and removes it on turn-off', async () => {
    const n = nativeApp({ token: 'fcm-xyz', ios: true }); route({ 'POST /v1/me/push/devices': () => res(201, { id: 'dev9' }), 'DELETE /v1/me/push/devices/dev9': () => res(200, {}) });
    expect(isNative()).toBe(true); expect(await pushState()).toBe('off'); expect(await enablePush('hi')).toBe('on'); expect(calls[0].body).toEqual({ platform: 'IOS', token: 'fcm-xyz', language: 'hi' }); expect(await pushState()).toBe('on');
    await disablePush(); expect(n.fm.deleteToken).toHaveBeenCalled(); expect(await pushState()).toBe('off');
  });
  it('reports a refusal, and a build without the plugin', async () => {
    nativeApp({ receive: 'denied' }); route({}); expect(await pushState()).toBe('denied'); expect(await enablePush('en')).toBe('denied'); expect(calls).toHaveLength(0);
    (window as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }; expect(await pushState()).toBe('unsupported'); await expect(enablePush('en')).rejects.toThrow(/not available in this app build/);
  });
  it('a tap opens the screen the notification names, never another site, and stops listening when asked', async () => {
    const n = nativeApp(); const go = vi.fn(); const stop = onNativeNotificationTap(go); await waitFor(() => expect(n.listeners.notificationActionPerformed).toBeTruthy());
    n.listeners.notificationActionPerformed({ notification: { data: { url: '/grades/s1' } } }); n.listeners.notificationActionPerformed({ notification: { data: { url: 'https://evil.test/x' } } }); n.listeners.notificationActionPerformed({ notification: { data: { url: '//evil.test/x' } } }); n.listeners.notificationActionPerformed({ notification: {} });
    expect(go.mock.calls).toEqual([['/grades/s1']]); stop(); await waitFor(() => expect(n.handle.remove).toHaveBeenCalled()); delete (window as any).Capacitor; expect(onNativeNotificationTap(go)).toBeTypeOf('function');
  });
});

describe('settings card', () => {
  const view = () => render(<MemoryRouter><AuthProvider><PrefsProvider><Privacy /></PrefsProvider></AuthProvider></MemoryRouter>);
  const base = { 'GET /v1/auth/me': () => res(200, { id: 'u1', email: 'a@x.test', name: 'Asha', language: 'en', roles: ['LEARNER'], mfaEnabled: false }), 'GET /v1/me/preferences': () => res(200, {}), 'GET /v1/me/consents': () => res(200, []), 'GET /v1/me/privacy/requests': () => res(200, []), 'GET /v1/push/config': () => res(200, CFG) };
  it('turns push on for this device, sends a test, and turns it off', async () => {
    browser(); route({ ...base, 'POST /v1/me/push/devices': () => res(201, { id: 'dev1' }), 'POST /v1/me/push/test': () => res(201, { devices: 1, sent: 1 }), 'DELETE /v1/me/push/devices/dev1': () => res(200, {}) });
    view(); await userEvent.click(await screen.findByRole('button', { name: 'Turn on for this device' })); await userEvent.click(await screen.findByRole('button', { name: 'Send me a test' })); await screen.findByText('A test notification was sent to 1 device(s).');
    await userEvent.click(screen.getByRole('button', { name: 'Turn off for this device' })); await screen.findByRole('button', { name: 'Turn on for this device' });
  });
  it('explains a blocked or unsupported browser, and the account-wide switch saves', async () => {
    browser({ permission: 'denied' }); let saved: any = null; route({ ...base, 'PUT /v1/me/preferences': (b) => { saved = b; return res(200, b); } }); view();
    await screen.findByText(/Notifications are blocked for this site or app/); expect(screen.queryByRole('button', { name: 'Turn on for this device' })).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: /Send push notifications to all my devices/ })); await waitFor(() => expect(saved).toEqual({ push: false }));
  });
});

describe('service worker push handling', () => {
  function sw() {
    const listeners: Record<string, (e: any) => void> = {}; const shown: any[] = []; const clientsList: any[] = []; const opened: string[] = [];
    const self: any = { location: new URL('https://app.test/'), addEventListener: (t: string, f: any) => { listeners[t] = f; }, skipWaiting() {}, registration: { showNotification: async (title: string, o: any) => { shown.push({ title, ...o }); } },
      clients: { claim: async () => undefined, matchAll: async () => clientsList, openWindow: async (u: string) => { opened.push(u); } } };
    vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches: {}, fetch: async () => undefined, URL, Response, Promise, console });
    const fire = async (type: string, e: any) => { let p: Promise<any> = Promise.resolve(); listeners[type]({ ...e, waitUntil: (x: Promise<any>) => { p = x; } }); await p; };
    return { shown, clientsList, opened, push: (data: any) => fire('push', { data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data), text: () => String(data) } }), click: (url: string | undefined) => { const closed = vi.fn(); return fire('notificationclick', { notification: { close: closed, data: url === undefined ? undefined : { url } } }).then(() => closed); } };
  }
  it('shows what the server sent, with a safe default for anything odd', async () => {
    const s = sw(); await s.push({ title: 'Learning Portal', body: 'Your lab session is booked.', url: '/labs', tag: 'lab.booked' }); expect(s.shown[0]).toMatchObject({ title: 'Learning Portal', body: 'Your lab session is booked.', tag: 'lab.booked', icon: '/icon-192.png', data: { url: '/labs' } });
    await s.push(undefined); expect(s.shown[1]).toMatchObject({ title: 'Learning Portal', body: '', data: { url: '/notifications' } }); await s.push('{not json'); expect(s.shown).toHaveLength(3);
  });
  it('a tap focuses an open window and sends it to the screen, or opens one; foreign addresses are ignored', async () => {
    const s = sw(); const w = { focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) }; s.clientsList.push(w);
    const closed = await s.click('/exam-results/a1'); expect(closed).toHaveBeenCalled(); expect(w.navigate).toHaveBeenCalledWith('https://app.test/exam-results/a1'); expect(w.focus).toHaveBeenCalled();
    await s.click('https://evil.test/phish'); expect(w.navigate).toHaveBeenLastCalledWith('https://app.test/notifications'); await s.click(undefined); expect(w.navigate).toHaveBeenLastCalledWith('https://app.test/');
    s.clientsList.length = 0; await s.click('/labs'); expect(s.opened).toEqual(['https://app.test/labs']);
  });
});
