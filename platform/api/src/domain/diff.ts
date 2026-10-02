// Structural comparison of two programme versions (CUR-006 compare), keyed by module/topic title.
interface T { title: string; hours: number; outcomes: unknown; prerequisites?: unknown; mandatory?: boolean }
interface M { title: string; topics: T[] }
export interface VersionLike { hours: number; outcomes: unknown; modules: M[] }
export interface Change { path: string; change: 'added' | 'removed' | 'changed'; from?: unknown; to?: unknown }

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffVersions(a: VersionLike, b: VersionLike): Change[] {
  const out: Change[] = [];
  if (a.hours !== b.hours) out.push({ path: 'hours', change: 'changed', from: a.hours, to: b.hours });
  if (!eq(a.outcomes, b.outcomes)) out.push({ path: 'outcomes', change: 'changed', from: a.outcomes, to: b.outcomes });
  const am = new Map(a.modules.map((m) => [m.title, m])), bm = new Map(b.modules.map((m) => [m.title, m]));
  for (const [t, m] of am) if (!bm.has(t)) out.push({ path: `module:${t}`, change: 'removed', from: m.topics.map((x) => x.title) });
  for (const [t, m] of bm) {
    const o = am.get(t);
    if (!o) { out.push({ path: `module:${t}`, change: 'added', to: m.topics.map((x) => x.title) }); continue; }
    const ot = new Map(o.topics.map((x) => [x.title, x])), nt = new Map(m.topics.map((x) => [x.title, x]));
    for (const [n, x] of ot) if (!nt.has(n)) out.push({ path: `module:${t}/topic:${n}`, change: 'removed', from: { hours: x.hours } });
    for (const [n, x] of nt) {
      const y = ot.get(n);
      if (!y) { out.push({ path: `module:${t}/topic:${n}`, change: 'added', to: { hours: x.hours } }); continue; }
      for (const f of ['hours', 'outcomes', 'prerequisites', 'mandatory'] as const)
        if (!eq((y as any)[f], (x as any)[f])) out.push({ path: `module:${t}/topic:${n}/${f}`, change: 'changed', from: (y as any)[f], to: (x as any)[f] });
    }
  }
  return out;
}
