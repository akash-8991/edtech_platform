import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv from 'ajv';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { listRoutes } from '../src/platform/inventory';
import { buildOpenApi } from '../src/platform/openapi';
import { checkExchange, contractFor } from '../src/platform/contracts';
import { BINARY_RESPONSES, RAW_UPLOADS, SUMMARIES, TAGS } from '../src/platform/contracts/manual';
import { infer } from '../src/platform/contracts/infer';

const prisma = new PrismaClient(); let app: INestApplication; let http: any; const tok: Record<string, string> = {};
let doc: any; let routes: ReturnType<typeof listRoutes>;
beforeAll(async () => {
  const tables = (await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`)).map((t) => `"${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE`);
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(); await app.init(); http = request(app.getHttpServer());
  for (const [k, r] of [['admin', 'ACADEMIC_ADMIN'], ['learner', 'LEARNER']]) { await prisma.user.create({ data: { email: `${k}@x.test`, name: k, passwordHash: hashPassword('pw'), roles: { create: { role: r as any } } } }); tok[k] = (await http.post('/v1/auth/login').send({ email: `${k}@x.test`, password: 'pw' })).body.accessToken; }
  routes = listRoutes(app); doc = buildOpenApi(routes);
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('OpenAPI document', () => {
  it('describes every route exactly once, with a summary, an operationId and a documented success response', () => {
    const ops: any[] = []; for (const p of Object.values<any>(doc.paths)) for (const o of Object.values<any>(p)) ops.push(o);
    expect(ops).toHaveLength(routes.length);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    const bad = routes.filter((r) => { const k = `${r.method} ${r.path}`; const o = doc.paths[r.path.replace(/:(\w+)/g, '{$1}')]?.[r.method.toLowerCase()]; return !SUMMARIES[k] || !o || !Object.keys(o.responses).some((s) => /^2/.test(s)); }).map((r) => `${r.method} ${r.path}`);
    expect(bad).toEqual([]);
  });
  it('every summary names a real route and every tag has a description', () => {
    const real = new Set(routes.map((r) => `${r.method} ${r.path}`)); expect(Object.keys(SUMMARIES).filter((k) => !real.has(k))).toEqual([]);
    expect(doc.tags.filter((t: any) => !t.description).map((t: any) => t.name)).toEqual([]); expect(Object.keys(TAGS).length).toBeGreaterThan(20);
  });
  it('path parameters are declared, security follows the access rules, and every $ref resolves', () => {
    for (const r of routes) {
      const o = doc.paths[r.path.replace(/:(\w+)/g, '{$1}')][r.method.toLowerCase()];
      expect((o.parameters ?? []).filter((p: any) => p.in === 'path').map((p: any) => p.name).sort()).toEqual([...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]).sort());
      expect(o.security.length).toBe(r.public ? 0 : 1); expect(o['x-roles']).toEqual(r.roles ?? []); if (r.roles?.length) expect(o.responses['403']).toBeTruthy(); if (!r.public) expect(o.responses['401']).toBeTruthy();
    }
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]); expect(refs.length).toBeGreaterThan(100); for (const n of new Set(refs)) expect(doc.components.schemas[n]).toBeTruthy();
  });
  it('every request and response schema compiles, and write routes document their body', () => {
    const ajv = new Ajv({ strict: false, allowUnionTypes: true }); let n = 0;
    for (const p of Object.values<any>(doc.paths)) for (const o of Object.values<any>(p)) {
      for (const resp of Object.values<any>(o.responses)) for (const c of Object.values<any>(resp.content ?? {})) if (!c.schema.$ref && !c.schema.format) { ajv.compile(c.schema); n++; }
      for (const c of Object.values<any>(o.requestBody?.content ?? {})) if (!c.schema.format) { ajv.compile(c.schema); n++; }
    }
    expect(n).toBeGreaterThan(300);
    for (const k of ['POST /v1/auth/login', 'POST /v1/entitlements/:id/exceptions', 'PUT /v1/me/preferences']) expect(contractFor(k)!.body).toBeTruthy();
    for (const k of RAW_UPLOADS) expect(doc.paths[k.split(' ')[1].replace(/:(\w+)/g, '{$1}')].put.requestBody.content['application/octet-stream']).toBeTruthy();
    for (const k of Object.keys(BINARY_RESPONSES)) expect(routes.some((r) => `${r.method} ${r.path}` === k)).toBe(true);
  });
  it('the committed docs/openapi.json matches the code (regenerate with `npm run openapi` after intentional changes)', () => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(JSON.parse(readFileSync(join(__dirname, '../../docs/openapi.json'), 'utf8')));
  });
  it('is served to platform staff only', async () => {
    const r = await http.get('/v1/openapi.json').set({ Authorization: `Bearer ${tok.admin}` }).expect(200); expect(r.body.openapi).toBe('3.1.0'); expect(Object.keys(r.body.paths).length).toBeGreaterThan(150);
    await http.get('/v1/openapi.json').set({ Authorization: `Bearer ${tok.learner}` }).expect(403); await http.get('/v1/openapi.json').expect(401);
  });
});

describe('contract enforcement', () => {
  it('flags a wrong type, a missing required field, a missing status and an unknown route', () => {
    expect(checkExchange('POST /v1/entitlements/:id/exceptions', 201, { extendDays: 5, reason: 'x' }, { id: 1 }).join()).toMatch(/response/);
    expect(checkExchange('POST /v1/auth/login', 201, { email: 'a@b.c', password: 'x' }, { accessToken: 5 }).join()).toMatch(/accessToken/);
    expect(checkExchange('POST /v1/auth/login', 201, { email: 'a' }, { accessToken: 'x' }).join()).toMatch(/request body/);
    expect(checkExchange('GET /v1/catalogue', 418, null, {}).join()).toMatch(/no 418 response/);
    expect(checkExchange('GET /v1/nope', 200, null, {}).join()).toMatch(/no contract/);
  });
  it('inference: required means present in every sample; id-keyed objects become maps; dates and ids get formats', () => {
    const s: any = infer([{ a: 1, b: 'x' }, { a: 2.5 }]); expect(s.required).toEqual(['a']); expect(s.properties.a.type).toBe('number');
    expect(infer([{ '11111111-1111-4111-8111-111111111111': 1 }, { '22222222-2222-4222-8222-222222222222': 2 }])).toMatchObject({ type: 'object', additionalProperties: { type: 'integer' } });
    expect(infer(['2026-01-01T00:00:00.000Z'])).toMatchObject({ type: 'string', format: 'date-time' }); expect(infer([null, 'x'])).toMatchObject({ type: ['null', 'string'] });
  });
});
