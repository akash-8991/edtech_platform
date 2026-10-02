// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) with replay protection, plus password policy. Pure and unit-tested against the RFC vectors.
import { createHash, createHmac, randomBytes } from 'crypto';

const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(b: Buffer): string { let bits = 0, v = 0, out = ''; for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += A[(v << (5 - bits)) & 31]; return out; }
export function base32Decode(s: string): Buffer { let bits = 0, v = 0; const out: number[] = []; for (const c of s.replace(/=+$/, '').toUpperCase()) { const i = A.indexOf(c); if (i < 0) throw new Error('bad base32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(b).digest(); const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export const stepOf = (nowMs: number, period = 30) => Math.floor(nowMs / 1000 / period);
export const totp = (secret: Buffer, nowMs = Date.now()) => hotp(secret, stepOf(nowMs));

/** Returns the matched step (so the caller can store it and refuse reuse) or null. Window is +/-1 step (clock drift). */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = stepOf(nowMs); let hit: number | null = null;
  for (const d of [-1, 0, 1]) { const st = cur + d; const ok = hotp(secret, st) === code; if (ok && hit === null && st > lastUsedStep) hit = st; } // no early exit: constant work
  return hit;
}
export const newSecret = () => randomBytes(20);
export const otpauthUri = (issuer: string, account: string, secretB32: string) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

export const newBackupCodes = (n = 8) => Array.from({ length: n }, () => { const c = base32Encode(randomBytes(7)).slice(0, 10); return `${c.slice(0, 5)}-${c.slice(5)}`; });
export const hashBackup = (code: string) => createHash('sha256').update(code.replace(/-/g, '').toUpperCase()).digest('hex');

const COMMON = new Set(['password1234', 'passw0rd1234', 'qwertyuiop12', 'letmein12345', 'welcome12345', 'admin1234567', 'iloveyou1234', '123456789012', 'changeme1234', 'password@123']);
export function passwordIssues(pw: string, email = ''): string[] {
  const i: string[] = [];
  if (typeof pw !== 'string' || pw.length < 12) i.push('at least 12 characters'); if (pw.length > 200) i.push('at most 200 characters');
  if (new Set(pw).size < 6) i.push('too repetitive'); if (COMMON.has(pw.toLowerCase())) i.push('too common');
  const local = email.split('@')[0]?.toLowerCase(); if (local && local.length >= 4 && pw.toLowerCase().includes(local)) i.push('must not contain your email name');
  if (!/[a-z]/i.test(pw) || !/\d|[^a-z0-9]/i.test(pw)) i.push('mix letters with digits or symbols');
  return i;
}
