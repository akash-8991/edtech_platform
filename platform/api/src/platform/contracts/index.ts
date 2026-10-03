import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import inferred from './inferred.json';
import { BINARY_RESPONSES, MANUAL_CONTRACTS } from './manual';

export interface Contract { query?: string[]; body?: Record<string, any>; bodyObserved?: number; responses: Record<string, Record<string, any>> }
const ALL: Record<string, Contract> = { ...(inferred as unknown as Record<string, Contract>), ...MANUAL_CONTRACTS };
export const contractFor = (key: string): Contract | undefined => ALL[key];
export const contractKeys = () => Object.keys(ALL);

const ajv = addFormats(new Ajv({ strict: false, allErrors: true, allowUnionTypes: true }));
const cache = new Map<string, ReturnType<typeof ajv.compile>>();
const validator = (id: string, schema: Record<string, any>) => { let v = cache.get(id); if (!v) { v = ajv.compile(schema); cache.set(id, v); } return v; };
const describe = (errs: { instancePath: string; message?: string }[] | null | undefined) => (errs ?? []).slice(0, 6).map((e) => `${e.instancePath || '(root)'} ${e.message}`);

/**
 * Validates one request/response pair against the declared contract. Returns problems (empty = conforms). A route or status with no
 * declared response is a problem too: the contract must be complete, not merely correct where it speaks.
 */
export function checkExchange(key: string, status: number, body: unknown, res: unknown): string[] {
  const c = ALL[key]; if (!c) return [`no contract declared for ${key}; run npm run contracts:infer`];
  if (BINARY_RESPONSES[key]) return [];
  const out: string[] = [];
  const r = c.responses[String(status)]; if (!r) return [`no ${status} response declared for ${key}`];
  const rv = validator(`${key}#${status}`, r); if (!rv(res)) out.push(...describe(rv.errors).map((m) => `response ${m}`));
  if (c.body && body && typeof body === 'object' && Object.keys(body as object).length) { const bv = validator(`${key}#body`, c.body); if (!bv(body)) out.push(...describe(bv.errors).map((m) => `request body ${m}`)); }
  return out;
}
