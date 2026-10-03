import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { appendFileSync } from 'fs';
import { tap } from 'rxjs';

/**
 * Keeps docs/openapi.json honest. In tests (CONTRACT_ENFORCE=1) every successful response, and the request body that produced it, is
 * validated against the declared contract, so a handler that drifts from its schema fails the suite. With OPENAPI_RECORD=<file> the
 * observed traffic is also written out as JSON lines (used by scripts/infer-contracts.ts to draft schemas for new routes).
 * Off in production: no cost, no behaviour change.
 */
const on = () => process.env.CONTRACT_ENFORCE === '1' || !!process.env.OPENAPI_RECORD;
const plain = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

@Injectable()
export class ContractInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (!on() || ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest(); const handler = ctx.getHandler();
    const path = req.route?.path as string | undefined; if (!path) return next.handle();
    const key = `${req.method} ${path}`; const status: number = Reflect.getMetadata('__httpCode__', handler) ?? (req.method === 'POST' ? 201 : 200);
    return next.handle().pipe(tap((data) => {
      if (data === undefined || data === null || Buffer.isBuffer(data) || typeof data?.pipe === 'function') return;
      const res = plain(data); const body = plain(req.body); const query = plain(req.query);
      if (process.env.OPENAPI_RECORD) { try { const line = JSON.stringify({ k: key, s: status, q: query, b: body, r: res }); if (line.length < 400_000) appendFileSync(process.env.OPENAPI_RECORD, line + '\n'); } catch { /* recording must never break a request */ } }
      if (process.env.CONTRACT_ENFORCE === '1') {
        const problems = require('./contracts').checkExchange(key, status, body, res) as string[];
        if (problems.length) throw new Error(`API contract violation for ${key} (${status}):\n - ${problems.join('\n - ')}`);
      }
    }));
  }
}
