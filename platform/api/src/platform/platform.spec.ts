import { redact } from './logger';
import { RateLimiter } from './ratelimit';
import { productionConfigProblems } from './config-guard';
import { Metrics } from './metrics';

describe('log redaction', () => {
  it('removes emails, phones, Aadhaar/PAN-shaped numbers and tokens', () => {
    const r = redact('user a.b@x.com called +91 98765 43210? id 1234 5678 9012 pan ABCDE1234F Authorization: Bearer abc.def.ghi jwt eyJhbGciOi.eyJzdWIiOi.sig');
    expect(r).not.toMatch(/a\.b@x\.com|9876543210|1234 5678|ABCDE1234F|abc\.def|eyJhbGci/); expect(r).toMatch(/\[email\]/); expect(r).toMatch(/\[jwt\]/);
  });
});

describe('rate limiter', () => {
  it('counts per key within a window, resets after it, and reports retry time', () => {
    let t = 0; const l = new RateLimiter(() => t);
    expect([1, 2, 3].map(() => l.take('a', 2, 1000).allowed)).toEqual([true, true, false]); expect(l.take('b', 2, 1000).allowed).toBe(true); expect(l.take('a', 2, 1000).resetMs).toBe(1000);
    t = 1001; expect(l.take('a', 2, 1000)).toMatchObject({ allowed: true, remaining: 1 }); l.close();
  });
});

describe('production config guard', () => {
  const good = { DATABASE_URL: 'postgresql://u:p@db/x', JWT_SECRET: 'k'.repeat(10) + 'A1b2C3d4E5f6G7h8I9j0K1l2', ADMISSIONS_HMAC_SECRET: 'Zq9'.repeat(12), MEDIA_TOKEN_SECRET: 'Mq9'.repeat(12), EXAM_RECEIPT_SECRET: 'Eq9'.repeat(12), LAB_QR_SECRET: 'Lq9'.repeat(12), METRICS_TOKEN: 'Tq9'.repeat(10), OFFLINE_MASTER_KEY: 'a1b2c3d4'.repeat(8), DATA_ENC_KEY: 'f1e2d3c4'.repeat(8), CORS_ORIGINS: 'https://app.example', REDIS_URL: 'redis://r:6379', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_KMS_KEY_ID: 'k', SCANNER: 'clamav', CLAMD_HOST: 'c', PROCESS_ROLE: 'api' } as any;
  it('accepts a complete configuration', () => { expect(productionConfigProblems(good)).toEqual([]); });
  it('rejects missing, short and placeholder secrets and unsafe flags', () => {
    const p = productionConfigProblems({ JWT_SECRET: 'change-me-dev-only', OFFLINE_MASTER_KEY: '00'.repeat(32), MFA_ENFORCE: '0', RATE_LIMIT_DISABLED: '1', PROCTOR_BASE_URL: 'https://v' } as any).join('|');
    for (const s of ['REDIS_URL', 'STORAGE_DRIVER', 'SCANNER', 'PROCESS_ROLE', 'DATABASE_URL is not set', 'JWT_SECRET', 'placeholder', 'OFFLINE_MASTER_KEY', 'MFA_ENFORCE=0', 'RATE_LIMIT_DISABLED=1', 'PROCTOR_API_KEY', 'CORS_ORIGINS', 'METRICS_TOKEN']) expect(p).toContain(s);
  });
});

describe('metrics registry', () => {
  it('renders counters, histograms and escapes label values; a failing gauge cannot break the scrape', async () => {
    const m = new Metrics(); m.inc('x_total', { route: '/a"b' }, 2); m.observe('lat_seconds', { route: '/r' }, 0.03); m.gauge('bad', 'h', () => { throw new Error('db down'); }); m.gauge('good', 'h', () => [{ value: 7 }]);
    const t = await m.render(); expect(t).toContain('x_total{route="/a\\"b"} 2'); expect(t).toContain('lat_seconds_bucket{route="/r",le="0.05"} 1'); expect(t).toContain('lat_seconds_count{route="/r"} 1'); expect(t).toContain('good 7'); expect(t).toContain('nodejs_eventloop_lag_p99_seconds');
  });
});
