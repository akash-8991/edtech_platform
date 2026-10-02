import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api/client';
import type { Me } from './api/types';

interface AuthState { me: Me | null; loading: boolean; refreshMe: () => Promise<void>; signOut: () => Promise<void> }
const Ctx = createContext<AuthState>({ me: null, loading: true, refreshMe: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const [loading, setLoading] = useState(true);
  const refreshMe = async () => { try { setMe(await api.get<Me>('/v1/auth/me')); } catch { setMe(null); } };
  useEffect(() => {
    let alive = true;
    (async () => { if (await api.restore()) await refreshMe(); if (alive) setLoading(false); })();
    const off = api.subscribeLogout(() => setMe(null));
    return () => { alive = false; off(); };
  }, []);
  const value = useMemo<AuthState>(() => ({ me, loading, refreshMe, signOut: async () => { await api.logout(); setMe(null); } }), [me, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
