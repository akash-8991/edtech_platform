import { createHash } from 'crypto';
import { dataKeys, openWith, sealWith } from './keyring';

/** Secrets stored in the database (TOTP seeds) are sealed under DATA_ENC_KEY (current) and opened under current or retired keys (keyring). */
export const sealSecret = (b: Buffer) => sealWith(dataKeys(), b);
export const openSecret = (s: string) => openWith(dataKeys(), s);
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
