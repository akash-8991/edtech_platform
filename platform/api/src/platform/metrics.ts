import { monitorEventLoopDelay } from 'perf_hooks';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const lbl = (l: Record<string, string>) => { const k = Object.keys(l).sort(); return k.length ? `{${k.map((x) => `${x}="${esc(l[x])}"`).join(',')}}` : ''; };

/** Minimal Prometheus-text registry (no dependency). Per-process; a scraper aggregates instances. */
export class Metrics {
  private counters = new Map<string, { help: string; v: Map<string, number> }>();
  private hists = new Map<string, { help: string; v: Map<string, { b: number[]; sum: number; n: number }> }>();
  private gauges = new Map<string, { help: string; fn: () => Promise<{ labels?: Record<string, string>; value: number }[]> | { labels?: Record<string, string>; value: number }[] }>();
  private loop = monitorEventLoopDelay({ resolution: 20 });
  private cache: { at: number; text: string } | null = null;
  constructor() { this.loop.enable(); }

  inc(name: string, labels: Record<string, string> = {}, by = 1, help = name) {
    const c = this.counters.get(name) ?? { help, v: new Map() }; this.counters.set(name, c);
    const k = lbl(labels); c.v.set(k, (c.v.get(k) ?? 0) + by);
  }
  observe(name: string, labels: Record<string, string>, seconds: number, help = name) {
    const h = this.hists.get(name) ?? { help, v: new Map() }; this.hists.set(name, h);
    const k = lbl(labels); const e = h.v.get(k) ?? { b: BUCKETS.map(() => 0), sum: 0, n: 0 }; h.v.set(k, e);
    BUCKETS.forEach((b, i) => { if (seconds <= b) e.b[i]++; }); e.sum += seconds; e.n++;
  }
  gauge(name: string, help: string, fn: () => Promise<{ labels?: Record<string, string>; value: number }[]> | { labels?: Record<string, string>; value: number }[]) { this.gauges.set(name, { help, fn }); }

  async render(): Promise<string> {
    const out: string[] = [];
    for (const [n, c] of this.counters) { out.push(`# HELP ${n} ${c.help}`, `# TYPE ${n} counter`); for (const [k, v] of c.v) out.push(`${n}${k} ${v}`); }
    for (const [n, h] of this.hists) {
      out.push(`# HELP ${n} ${h.help}`, `# TYPE ${n} histogram`);
      for (const [k, e] of h.v) { const base = k ? k.slice(1, -1) + ',' : ''; BUCKETS.forEach((b, i) => out.push(`${n}_bucket{${base}le="${b}"} ${e.b[i]}`)); out.push(`${n}_bucket{${base}le="+Inf"} ${e.n}`, `${n}_sum${k} ${e.sum}`, `${n}_count${k} ${e.n}`); }
    }
    const now = Date.now();
    if (!this.cache || now - this.cache.at > 10_000) { // DB-backed gauges are cached 10 s so scraping can never load the database
      const g: string[] = [];
      for (const [n, x] of this.gauges) { g.push(`# HELP ${n} ${x.help}`, `# TYPE ${n} gauge`); try { for (const s of await x.fn()) g.push(`${n}${lbl(s.labels ?? {})} ${s.value}`); } catch { /* a failing gauge must not break the scrape */ } }
      this.cache = { at: now, text: g.join('\n') };
    }
    const mem = process.memoryUsage();
    out.push(this.cache.text, '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`, '# TYPE nodejs_heap_used_bytes gauge', `nodejs_heap_used_bytes ${mem.heapUsed}`,
      '# TYPE nodejs_eventloop_lag_p99_seconds gauge', `nodejs_eventloop_lag_p99_seconds ${(this.loop.percentile(99) / 1e9).toFixed(6)}`, '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round(process.uptime())}`);
    return out.join('\n') + '\n';
  }
}
export const metrics = new Metrics();
