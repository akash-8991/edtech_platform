import { redis } from './redis';
import { metrics } from './metrics';

export interface Take { allowed: boolean; remaining: number; resetMs: number; limit: number }
/**
 * Fixed-window counter per key. In-process: correct for one instance; behind a load balancer each instance enforces its own share, so
 * limits should be set to (target / instances) or the store swapped for Redis (same interface). Documented in the capacity plan.
 */
export class RateLimiter {
  private w = new Map<string, { n: number; reset: number }>();
  private timer?: NodeJS.Timeout;
  constructor(private now: () => number = Date.now) { this.timer = setInterval(() => this.gc(), 60_000); this.timer.unref?.(); }
  take(key: string, limit: number, windowMs = 60_000): Take {
    const t = this.now(); let e = this.w.get(key);
    if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; this.w.set(key, e); }
    e.n++;
    return { allowed: e.n <= limit, remaining: Math.max(0, limit - e.n), resetMs: e.reset - t, limit };
  }
  private gc() { const t = this.now(); for (const [k, e] of this.w) if (e.reset <= t) this.w.delete(k); if (this.w.size > 200_000) this.w.clear(); /* hard cap against key flooding */ }
  size() { return this.w.size; }
  close() { if (this.timer) clearInterval(this.timer); }
}
const local = new RateLimiter();

// Atomic fixed window: INCR, set expiry on first hit, return count and remaining TTL.
const LUA = `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return {n, redis.call('PTTL', KEYS[1])}`;

/**
 * Facade used by the app. With REDIS_URL every instance shares one counter, so limits mean what they say behind a load balancer.
 * If Redis is unreachable we degrade to the per-instance limiter (fail-soft, counted in redis_fallback_total) rather than take the API down.
 */
export const limiter = {
  async take(key: string, limit: number, windowMs = 60_000): Promise<Take> {
    const r = redis();
    if (r) {
      try {
        const [n, ttl] = (await r.eval(LUA, 1, `rl:${key}`, String(windowMs))) as [number, number];
        return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetMs: ttl > 0 ? ttl : windowMs, limit };
      } catch { metrics.inc('redis_fallback_total', { use: 'ratelimit' }, 1, 'Operations that fell back to in-process state'); }
    }
    return local.take(key, limit, windowMs);
  },
  size: () => local.size(),
};
const num = (n: string | undefined, d: number) => (n && Number.isFinite(Number(n)) ? Number(n) : d);
export const limits = () => ({ disabled: process.env.RATE_LIMIT_DISABLED === '1', ip: num(process.env.RL_IP_PER_MIN, 3000), actor: num(process.env.RL_ACTOR_PER_MIN, 1200), login: num(process.env.RL_LOGIN_PER_MIN, 20) });
