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
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });
