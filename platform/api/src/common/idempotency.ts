import { CallHandler, ConflictException, ExecutionContext, HttpException, Injectable, NestInterceptor, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { PrismaService } from './prisma.service';
import { canonical } from '../domain/audit-chain';
import { metrics } from '../platform/metrics';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;
const TTL_MS = () => Number(process.env.IDEMPOTENCY_TTL_HOURS ?? 24) * 3_600_000;
const STALE_MS = () => Number(process.env.IDEMPOTENCY_STALE_MS ?? 120_000);
const MAX_BODY = 256 * 1024;

/**
 * Opt-in replay protection for any mutating call carrying `Idempotency-Key` (mobile clients on poor networks retry blindly).
 *  - first request runs and its response is stored;
 *  - the same key + same request replays the stored response (header `Idempotent-Replay: true`) and the handler is NOT run again;
 *  - the same key with a different request is 422; the same key while the first is still running is 409;
 *  - a failed first attempt releases the key so the client can retry; a crashed one is taken over after IDEMPOTENCY_STALE_MS.
 * Scoped per authenticated actor, so one user's key can never replay another's response. Only JSON requests/responses are covered;
 * raw-body uploads pass through (they are already content-addressed and checksum-verified).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest(), res = ctx.switchToHttp().getResponse();
    const raw = req.headers['idempotency-key'];
    if (!MUTATING.has(req.method) || raw === undefined) return next.handle();
    if (typeof raw !== 'string' || !KEY.test(raw)) throw new UnprocessableEntityException({ error: 'bad_idempotency_key', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-:.]' });
    if (!String(req.headers['content-type'] ?? 'application/json').includes('json') && Number(req.headers['content-length'] ?? 0) > 0) return next.handle();
    return from(this.begin(req, raw)).pipe(mergeMap((st) => {
      if (st.replay) { res.status(st.replay.status); res.setHeader('Idempotent-Replay', 'true'); metrics.inc('idempotent_replays_total', {}, 1, 'Requests answered from the idempotency store'); return of(st.replay.body); }
      return next.handle().pipe(
        mergeMap((body) => from(this.finish(st.id!, this.statusOf(ctx, req), body)).pipe(mergeMap(() => of(body)))),
        catchError((e) => from(this.release(st.id!)).pipe(mergeMap(() => throwError(() => e)))));
    }));
  }

  /** Nest applies the status code after interceptors run, so derive it the way Nest will: @HttpCode(), else 201 for POST, else 200. */
  private statusOf(ctx: ExecutionContext, req: any): number {
    return Reflect.getMetadata('__httpCode__', ctx.getHandler()) ?? (req.method === 'POST' ? 201 : 200);
  }

  private async begin(req: any, key: string): Promise<{ id?: string; replay?: { status: number; body: any } }> {
    const actorId: string = req.actor?.id ?? '';
    const path = String(req.originalUrl ?? req.url).split('?')[0];
    const requestHash = createHash('sha256').update(`${req.method} ${path}\n${canonical(req.body ?? null)}`).digest('hex');
    const mk = () => this.prisma.idempotencyKey.create({ data: { actorId, key, method: req.method, path, requestHash, expiresAt: new Date(Date.now() + TTL_MS()) } });
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return { id: (await mk()).id }; }
      catch (e: any) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const cur = await this.prisma.idempotencyKey.findUnique({ where: { actorId_key: { actorId, key } } });
        if (!cur) continue; // released between our insert and read: retry the insert
        // an attempt that never completed (crashed worker) protects nothing: take the key over before comparing requests
        if (cur.state === 'IN_PROGRESS' && (cur.expiresAt.getTime() < Date.now() || cur.createdAt.getTime() < Date.now() - STALE_MS())) { await this.prisma.idempotencyKey.deleteMany({ where: { id: cur.id, state: 'IN_PROGRESS' } }); continue; }
        if (cur.requestHash !== requestHash) throw new UnprocessableEntityException({ error: 'idempotency_key_reuse', message: 'This Idempotency-Key was used with a different request' });
        if (cur.state === 'DONE') return { replay: { status: cur.status ?? 200, body: cur.body } };
        throw new HttpException({ error: 'request_in_progress', message: 'The original request is still being processed; retry shortly' }, 409);
      }
    }
    throw new ConflictException('idempotency key contention');
  }

  private async finish(id: string, status: number, body: any) {
    let json: any; try { json = body === undefined ? null : JSON.parse(JSON.stringify(body)); } catch { json = undefined; }
    if (json === undefined || JSON.stringify(json).length > MAX_BODY || typeof body === 'string' && body.length > MAX_BODY) { await this.release(id); return; } // not replayable: do not pretend it is
    await this.prisma.idempotencyKey.update({ where: { id }, data: { state: 'DONE', status, body: json ?? Prisma.JsonNull } });
  }
  private async release(id: string) { await this.prisma.idempotencyKey.deleteMany({ where: { id } }); }
}
