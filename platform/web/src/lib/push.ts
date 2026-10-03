import { api as defaultApi } from '../api/client';
import { tr } from './i18n';

/**
 * Push notifications for this browser or phone. In a browser: the Push API with a service worker (Chrome, Edge, Firefox, Safari 16.4+ once the
 * app is added to the Home Screen). In the native app: Firebase Cloud Messaging through the Capacitor plugin (Android, and iOS via APNs).
 * The server decides what is sent and when; this file only registers the device and lets the person turn it off.
 */
const KEY = 'edtech.pushDevice';
type ApiLike = Pick<typeof defaultApi, 'get' | 'post' | 'request'>;
export type PushState = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on' | 'unavailable';

const cap = (): any => (typeof window !== 'undefined' ? (window as any).Capacitor : undefined);
export const isNative = () => !!cap()?.isNativePlatform?.();
const nativePlugin = () => cap()?.Plugins?.FirebaseMessaging;
export const nativePlatform = () => (cap()?.getPlatform?.() === 'ios' ? 'IOS' : 'ANDROID') as 'IOS' | 'ANDROID';
export const webPushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
const stored = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
const remember = (id: string | null) => { try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch { /* private mode */ } };

export function urlBase64ToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushState(api: ApiLike = defaultApi): Promise<PushState> {
  if (isNative()) { if (!nativePlugin()) return 'unsupported'; const p = await nativePlugin().checkPermissions?.().catch(() => undefined); if (p?.receive === 'denied') return 'denied'; return stored() ? 'on' : 'off'; }
  if (!webPushSupported()) return 'unsupported';
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure';
  if (Notification.permission === 'denied') return 'denied';
  try { const c = await api.get<{ enabled: boolean; web: boolean }>('/v1/push/config'); if (!c.enabled || !c.web) return 'unavailable'; } catch { /* offline: fall through to local knowledge */ }
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined); const sub = await reg?.pushManager?.getSubscription().catch(() => null);
  return sub && stored() ? 'on' : 'off';
}

export async function enablePush(language: string, api: ApiLike = defaultApi): Promise<PushState> {
  if (isNative()) {
    const fm = nativePlugin(); if (!fm) throw new Error(tr('Push notifications are not available in this app build.'));
    const perm = await fm.requestPermissions(); if (perm?.receive !== 'granted') return 'denied';
    const { token } = await fm.getToken(); const d = await api.post<{ id: string }>('/v1/me/push/devices', { platform: nativePlatform(), token, language }); remember(d.id); return 'on';
  }
  if (!webPushSupported()) return 'unsupported';
  const cfg = await api.get<{ enabled: boolean; web: boolean; webPublicKey: string | null }>('/v1/push/config'); if (!cfg.enabled || !cfg.web || !cfg.webPublicKey) return 'unavailable';
  const perm = await Notification.requestPermission(); if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready; let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(cfg.webPublicKey) as BufferSource });
  const j = sub.toJSON(); const d = await api.post<{ id: string }>('/v1/me/push/devices', { platform: 'WEB', token: sub.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth }, language }); remember(d.id); return 'on';
}

export async function disablePush(api: ApiLike = defaultApi): Promise<void> {
  const id = stored(); if (id) await api.request('DELETE', `/v1/me/push/devices/${id}`).catch(() => undefined);
  remember(null);
  if (isNative()) { await nativePlugin()?.deleteToken?.().catch(() => undefined); return; }
  if (webPushSupported()) { const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined); await (await reg?.pushManager?.getSubscription())?.unsubscribe().catch(() => undefined); }
}

/** In the native app a tap on a notification opens the screen it names (same-origin paths only). Returns a function that stops listening. */
export function onNativeNotificationTap(go: (path: string) => void): () => void {
  const fm = nativePlugin(); if (!isNative() || !fm?.addListener) return () => undefined; let handle: { remove?: () => void } | undefined; let gone = false;
  Promise.resolve(fm.addListener('notificationActionPerformed', (e: any) => { const u = e?.notification?.data?.url; if (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//')) go(u); })).then((h: any) => { if (gone) h?.remove?.(); else handle = h; }).catch(() => undefined);
  return () => { gone = true; handle?.remove?.(); };
}
