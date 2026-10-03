import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api/client';
import type { Prefs } from './api/types';
import { useInRouterContext, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { applyPrefs, loadPrefsLocal, savePrefsLocal } from './lib/privacy';
import { chooseLang, LocaleProvider } from './lib/i18n';

interface PrefsState { prefs: Prefs; save: (change: Partial<Prefs>) => Promise<void> }
const Ctx = createContext<PrefsState>({ prefs: {}, save: async () => {} });
export const usePrefs = () => useContext(Ctx);

/** Loads the learner's saved preferences, applies them to the whole app immediately (also from a local copy so the first paint is right), and saves changes. */
export function PrefsProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth(); const [prefs, setPrefs] = useState<Prefs>(() => loadPrefsLocal());
  useEffect(() => { applyPrefs(prefs); }, [prefs]);
  useEffect(() => { if (!me) return; api.get<Prefs>('/v1/me/preferences').then((p) => { setPrefs(p ?? {}); savePrefsLocal(p ?? {}); }).catch(() => undefined); }, [me]);
  const save = async (change: Partial<Prefs>) => { const next = { ...prefs, ...change }; setPrefs(next); applyPrefs(next); savePrefsLocal(next); if (!api.signedIn) return; /* signed-out visitors (the sign-in page) keep their choice on this device only */ try { await api.put('/v1/me/preferences', change); } catch (e) { setPrefs(prefs); applyPrefs(prefs); savePrefsLocal(prefs); throw e; } };
  // The staff console is English only, whatever language the person reads the learner portal in (decision D-087).
  const inRouter = useInRouterContext(); const path = inRouter ? useLocation().pathname : ''; // eslint-disable-line react-hooks/rules-of-hooks -- the router context never changes while mounted
  const lang = path.startsWith('/staff') ? 'en' : chooseLang(prefs.language, me?.language);
  return <Ctx.Provider value={{ prefs, save }}><LocaleProvider lang={lang} onChange={(l) => { save({ language: l }).catch(() => undefined); }}>{children}</LocaleProvider></Ctx.Provider>;
}
