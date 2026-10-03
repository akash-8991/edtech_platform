// Drafts src/platform/contracts/inferred.json from observed test traffic plus static route facts. Run: npm run contracts:infer
//   OPENAPI_RECORD=/tmp/samples.jsonl npx jest   (records every successful exchange)
//   SAMPLES=/tmp/samples.jsonl npm run contracts:infer
// Re-running replaces the file; commit the diff after review. Hand-written facts live in contracts/manual.ts and always win.
import 'reflect-metadata';
process.env.RATE_LIMIT_DISABLED = '1';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { getMetadataStorage } from 'class-validator';
import { AppModule } from '../src/app.module';
import { listRoutes } from '../src/platform/inventory';
import { infer } from '../src/platform/contracts/infer';

const ROUTE_ARGS = '__routeArguments__'; const BODY = 3, QUERY = 4, PARAM = 5; // Nest RouteParamtypes

function dtoSchema(cls: any) {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls, '', false, false);
  const props: Record<string, any> = {}; const optional = new Set<string>();
  for (const m of metas) {
    if (m.type === 'conditionalValidation') { optional.add(m.propertyName); continue; }
    const p = (props[m.propertyName] ??= {}); const n = (m as any).name ?? m.type;
    if (n === 'isString') p.type = 'string'; else if (n === 'isInt') p.type = 'integer'; else if (n === 'isNumber') p.type = 'number'; else if (n === 'isBoolean') p.type = 'boolean';
    else if (n === 'isArray') p.type = 'array'; else if (n === 'isObject') p.type = 'object'; else if (n === 'isISO8601') { p.type = 'string'; p.format = 'date-time'; }
    else if (n === 'isIn') { p.enum = (m.constraints?.[0] as any[]) ?? undefined; p.type = typeof p.enum?.[0] === 'string' ? 'string' : undefined; }
    else if (n === 'minLength') p.minLength = m.constraints?.[0]; else if (n === 'maxLength') p.maxLength = m.constraints?.[0]; else if (n === 'arrayMaxSize') p.maxItems = m.constraints?.[0];
    else if (n === 'min') p.minimum = m.constraints?.[0]; else if (n === 'max') p.maximum = m.constraints?.[0];
  }
  for (const k of Object.keys(props)) if (!props[k].type) delete props[k].type;
  return { type: 'object', properties: props, required: Object.keys(props).filter((k) => !optional.has(k)) };
}

(async () => {
  const samples = new Map<string, { status: number; res: any[]; body: any[]; query: Set<string> }>();
  for (const line of readFileSync(process.env.SAMPLES ?? '/tmp/samples.jsonl', 'utf8').split('\n')) {
    if (!line.trim()) continue; const d = JSON.parse(line); const e: { status: number; res: any[]; body: any[]; query: Set<string> } = samples.get(`${d.k} ${d.s}`) ?? { status: d.s, res: [], body: [], query: new Set<string>() };
    if (e.res.length < 400) e.res.push(d.r); if (d.b && Object.keys(d.b).length && e.body.length < 400) e.body.push(d.b); for (const q of Object.keys(d.q ?? {})) e.query.add(q); samples.set(`${d.k} ${d.s}`, e);
  }
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); const app = mod.createNestApplication(); await app.init();
  const out: Record<string, any> = {};
  for (const r of listRoutes(app)) {
    const key = `${r.method} ${r.path}`; const ctrl = [...(app as any).container.getModules().values()].flatMap((m: any) => [...m.controllers.values()]).find((w: any) => w.metatype?.name === r.controller)!.metatype;
    const args = Reflect.getMetadata(ROUTE_ARGS, ctrl, r.handler) ?? {}; const types = Reflect.getMetadata('design:paramtypes', ctrl.prototype, r.handler) ?? [];
    const queryNames: string[] = []; let bodyIdx = -1;
    for (const [k, v] of Object.entries<any>(args)) { const [type, idx] = k.split(':').map(Number); if (type === QUERY && v.data) queryNames.push(v.data); if (type === BODY) bodyIdx = v.index ?? idx; }
    const src = String(ctrl.prototype[r.handler]); 
    const entry: any = { responses: {} };
    const params = (src.match(/^\s*(?:async\s+)?[\w$]+\s*\(([^)]*)\)/)?.[1] ?? '').split(',').map((x) => x.trim().replace(/=.*$/, '').trim());
    const bodyVar = bodyIdx >= 0 ? params[bodyIdx] : undefined; const needs = bodyVar ? [...src.matchAll(new RegExp(`need\\)?\\(\\s*${bodyVar.replace(/\$/g, '\\$')}\\s*,\\s*\\{([^}]*)\\}`, 'g'))].flatMap((m) => [...m[1].matchAll(/(\w+)\s*:\s*'(string|number|boolean|array|object)'/g)].map((x) => [x[1], x[2]] as const)) : []; // only checks of the BODY itself, not of a nested object the handler also validates
    const touched = bodyVar ? [...new Set([...src.matchAll(new RegExp(`\\b${bodyVar}\\??\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]))] : [];
    const seenQ = new Set<string>(queryNames); for (const [k, s] of samples) if (k.startsWith(key + ' ')) s.query.forEach((q) => seenQ.add(q));
    if (seenQ.size) entry.query = [...seenQ].sort();
    const bodies = [...samples].filter(([k]) => k.startsWith(key + ' ')).flatMap(([, s]) => s.body);
    const dto = bodyIdx >= 0 && types[bodyIdx] && !['Object', 'String', 'Array'].includes(types[bodyIdx].name) ? dtoSchema(types[bodyIdx]) : null;
    if (bodyIdx >= 0 || bodies.length) {
      const base: any = dto ?? (bodies.length ? infer(bodies) : { type: 'object' });
      if (!base.properties) base.properties = {};
      for (const k of touched) base.properties[k] ??= {}; // fields the handler reads, even if no test sent them
      for (const [k, t] of needs) { if (!base.properties[k] || !Object.keys(base.properties[k]).length) base.properties[k] = { type: t === 'array' ? 'array' : t === 'object' ? 'object' : t }; }
      const req = new Set<string>([...(dto?.required ?? []), ...needs.map(([k]) => k)]);
      entry.body = { ...base, type: base.type?.includes?.('object') ? 'object' : 'object', required: [...req].sort() }; if (!entry.body.required.length) delete entry.body.required; delete entry.body.anyOf;
      entry.bodyObserved = bodies.length;
    }
    for (const [k, s] of samples) if (k.startsWith(key + ' ')) entry.responses[String(s.status)] = { ...infer(s.res), 'x-samples': s.res.length };
    out[key] = entry;
  }
  writeFileSync(join(__dirname, '../src/platform/contracts/inferred.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`${Object.keys(out).length} routes; ${Object.values(out).filter((e: any) => Object.keys(e.responses).length).length} with an observed response`); await app.close(); process.exit(0);
})();
