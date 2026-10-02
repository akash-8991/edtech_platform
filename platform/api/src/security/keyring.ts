import { createHash } from 'crypto';
import { unwrapWithMaster, verifyToken, wrapWithMaster } from '../domain/media-crypto';

/**
 * Rotation model for every secret: `NAME` is the current value (used to sign / encrypt); `NAME_PREVIOUS` is an optional comma-separated
 * list of retired values still accepted for verification / decryption during the overlap window. Rotate = move current into
 * NAME_PREVIOUS, set a new NAME, deploy, (for stored ciphertext) run scripts/rotate-keys.ts, then drop NAME_PREVIOUS.
 * The dev fallback exists only outside production; the production guard additionally refuses to boot without real values.
 */
const FALLBACK = 'dev-only';
const isProd = () => process.env.NODE_ENV === 'production';

export function secretsFor(name: string, ...fallbackNames: string[]): { current: string; all: string[] } {
  const own = process.env[name] || fallbackNames.map((n) => process.env[n]).find(Boolean);
  if (!own && isProd()) throw new Error(`${name} is not configured`);
  const current = own ?? FALLBACK;
  const prev = (process.env[`${name}_PREVIOUS`] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { current, all: [current, ...prev.filter((p) => p !== current)] };
}
export const jwtSecrets = () => secretsFor('JWT_SECRET');
export const mediaSecrets = () => secretsFor('MEDIA_TOKEN_SECRET', 'JWT_SECRET');
export const labSecrets = () => secretsFor('LAB_QR_SECRET', 'JWT_SECRET');

/** Verify a signed token against current then retired secrets. */
export function verifyAny(secrets: string[], token: string) { for (const s of secrets) { const c = verifyToken(s, token); if (c) return c; } return null; }

/** Verify a JWT against current then retired secrets; only signature failures fall through to the next key. */
export async function verifyJwt(jwt: { verifyAsync(t: string, o?: any): Promise<any> }, token: string): Promise<any> {
  const keys = jwtSecrets().all; let last: any;
  for (const secret of keys) {
    try { return await jwt.verifyAsync(token, { secret }); }
    catch (e: any) { last = e; if (e?.message !== 'invalid signature') throw e; }
  }
  throw last;
}

// ---- data-at-rest keys (64-hex AES-256) ----------------------------------------------------------------------------------------------------------
const hexKeys = (name: string): Buffer[] => {
  const cur = process.env[name];
  const list = [cur, ...(process.env[`${name}_PREVIOUS`] ?? '').split(',')].map((s) => s?.trim()).filter((s): s is string => !!s && /^[0-9a-f]{64}$/i.test(s));
  return list.map((h) => Buffer.from(h, 'hex'));
};
/** DATA_ENC_KEY (current first). Dev derives one from JWT_SECRET so local runs work without key material. */
export const dataKeys = (): Buffer[] => { const k = hexKeys('DATA_ENC_KEY'); return k.length ? k : [createHash('sha256').update(`data-enc:${process.env.JWT_SECRET ?? FALLBACK}`).digest()]; };
export const masterKeys = (): Buffer[] => { const k = hexKeys('OFFLINE_MASTER_KEY'); return k.length ? k : [Buffer.from('00'.repeat(32), 'hex')]; };

export const sealWith = (keys: Buffer[], plain: Buffer) => wrapWithMaster(keys[0], plain);
export function openWith(keys: Buffer[], sealed: string): Buffer {
  let last: any;
  for (const k of keys) { try { return unwrapWithMaster(k, sealed); } catch (e) { last = e; } } // GCM auth failure = wrong key, try the next
  throw last;
}
export const needsRotation = (keys: Buffer[], sealed: string) => { try { unwrapWithMaster(keys[0], sealed); return false; } catch { return true; } };
