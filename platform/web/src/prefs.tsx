import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api/client';
import type { Prefs } from './api/types';
import { useAuth } from './auth';
import { applyPrefs, loadPrefsLocal, savePrefsLocal } from './lib/privacy';

interface PrefsState { prefs: Prefs; save: (change: Partial<Prefs>) => Promise<void> }
const Ctx = createContext<PrefsState>({ prefs: {}, save: async () => {} });
export const usePrefs = () => useContext(Ctx);

/** Loads the learner's saved preferences, applies them to the whole app immediately (also from a local copy so the first paint is right), and saves changes. */
export function PrefsProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth(); const [prefs, setPrefs] = useState<Prefs>(() => loadPrefsLocal());
  useEffect(() => { applyPrefs(prefs); }, [prefs]);
  useEffect(() => { if (!me) return; api.get<Prefs>('/v1/me/preferences').then((p) => { setPrefs(p ?? {}); savePrefsLocal(p ?? {}); }).catch(() => undefined); }, [me]);
  const save = async (change: Partial<Prefs>) => { const next = { ...prefs, ...change }; setPrefs(next); applyPrefs(next); savePrefsLocal(next); try { await api.put('/v1/me/preferences', change); } catch (e) { setPrefs(prefs); applyPrefs(prefs); savePrefsLocal(prefs); throw e; } };
  return <Ctx.Provider value={{ prefs, save }}>{children}</Ctx.Provider>;
}
