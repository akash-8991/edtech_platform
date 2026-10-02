import type { ConfigItem } from '../api/types';

/** `datetime-local` gives "2026-10-05T09:30" in the user's zone; the API wants an ISO instant. */
export const localToIso = (v: string): string | null => { if (!v) return null; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };
export const isoToLocalInput = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const checkinLink = (token: string, origin = window.location.origin) => `${origin}/labs/attend?token=${encodeURIComponent(token)}`;

export interface SlotForm { batchCode: string; startsAt: string; endsAt: string; capacity: string; location: string }
/** Client-side checks that give instant feedback; the server validates again. Returns an error message or null. */
export function validateSlot(f: SlotForm, now = Date.now()): string | null {
  if (!f.batchCode.trim()) return 'Enter a batch code (for example the cohort name).';
  const s = localToIso(f.startsAt), e = localToIso(f.endsAt); if (!s || !e) return 'Choose a start and an end time.';
  if (Date.parse(s) < now) return 'The start time must be in the future.'; if (Date.parse(e) <= Date.parse(s)) return 'The end time must be after the start time.';
  const c = Number(f.capacity); if (!Number.isInteger(c) || c < 1 || c > 500) return 'Capacity must be a whole number from 1 to 500.';
  return null;
}

/** Editing a runtime setting: turn what the admin typed back into the typed value the API validates. */
export function parseConfigInput(kind: ConfigItem['kind'], text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim();
  switch (kind) {
    case 'boolean': return t === 'true' || t === 'false' ? { ok: true, value: t === 'true' } : { ok: false, error: 'Choose on or off.' };
    case 'number': { const n = Number(t); return t !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'Enter a number.' }; }
    case 'string[]': return { ok: true, value: t.split('\n').map((x) => x.trim()).filter(Boolean) };
    default: try { const v = JSON.parse(t || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, error: 'Enter a JSON object, e.g. {"P1": 60}.' }; } catch { return { ok: false, error: 'That is not valid JSON.' }; }
  }
}
export const configToText = (item: Pick<ConfigItem, 'kind' | 'value'>): string => item.kind === 'string[]' ? ((item.value as string[]) ?? []).join('\n') : item.kind === 'boolean' || item.kind === 'number' ? String(item.value) : JSON.stringify(item.value ?? {}, null, 1);
/** Settings that can stop or restrict platform-wide behaviour get an explicit confirmation. */
export const RISKY_KEYS = new Set(['ai.kill_switch', 'exam.change_freeze']);
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
