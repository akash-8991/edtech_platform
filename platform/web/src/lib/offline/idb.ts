/** A very small promise wrapper over IndexedDB: one database, a few object stores, get/put/delete/all. Enough for downloads and a read cache. */
const DB = 'edtech-offline'; const VERSION = 1;
export const STORES = ['kv', 'lessons', 'blobs', 'cache'] as const;
export type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | null = null;
export function openDb(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
  opening ??= new Promise((resolve, reject) => {
    const r = factory.open(DB, VERSION);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); opening = null; }; resolve(r.result); };
    r.onerror = () => { opening = null; reject(r.error); }; r.onblocked = () => { opening = null; reject(new Error('database blocked')); };
  });
  return opening;
}
/** Test hook: forget the open connection (a fresh fake database per test). */
export const resetDb = () => { opening = null; };

const run = async <T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => { const tx = db.transaction(store, mode); const req = fn(tx.objectStore(store)); tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('aborted')); });
};
export const idbGet = <T = unknown>(store: Store, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key));
export const idbPut = (store: Store, key: string, value: unknown) => run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined);
export const idbDelete = (store: Store, key: string) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
export const idbClear = (store: Store) => run(store, 'readwrite', (s) => s.clear()).then(() => undefined);
export async function idbAll<T = unknown>(store: Store): Promise<{ key: string; value: T }[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out: { key: string; value: T }[] = []; const tx = db.transaction(store, 'readonly'); const c = tx.objectStore(store).openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ key: String(cur.key), value: cur.value as T }); cur.continue(); } };
    tx.oncomplete = () => resolve(out); tx.onerror = () => reject(tx.error);
  });
}
