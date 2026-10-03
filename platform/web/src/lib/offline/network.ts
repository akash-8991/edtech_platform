import { useEffect, useState } from 'react';

/**
 * Whether the platform can be reached. Two signals are combined: the browser's own "a network is attached" flag, and whether our last request
 * actually got an answer (a connected phone with no signal, or a server that is down, still has the first flag set). While unreachable, the
 * health endpoint is probed so the app notices when it is back.
 */
let reachable = true; const subs = new Set<() => void>();
export const setReachable = (v: boolean) => { if (v !== reachable) { reachable = v; subs.forEach((f) => f()); } };
export const isReachable = () => reachable;
export const resetReachable = () => { reachable = true; subs.forEach((f) => f()); };

export function useOnline(): boolean {
  const [nav, setNav] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)); const [ok, setOk] = useState(reachable);
  useEffect(() => { const up = () => setNav(true), down = () => setNav(false), sub = () => setOk(reachable); window.addEventListener('online', up); window.addEventListener('offline', down); subs.add(sub); setOk(reachable); return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); subs.delete(sub); }; }, []);
  useEffect(() => {
    if (ok || !nav) return; const probe = () => { fetch('/health', { cache: 'no-store' }).then((r) => { if (r.ok) setReachable(true); }).catch(() => undefined); };
    const id = setInterval(probe, 8000); return () => clearInterval(id);
  }, [ok, nav]);
  return nav && ok;
}
