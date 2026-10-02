/**
 * Keyset pagination for list endpoints. The body stays a plain array (clients unchanged); the continuation token is returned in the
 * `X-Next-Cursor` header, absent on the last page. Ordering must be stable and end in `id`.
 */
export const PAGE_DEFAULT = 50, PAGE_MAX = 200;
export const pageSize = (limit: string | undefined, def = PAGE_DEFAULT, max = PAGE_MAX) => Math.min(max, Math.max(1, Math.floor(Number(limit)) || def));

export async function paged<T extends { id: string }>(res: { setHeader(k: string, v: string): any }, limit: string | undefined, cursor: string | undefined,
  run: (args: { take: number; cursor?: { id: string }; skip?: number }) => Promise<T[]>, def = PAGE_DEFAULT, max = PAGE_MAX): Promise<T[]> {
  const n = pageSize(limit, def, max);
  const rows = await run({ take: n + 1, ...(cursor && { cursor: { id: cursor }, skip: 1 }) });
  if (rows.length > n) { res.setHeader('X-Next-Cursor', rows[n - 1].id); return rows.slice(0, n); }
  return rows;
}
