import { createCipheriv, createDecipheriv, createHmac, createPublicKey, publicEncrypt, randomBytes, constants, timingSafeEqual } from 'crypto';

// ---- Signed playback tokens (CDN-token stand-in; same contract: key + expiry + HMAC) -------------------
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signToken(secret: string, claims: { k: string; exp: number; sub?: string; n?: string }): string {
  const body = b64u(JSON.stringify(claims));
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyToken(secret: string, token: string, now = Date.now()): { k: string; exp: number; sub?: string; n?: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const exp = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return null;
  const c = JSON.parse(Buffer.from(body, 'base64url').toString());
  return c.exp > now ? c : null;
}

// ---- Offline packaging: AES-256-GCM content encryption + key wrapping -------------------------------
export function encryptBuffer(plain: Buffer) {
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { key, iv, tag: c.getAuthTag(), data };
}

export function decryptBuffer(data: Buffer, key: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

/** Server master key wraps content keys at rest (AES-256-GCM; production: KMS/HSM). */
export function wrapWithMaster(master: Buffer, key: Buffer): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', master, iv);
  const ct = Buffer.concat([c.update(key), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function unwrapWithMaster(master: Buffer, wrapped: string): Buffer {
  const b = Buffer.from(wrapped, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

/** Device-bound: only the holder of the device private key can recover the content key. */
export const wrapForDevice = (publicKeyPem: string, key: Buffer): string =>
  publicEncrypt({ key: createPublicKey(publicKeyPem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64');
