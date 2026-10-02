import { base32Decode, base32Encode, hashBackup, hotp, newBackupCodes, otpauthUri, passwordIssues, stepOf, totp, verifyTotp } from './totp';

describe('TOTP (RFC 4226 / 6238 vectors)', () => {
  const key = Buffer.from('12345678901234567890');
  it('HOTP matches RFC 4226 appendix D', () => { expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']); });
  it('TOTP matches RFC 6238 SHA1 vectors (8 digits truncated to 6)', () => {
    for (const [t, exp] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']] as [number, string][]) expect(hotp(key, stepOf(t * 1000), 8)).toBe(exp);
  });
  it('base32 round-trips and rejects junk', () => { const b = Buffer.from('hello world 12345'); expect(base32Decode(base32Encode(b))).toEqual(b); expect(() => base32Decode('1!')).toThrow(); });
  it('accepts +/-1 step of drift, refuses reuse of a step and codes from further away', () => {
    const t = 1_700_000_000_000; const code = totp(key, t); const step = stepOf(t);
    expect(verifyTotp(key, code, t, 0)).toBe(step); expect(verifyTotp(key, code, t + 30_000, 0)).toBe(step); expect(verifyTotp(key, code, t - 30_000, 0)).toBe(step);
    expect(verifyTotp(key, code, t + 90_000, 0)).toBeNull(); expect(verifyTotp(key, code, t, step)).toBeNull(); // replay
    expect(verifyTotp(key, '12345', t, 0)).toBeNull(); expect(verifyTotp(key, 'abcdef', t, 0)).toBeNull();
  });
  it('backup codes are unique, hash stably regardless of formatting; otpauth URI is well-formed', () => {
    const c = newBackupCodes(); expect(new Set(c).size).toBe(8); expect(c[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/); expect(hashBackup(c[0])).toBe(hashBackup(c[0].toLowerCase().replace('-', '')));
    expect(otpauthUri('EdTech', 'a@b.c', 'ABC')).toBe('otpauth://totp/EdTech:a%40b.c?secret=ABC&issuer=EdTech&algorithm=SHA1&digits=6&period=30');
  });
});

describe('password policy', () => {
  it('requires length, variety and rejects weak/guessable passwords', () => {
    expect(passwordIssues('Tr0ub4dor&3xyz', 'a@b.c')).toEqual([]); expect(passwordIssues('short1')).toContain('at least 12 characters'); expect(passwordIssues('aaaaaaaaaaaa1')).toContain('too repetitive');
    expect(passwordIssues('Password1234')).toContain('too common'); expect(passwordIssues('onlyletterslong')).toContain('mix letters with digits or symbols'); expect(passwordIssues('priyasharma-2026!', 'priyasharma@x.com')).toContain('must not contain your email name');
  });
});
