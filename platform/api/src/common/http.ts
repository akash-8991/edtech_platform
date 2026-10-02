import { BadRequestException } from '@nestjs/common';

/** Minimal body validation: throws 400 listing missing/invalid fields. */
export function need<T extends Record<string, any>>(body: any, fields: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>): T {
  const bad: string[] = [];
  for (const [k, t] of Object.entries(fields)) {
    const v = body?.[k];
    const ok = t === 'array' ? Array.isArray(v) : t === 'object' ? v && typeof v === 'object' : typeof v === t && (t !== 'string' || v.trim() !== '');
    if (!ok) bad.push(k);
  }
  if (bad.length) throw new BadRequestException({ error: 'validation_failed', fields: bad });
  return body;
}
