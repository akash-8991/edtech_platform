import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Newer Node versions ship their own (file-backed, often unusable) localStorage global that shadows jsdom's: use a plain in-memory one.
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  [name: string]: any;
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const s = new MemStorage(); Object.defineProperty(globalThis, name, { value: s, configurable: true, writable: true });
  Object.defineProperty(window, name, { value: s, configurable: true, writable: true });
}
import { resetLang } from '../lib/i18n';
import { resetReachable } from '../lib/offline/network';
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); resetLang(); resetReachable(); });

// ---- accessibility regression net ---------------------------------------------------------------------------------------------------------------
// After EVERY test, the final DOM is checked with axe-core (WCAG 2.x A/AA and best practice). jsdom has no layout, so contrast and the
// document-level rules (landmarks, title, language, "one h1": components render as fragments) are covered by the real-browser sweep in
// docs/quality/accessibility-audit.md instead. Anything element-level (names, labels, roles, ARIA, duplicate ids, list/table structure) fails the test.
import axe from 'axe-core';
const SKIP_RULES = ['color-contrast', 'region', 'page-has-heading-one', 'landmark-one-main', 'document-title', 'html-has-lang', 'html-lang-valid', 'bypass', 'landmark-unique', 'landmark-no-duplicate-banner', 'landmark-banner-is-top-level', 'landmark-contentinfo-is-top-level', 'landmark-main-is-top-level', 'landmark-complementary-is-top-level', 'scrollable-region-focusable', 'target-size'];
afterEach(async () => {
  if (process.env.A11Y === '0' || !document.body.firstElementChild) return;
  const r = await axe.run(document.body, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: Object.fromEntries(SKIP_RULES.map((id) => [id, { enabled: false }])) });
  if (r.violations.length) throw new Error('Accessibility violations:\n' + r.violations.map((v) => `- ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.html.slice(0, 140)).join('\n    ')}`).join('\n'));
});
