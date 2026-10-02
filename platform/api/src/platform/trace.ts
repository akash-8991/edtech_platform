import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import { metrics } from './metrics';

/**
 * Lightweight W3C trace-context propagation (no vendor SDK): every request/job carries a trace id; every call to an external system
 * (AI provider, proctoring vendor, embeddings, IdP, object store, scanner, sandbox) is a child span with its own metric and structured
 * log line, and the `traceparent` header is forwarded so a vendor or APM that understands W3C context can join the trace.
 * Logs, access logs and spans share `traceId`, so one id finds a learner-facing failure and the vendor call behind it.
 */
export interface TraceCtx { traceId: string; spanId: string; parentSpanId?: string; correlationId?: string; actorId?: string; sampled: boolean }
const als = new AsyncLocalStorage<TraceCtx>();
const hex = (n: number) => randomBytes(n).toString('hex');
const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(h: unknown): { traceId: string; parentSpanId: string; sampled: boolean } | null {
  const m = typeof h === 'string' ? TP.exec(h.trim()) : null;
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], parentSpanId: m[2], sampled: (parseInt(m[3], 16) & 1) === 1 };
}
export const formatTraceparent = (c: Pick<TraceCtx, 'traceId' | 'spanId' | 'sampled'>) => `00-${c.traceId}-${c.spanId}-${c.sampled ? '01' : '00'}`;

export const currentTrace = () => als.getStore();
export function newTrace(o: { traceparent?: unknown; correlationId?: string } = {}): TraceCtx {
  const p = parseTraceparent(o.traceparent);
  return { traceId: p?.traceId ?? hex(16), spanId: hex(8), parentSpanId: p?.parentSpanId, correlationId: o.correlationId, sampled: p?.sampled ?? true };
}
export const runWithTrace = <T>(ctx: TraceCtx, fn: () => T): T => als.run(ctx, fn);
export const setActor = (id: string) => { const c = als.getStore(); if (c) c.actorId = id; };

/** Headers to attach to an outbound request made inside a span. */
export function traceHeaders(): Record<string, string> {
  const c = als.getStore(); if (!c) return {};
  return { traceparent: formatTraceparent(c), ...(c.correlationId && { 'x-correlation-id': c.correlationId }) };
}

const spanLog = () => process.env.SPAN_LOG === '1' || (process.env.NODE_ENV === 'production' && process.env.SPAN_LOG !== '0');

/** Runs `fn` as a child span of the current trace. Records duration/outcome metrics and (optionally) a span log line. Never changes fn's result or error. */
export async function external<T>(service: string, op: string, fn: () => Promise<T>): Promise<T> {
  const parent = als.getStore();
  const span: TraceCtx = { traceId: parent?.traceId ?? hex(16), spanId: hex(8), parentSpanId: parent?.spanId, correlationId: parent?.correlationId, actorId: parent?.actorId, sampled: parent?.sampled ?? true };
  const t0 = process.hrtime.bigint(); let outcome = 'ok';
  try { return await als.run(span, fn); }
  catch (e: any) { outcome = e?.name === 'TimeoutError' || e?.code === 'timeout' ? 'timeout' : 'error'; throw e; }
  finally {
    const s = Number(process.hrtime.bigint() - t0) / 1e9;
    metrics.inc('external_calls_total', { service, op, outcome }, 1, 'Calls to external systems');
    metrics.observe('external_call_duration_seconds', { service, op }, s, 'Latency of calls to external systems');
    if (spanLog() && span.sampled) process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', ctx: 'span', traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, service, op, ms: Math.round(s * 1000), outcome }) + '\n');
  }
}
