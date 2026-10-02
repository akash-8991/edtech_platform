import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret'; process.env.METRICS_TOKEN = 'metrics-token-1234567890abcd';
import { AppModule } from '../src/app.module';
import { external, formatTraceparent, newTrace, parseTraceparent, runWithTrace, traceHeaders } from '../src/platform/trace';
import { metrics } from '../src/platform/metrics';
import { HttpProctor } from '../src/proctoring/provider';
import { OpenRouterEmbedder } from '../src/ai/embeddings';
import { IntegrityService } from '../src/ops/integrity';

describe('trace context', () => {
  const T = '4bf92f3577b34da6a3ce929d0e0e4736', S = '00f067aa0ba902b7';
  it('parses and formats W3C traceparent; rejects malformed and all-zero ids', () => {
    expect(parseTraceparent(`00-${T}-${S}-01`)).toEqual({ traceId: T, parentSpanId: S, sampled: true });
    expect(parseTraceparent(`00-${T}-${S}-00`)?.sampled).toBe(false);
    for (const bad of [undefined, '', 'garbage', `00-${'0'.repeat(32)}-${S}-01`, `00-${T}-${'0'.repeat(16)}-01`, `01-${T}-${S}-01`, `00-${T.toUpperCase()}-${S}-01`, `00-${T}-${S}-01-extra`]) expect(parseTraceparent(bad)).toBeNull();
    const c = newTrace({ traceparent: `00-${T}-${S}-01` }); expect(c.traceId).toBe(T); expect(c.parentSpanId).toBe(S); expect(formatTraceparent(c)).toMatch(new RegExp(`^00-${T}-[0-9a-f]{16}-01$`));
  });
  it('external() is a child span: same trace, new span id, metrics recorded for ok / error / timeout, result and error untouched', async () => {
    const root = newTrace({ correlationId: 'cid-1' }); let inner: any;
    const v = await runWithTrace(root, () => external('svcA', 'op1', async () => { inner = traceHeaders(); return 42; }));
    expect(v).toBe(42); expect(inner.traceparent).toMatch(new RegExp(`^00-${root.traceId}-(?!${root.spanId})[0-9a-f]{16}-01$`)); expect(inner['x-correlation-id']).toBe('cid-1');
    await expect(external('svcA', 'op2', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(external('svcA', 'op3', async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); })).rejects.toThrow('t');
    const text = await metrics.render();
    expect(text).toContain('external_calls_total{op="op1",outcome="ok",service="svcA"} 1'); expect(text).toContain('external_calls_total{op="op2",outcome="error",service="svcA"} 1');
    expect(text).toContain('external_calls_total{op="op3",outcome="timeout",service="svcA"} 1'); expect(text).toContain('external_call_duration_seconds_count{op="op1",service="svcA"} 1');
  });
  it('outbound vendor calls carry the caller\'s trace id (proctor + embeddings)', async () => {
    const seen: any[] = [];
    const srv = http.createServer((req, res) => { seen.push(req.headers); res.setHeader('content-type', 'application/json'); res.end(req.url === '/embeddings' ? JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }) : JSON.stringify({ sessionId: 's1', launchUrl: 'https://x' })); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const root = newTrace({ correlationId: 'cid-2' });
      await runWithTrace(root, async () => {
        await new HttpProctor(base, 'k').createSession({ attemptId: 'a1', examCode: 'E', learnerToken: 't', mode: 'REMOTE', startsAt: new Date(), endsAt: new Date() } as any).catch(() => undefined);
        await new OpenRouterEmbedder('k', 'm', base).embed(['x']).catch(() => undefined);
      });
      expect(seen.length).toBe(2);
      for (const h of seen) { expect(h.traceparent).toMatch(new RegExp(`^00-${root.traceId}-[0-9a-f]{16}-01$`)); expect(h['x-correlation-id']).toBe('cid-2'); }
      expect(await metrics.render()).toContain('external_calls_total{op="POST /sessions",outcome="ok",service="proctor"}');
    } finally { srv.close(); }
  });
});

describe('request tracing and scheduled integrity', () => {
  let app: INestApplication; let h: any;
  beforeAll(async () => { const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = mod.createNestApplication({ rawBody: true } as any); await app.init(); h = request(app.getHttpServer()); });
  afterAll(async () => { await app.close(); });
  it('continues an inbound traceparent, mints one otherwise, and exposes it on the response', async () => {
    const T = 'a'.repeat(32);
    expect((await h.get('/health').set('traceparent', `00-${T}-${'b'.repeat(16)}-01`)).headers['x-trace-id']).toBe(T);
    expect((await h.get('/health')).headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    expect((await h.get('/health').set('traceparent', 'junk')).headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/); // malformed context is ignored, never trusted
  });
  it('scheduled integrity run exports the gauges the alerts depend on', async () => {
    const r = await app.get(IntegrityService).runScheduled(); (metrics as any).cache = null; /* gauges are cached 10s by design */ const text = await metrics.render();
    expect(text).toContain(`integrity_ok ${r.ok ? 1 : 0}`); expect(text).toMatch(/integrity_last_run_timestamp_seconds \d{10}/);
  });
});

describe('alert rules and dashboard only reference metrics the code emits', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
  const src = walk(join(__dirname, '../src')).filter((f) => !f.endsWith('.spec.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const builtin = new Set(['process_uptime_seconds', 'nodejs_eventloop_lag_p99_seconds', 'process_resident_memory_bytes', 'nodejs_heap_used_bytes']);
  const FUNCS = new Set(['histogram_quantile', 'label_replace']);
  const metricsIn = (expr: string) => {
    const stripped = expr.replace(/\{[^}]*\}/g, '').replace(/\b(by|without|on|ignoring)\s*\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
    return [...new Set((stripped.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []).filter((t) => !FUNCS.has(t)))].map((t) => t.replace(/_(bucket|sum|count)$/, ''));
  };
  const exists = (m: string) => builtin.has(m) || src.includes(`'${m}'`);
  const rules: { alert: string; expr: string }[] = (load(readFileSync(join(__dirname, '../../ops/prometheus/alerts.yml'), 'utf8')) as any).groups.flatMap((g: any) => g.rules);
  it('every metric in every alert expression exists in the code', () => {
    expect(rules.length).toBeGreaterThanOrEqual(15);
    const missing = rules.flatMap((r) => metricsIn(r.expr).filter((m) => !exists(m)).map((m) => `${r.alert}: ${m}`)); expect(missing).toEqual([]);
  });
  it('every alert has a severity and a summary; page-level alerts point at a runbook or DR plan', () => {
    for (const r of rules as any[]) { expect(['page', 'ticket']).toContain(r.labels.severity); expect(r.annotations.summary).toBeTruthy(); if (r.labels.severity === 'page') expect(r.annotations.runbook ?? '').toMatch(/docs\//); }
  });
  it('the Grafana dashboard parses and every panel query references real metrics', () => {
    const d = JSON.parse(readFileSync(join(__dirname, '../../ops/grafana/edtech-overview.json'), 'utf8'));
    expect(d.panels.length).toBeGreaterThanOrEqual(12);
    const missing = d.panels.flatMap((p: any) => p.targets.flatMap((t: any) => metricsIn(t.expr).filter((m: string) => !exists(m)).map((m: string) => `${p.title}: ${m}`))); expect(missing).toEqual([]);
  });
});
