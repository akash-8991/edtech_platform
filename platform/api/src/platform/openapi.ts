import { Controller, Get, Injectable } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Roles } from '../common/auth';
import { RouteInfo, listRoutesFrom } from './inventory';
import { contractFor } from './contracts';
import { BINARY_RESPONSES, HEADERS, QUERY_TYPES, RAW_UPLOADS, SUMMARIES, TAGS } from './contracts/manual';

const STATUS_TEXT: Record<string, string> = { 200: 'OK', 201: 'Created', 206: 'Partial content' };
const err = (description: string, ref = 'Error') => ({ description, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
const opId = (m: string, p: string) => m.toLowerCase() + p.replace(/^\/v1/, '').split(/[/:{}-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const tagOf = (p: string) => ((p.startsWith('/v1/') ? p.split('/')[2] : p.split('/')[1]) || 'root').replace(/\.json$/, '');

/** OpenAPI 3.1 document built from the live route table, the reviewed access rules, and the inferred-then-enforced request/response contracts. */
export function buildOpenApi(routes: RouteInfo[], version = '0.1.0') {
  const paths: Record<string, any> = {}; const tags = new Set<string>();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`; const c = contractFor(key); const tag = tagOf(r.path); tags.add(tag);
    const params: any[] = [...[...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }))];
    for (const q of c?.query ?? []) params.push({ name: q, in: 'query', required: false, schema: { type: QUERY_TYPES[q]?.type ?? 'string' }, ...(QUERY_TYPES[q]?.description && { description: QUERY_TYPES[q].description }) });
    for (const h of HEADERS[key] ?? []) params.push({ name: h.name, in: 'header', required: h.required, description: h.description, schema: { type: 'string' } });
    const op: any = { operationId: opId(r.method, r.path), summary: SUMMARIES[key] ?? key, tags: [tag], ...(params.length && { parameters: params }),
      security: r.public ? [] : [{ bearerAuth: [] }], 'x-public': r.public, 'x-roles': r.roles ?? [], ...(r.rateLimit && { 'x-rate-limit-per-minute': r.rateLimit }),
      description: r.public ? 'No sign-in required (protected by signature, token or rate limit).' : r.roles?.length ? `Requires one of: ${r.roles.join(', ')}.` : 'Any signed-in user.' };
    if (RAW_UPLOADS.has(key)) op.requestBody = { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    else if (c?.body) op.requestBody = { required: !!c.body.required?.length, content: { 'application/json': { schema: c.body } } };
    const responses: Record<string, any> = {}; const bin = BINARY_RESPONSES[key];
    if (bin) for (const s of bin.statuses) responses[String(s)] = { description: bin.description, content: { [bin.mime]: { schema: { type: 'string', format: 'binary' } } } };
    for (const [s, schema] of Object.entries(c?.responses ?? {})) {
      const { ['x-samples']: _n, ...clean } = schema as any; const headers = c?.query?.includes('cursor') ? { 'X-Next-Cursor': { description: 'Cursor for the next page; absent on the last page.', schema: { type: 'string' } } } : undefined;
      responses[s] = { description: STATUS_TEXT[s] ?? 'Success', content: { 'application/json': { schema: clean } }, ...(headers && { headers }) };
    }
    if (c?.body || RAW_UPLOADS.has(key) || (c?.query?.length ?? 0) > 0 || r.path.includes(':')) responses['400'] = err('Validation failed', 'ValidationError');
    if (!r.public) responses['401'] = err('Missing, expired or revoked credentials');
    if (r.roles?.length) responses['403'] = err('Signed in, but not allowed to do this');
    if (r.path.includes(':')) responses['404'] = err('Not found, or not visible to you');
    if (r.method !== 'GET') responses['409'] = err('Conflicts with the current state');
    responses['429'] = err('Rate limited; honour Retry-After'); 
    op.responses = responses;
    (paths[r.path.replace(/:(\w+)/g, '{$1}')] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Learning platform API', version, description: 'Generated from the live route table. Request and response schemas are inferred from the test suite and enforced against live responses in CI (see docs/guides/api-contracts.md). Times are ISO-8601 UTC. Writes may carry an Idempotency-Key header.' },
    servers: [{ url: '/' }],
    tags: [...tags].sort().map((name) => ({ name, description: TAGS[name] ?? '' })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from POST /v1/auth/login (15 minutes). Refresh with POST /v1/auth/refresh.' } },
      schemas: {
        Error: { type: 'object', properties: { statusCode: { type: 'integer' }, error: { type: 'string', description: 'Machine-readable code such as consent_required or rate_limited.' }, message: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } } },
        ValidationError: { type: 'object', properties: { statusCode: { type: 'integer' }, error: { type: 'string', const: 'validation_failed' }, message: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, fields: { type: 'array', items: { type: 'string' }, description: 'Names of the missing or invalid fields.' } } },
      },
    },
  };
}

@Controller('v1')
@Injectable()
export class OpenApiController {
  constructor(private modules: ModulesContainer) {}
  @Get('openapi.json') @Roles('PLATFORM_ADMIN', 'SUPER_ADMIN', 'AUDITOR', 'ACADEMIC_ADMIN')
  spec() { return buildOpenApi(listRoutesFrom(this.modules)); }
}
