import { idbGet, idbPut } from './idb';

/**
 * Device-bound lesson keys. The server wraps each lesson's AES key with this device's RSA public key (RSA-OAEP, SHA-256), so a copied
 * download is useless elsewhere. The private key is generated here as NON-EXTRACTABLE and kept in IndexedDB: scripts can use it but cannot read it.
 */
const subtle = () => globalThis.crypto.subtle;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const RSA = { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' } as const;

export interface DeviceKeys { deviceId: string; publicKeyPem: string; privateKey: CryptoKey }
export const toPem = (spki: ArrayBuffer) => `-----BEGIN PUBLIC KEY-----\n${toB64(spki).match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;

export async function deviceKeys(): Promise<DeviceKeys> {
  const saved = await idbGet<DeviceKeys>('kv', 'device');
  if (saved?.privateKey && saved.publicKeyPem && saved.deviceId) return saved;
  const pair = await subtle().generateKey(RSA, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']) as CryptoKeyPair; // private key non-extractable; the public key is always exportable
  const keys: DeviceKeys = { deviceId: globalThis.crypto.randomUUID(), publicKeyPem: toPem(await subtle().exportKey('spki', pair.publicKey)), privateKey: pair.privateKey };
  await idbPut('kv', 'device', keys); return keys;
}

/** Unwraps the lesson key and decrypts. `data` is the ciphertext without the tag; AES-GCM wants ciphertext followed by the tag. */
export async function decryptLesson(o: { data: ArrayBuffer; wrappedKey: string; iv: string; tag: string }, privateKey: CryptoKey): Promise<ArrayBuffer> {
  const raw = await subtle().decrypt({ name: 'RSA-OAEP' }, privateKey, b64(o.wrappedKey));
  const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const tag = b64(o.tag); const joined = new Uint8Array(o.data.byteLength + tag.length); joined.set(new Uint8Array(o.data)); joined.set(tag, o.data.byteLength);
  return subtle().decrypt({ name: 'AES-GCM', iv: b64(o.iv), tagLength: 128 }, key, joined);
}
