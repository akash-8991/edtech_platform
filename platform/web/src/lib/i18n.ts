import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { HI } from '../i18n/hi';

export type Lang = 'en' | 'hi';
/** English uses the browser's own locale for dates and numbers; Hindi pins hi-IN so digits and month names are Hindi. */
export const LANGS: { code: Lang; name: string; native: string; locale: string | undefined }[] = [{ code: 'en', name: 'English', native: 'English', locale: undefined }, { code: 'hi', name: 'Hindi', native: 'हिन्दी', locale: 'hi-IN' }];
export const isLang = (x: unknown): x is Lang => x === 'en' || x === 'hi';

/**
 * Strings are keyed by their English text, so source stays readable and a missing translation falls back to English instead of a key.
 * `{name}` placeholders are filled from `vars`. A test scans the source and fails if any string passed to t() has no Hindi entry.
 */
let current: Lang = 'en';
export const getLang = () => current;
/** Test hook: the language is module state shared by plain helpers, so tests reset it between runs. */
export const resetLang = () => { current = 'en'; };
export function translate(key: string, vars?: Record<string, string | number>, lang: Lang = current): string {
  const s = lang === 'hi' ? HI[key] ?? key : key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}
export const tr = translate;
/** Marks a string that is stored in a table and translated where it is shown (`t(row.label)`): the i18n test treats it like a t() call. */
export const mark = (s: string) => s;

/** The language to start in: the saved preference, else the account's language, else the browser's, else English. */
export function chooseLang(pref?: unknown, account?: unknown, browser: readonly string[] = (typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [])): Lang {
  if (isLang(pref)) return pref; if (isLang(account)) return account;
  return browser.some((l) => /^hi\b/i.test(l ?? '')) ? 'hi' : 'en';
}
export const localeOf = (lang: Lang = current) => LANGS.find((l) => l.code === lang)!.locale;

export const fmtDate = (iso: string | number | Date, o: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }) => new Date(iso).toLocaleDateString(localeOf(), o);
export const fmtDateTime = (iso: string | number | Date) => new Date(iso).toLocaleString(localeOf());
export const fmtNumber = (n: number) => n.toLocaleString(localeOf());

interface Ctx { lang: Lang; t: typeof translate; setLang: (l: Lang) => void }
const LocaleCtx = createContext<Ctx>({ lang: 'en', t: (k, v) => translate(k, v, 'en'), setLang: () => undefined });
export const useLocale = () => useContext(LocaleCtx);
export const useT = () => useContext(LocaleCtx).t;

export function LocaleProvider({ lang, onChange, children }: { lang: Lang; onChange?: (l: Lang) => void; children: ReactNode }) {
  current = lang; // plain helpers (labels, error text) read this during render
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const value = useMemo<Ctx>(() => ({ lang, t: (k, v) => translate(k, v, lang), setLang: (l) => onChange?.(l) }), [lang, onChange]);
  return createElement(LocaleCtx.Provider, { value }, children);
}
