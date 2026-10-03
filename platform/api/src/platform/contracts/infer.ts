/** Infers a JSON Schema (draft 2020-12 subset, OpenAPI 3.1 compatible) from sample values. Required = present in every sample. */
const kindOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAP_KEYS = 40;

export type Schema = Record<string, any>;

export function infer(values: unknown[]): Schema {
  if (!values.length) return {};
  const kinds = new Map<string, unknown[]>();
  for (const v of values) { const k = kindOf(v); kinds.set(k, [...(kinds.get(k) ?? []), v]); }
  if (kinds.has('number')) { kinds.set('number', [...(kinds.get('number') ?? []), ...(kinds.get('integer') ?? [])]); kinds.delete('integer'); }
  const types: string[] = []; let shape: Schema = {}; const structured: Schema[] = [];
  for (const [k, vs] of kinds) {
    if (k === 'object') {
      const objs = vs as Record<string, unknown>[]; const keys = new Set(objs.flatMap((o) => Object.keys(o)));
      const dynamic = [...keys].filter((k) => UUID.test(k) || /^\d{4}-\d{2}(-\d{2})?$/.test(k) || /^\d+$/.test(k)).length;
      if (keys.size > MAP_KEYS || (keys.size > 0 && dynamic * 2 > keys.size)) { // a dictionary keyed by ids or dates, not a fixed record
        structured.push({ type: 'object', additionalProperties: infer(objs.flatMap((o) => Object.values(o))) }); continue; }
      const properties: Record<string, Schema> = {}; const required: string[] = [];
      for (const key of [...keys].sort()) { const present = objs.filter((o) => key in o); properties[key] = infer(present.map((o) => o[key])); if (present.length === objs.length) required.push(key); }
      structured.push({ type: 'object', properties, ...(required.length && { required }) });
    } else if (k === 'array') structured.push({ type: 'array', items: infer((vs as unknown[][]).flat()) });
    else if (k === 'string') { const ss = vs as string[]; types.push('string'); if (ss.every((s) => ISO.test(s))) shape.format = 'date-time'; else if (ss.every((s) => UUID.test(s))) shape.format = 'uuid'; }
    else types.push(k);
  }
  if (structured.length === 1 && !types.length) return structured[0];
  if (structured.length === 1) { const s = structured[0]; return { ...s, type: [s.type, ...types] }; }
  if (!structured.length && types.length === 1 && types[0] === 'null') return { description: 'null in every sample seen; the field can hold a value other times' }; // do not claim a type nobody has observed
  if (!structured.length) return { type: types.length === 1 ? types[0] : types, ...shape };
  return { anyOf: [...structured, ...types.map((t) => ({ type: t }))] };
}
