import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api/client';
import type { Me } from './api/types';
import { clearCache, setCacheUser } from './lib/offline/cache';
import { idbPut } from './lib/offline/idb';

interface AuthState { me: Me | null; loading: boolean; refreshMe: () => Promise<void>; signOut: () => Promise<void> }
const Ctx = createContext<AuthState>({ me: null, loading: true, refreshMe: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const [loading, setLoading] = useState(true);
  const refreshMe = async () => { try { const m = await api.get<Me>('/v1/auth/me'); setCacheUser(m.id); void idbPut('kv', 'lastUser', { id: m.id, name: m.name }).catch(() => undefined); setMe(m); } catch { setMe(null); } };
  useEffect(() => {
    let alive = true;
    (async () => { if (await api.restore()) await refreshMe(); if (alive) setLoading(false); })();
    const off = api.subscribeLogout(() => setMe(null));
    return () => { alive = false; off(); };
  }, []);
  const value = useMemo<AuthState>(() => ({ me, loading, refreshMe, signOut: async () => { const id = me?.id; await api.logout(); setCacheUser(null); if (id) void clearCache(id); setMe(null); } }), [me, loading]); // saved screens go with the session; downloaded lessons stay until removed
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
