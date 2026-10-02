import { HttpException, Injectable, NestMiddleware } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { accessLog } from './logger';
import { limiter, limits } from './ratelimit';
import { metrics } from './metrics';
import { newTrace, runWithTrace } from './trace';

/** Inside Nest middleware req.path/url are relative to the mount point; the real path is originalUrl. */
const pathOf = (req: any): string => String(req.originalUrl ?? req.url ?? '').split('?')[0];
const REQUEST_LOG = () => process.env.REQUEST_LOG === '1' || (process.env.NODE_ENV === 'production' && process.env.REQUEST_LOG !== '0');

/** Correlation id, hardened response headers, access log and RED metrics for every request. */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    const cid = typeof req.headers['x-correlation-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-correlation-id']) ? req.headers['x-correlation-id'] : randomBytes(8).toString('hex');
    req.correlationId = cid; res.setHeader('X-Correlation-Id', cid);
    const trace = newTrace({ traceparent: req.headers.traceparent, correlationId: cid }); req.traceId = trace.traceId; res.setHeader('X-Trace-Id', trace.traceId);
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!pathOf(req).startsWith('/v1/media/stream/')) res.setHeader('Cache-Control', 'no-store'); // API responses (grades, exams, PII) must never be cached by shared proxies
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6; const route: string = req.route?.path ?? 'unmatched'; // template, not the raw URL: bounded label cardinality
      metrics.inc('http_requests_total', { method: req.method, route, status: String(res.statusCode) }, 1, 'HTTP requests');
      metrics.observe('http_request_duration_seconds', { method: req.method, route }, ms / 1000, 'HTTP request latency');
      if (REQUEST_LOG() && route !== '/health' && route !== '/metrics') accessLog({ method: req.method, route, status: res.statusCode, ms: Math.round(ms * 10) / 10, cid, traceId: trace.traceId, actor: req.actor?.id, ip: req.ip });
    });
    runWithTrace(trace, next); // everything downstream (guards, handlers, outbound calls) sees this trace
  }
}

/** Exact-origin allow-list; never a wildcard, never credentials for unknown origins. */
@Injectable()
export class CorsMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      const allowed = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      res.setHeader('Vary', 'Origin');
      if (allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Correlation-Id, X-Exam-Session, X-Checksum-Sha256, Idempotency-Key, traceparent');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS'); res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id, X-Trace-Id, Retry-After, X-Next-Cursor, Idempotent-Replay'); res.setHeader('Access-Control-Max-Age', '600');
      } else if (req.method === 'OPTIONS') { res.statusCode = 403; return res.end(); }
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    next();
  }
}

/** Coarse per-IP limiter in front of everything (also covers unauthenticated floods and invalid-token spam). */
@Injectable()
export class IpRateLimitMiddleware implements NestMiddleware {
  async use(req: any, res: any, next: () => void) {
    const l = limits(); const path = pathOf(req); if (l.disabled || path === '/health' || path === '/health/ready') return next();
    const t = await limiter.take(`ip:${req.ip}`, l.ip);
    if (!t.allowed) { res.setHeader('Retry-After', Math.ceil(t.resetMs / 1000)); metrics.inc('rate_limited_total', { scope: 'ip' }, 1, 'Requests rejected by rate limiting'); throw new HttpException({ error: 'rate_limited', message: 'Too many requests' }, 429); }
    next();
  }
}
