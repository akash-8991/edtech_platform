import Redis from 'ioredis';
import { metrics } from './metrics';

/**
 * Shared state for horizontally scaled instances (rate limits, session-revocation fan-out). Optional in dev/test (in-process fallback);
 * REQUIRED in production by the config guard. Lazy so importing this file never opens a socket.
 */
let client: Redis | null | undefined;
export function redis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) return (client = null);
  client = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, lazyConnect: false });
  client.on('error', () => metrics.inc('redis_errors_total', {}, 1, 'Redis client errors'));
  return client;
}
/** A dedicated connection is required for SUBSCRIBE. */
export function redisSubscriber(): Redis | null { const r = redis(); return r ? r.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null }) : null; }
export async function closeRedis() { if (client) { const c = client; client = undefined; await c.quit().catch(() => c.disconnect()); } }
export function redisConfigured() { return !!process.env.REDIS_URL; }
