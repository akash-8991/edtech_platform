import { createHash } from 'crypto';

export const GENESIS = '0'.repeat(64);

// Stable canonical JSON (sorted keys) so the hash is reproducible on verification.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export const chainHash = (prev: string, payload: unknown) =>
  createHash('sha256').update(prev).update(canonical(payload)).digest('hex');

/** Incremental verifier: feed rows in order, memory stays O(1). `broken` is the index of the first bad row. */
export class ChainVerifier {
  private prev = GENESIS; private i = 0; broken: number | null = null;
  push(r: { prevHash: string; hash: string; payload: unknown }) {
    if (this.broken === null && (r.prevHash !== this.prev || chainHash(this.prev, r.payload) !== r.hash)) this.broken = this.i;
    this.prev = r.hash; this.i++;
  }
  get count() { return this.i; }
}

export function verifyChain(rows: { prevHash: string; hash: string; payload: unknown }[]): number | null {
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].prevHash !== prev || chainHash(prev, rows[i].payload) !== rows[i].hash) return i;
    prev = rows[i].hash;
  }
  return null; // intact
}
