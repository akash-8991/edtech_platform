import { api as defaultApi, ApiError } from '../../api/client';
import { idbAll, idbDelete, idbGet, idbPut } from './idb';

/**
 * Read-through cache for the few screens a learner needs without a connection (courses, progress, topic text, notifications). The network
 * always wins when it answers; the saved copy is used only when the request cannot be made at all. It is kept per person, holds nothing
 * secret (no tokens, no answer keys), and is wiped on sign-out. Server errors are NOT papered over with old data.
 */
const KEY = (userId: string, path: string) => `${userId}|${path}`;
interface Saved<T> { at: number; data: T }
let who = '';
export const setCacheUser = (id: string | null) => { who = id ?? ''; };
export const CACHEABLE = [/^\/v1\/me\/entitlements(\/[^/]+\/progress)?$/, /^\/v1\/topics\/[^/]+$/, /^\/v1\/catalogue(\/versions\/[^/]+)?$/, /^\/v1\/me\/notifications$/, /^\/v1\/me\/preferences$/, /^\/v1\/me\/labs$/, /^\/v1\/me\/exams$/];
export const cacheable = (path: string) => CACHEABLE.some((re) => re.test(path.split('?')[0]));

export interface Cached<T> { data: T; stale: boolean; savedAt?: number }
export async function cachedGet<T>(path: string, client: Pick<typeof defaultApi, 'get'> = defaultApi): Promise<Cached<T>> {
  const can = !!who && cacheable(path) && typeof indexedDB !== 'undefined';
  try {
    const data = await client.get<T>(path); if (can) void idbPut('cache', KEY(who, path), { at: Date.now(), data } satisfies Saved<T>).catch(() => undefined); return { data, stale: false };
  } catch (e) {
    if (e instanceof ApiError && e.status !== 0) throw e; // the server answered: believe it
    if (!can) throw e; const hit = await idbGet<Saved<T>>('cache', KEY(who, path)).catch(() => undefined);
    if (!hit) throw e; return { data: hit.data, stale: true, savedAt: hit.at };
  }
}
export async function clearCache(userId?: string) {
  const all = await idbAll('cache').catch(() => []); await Promise.all(all.filter((x) => !userId || x.key.startsWith(`${userId}|`)).map((x) => idbDelete('cache', x.key)));
}
