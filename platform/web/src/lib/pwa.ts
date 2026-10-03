/** Registers the service worker so the app opens offline. Production builds only: in development it would serve stale code. */
import { isNative } from './push';
export function registerServiceWorker() {
  if (isNative()) return; // the native app bundles its own copy of the app; a service worker there would only add a second cache
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !(import.meta as any).env?.PROD) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}
