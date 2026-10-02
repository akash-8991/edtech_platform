import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LIMITS = () => ({
  depth: Number(process.env.BODY_MAX_DEPTH ?? 12),
  nodes: Number(process.env.BODY_MAX_NODES ?? 50_000),
  array: Number(process.env.BODY_MAX_ARRAY ?? 5_000),
});

/**
 * Structural guard for EVERY JSON body, including handlers still typed `any`: bounded depth, node count and array length, and no
 * prototype-pollution keys. Content rules live in DTOs (below) or in domain code; this closes the "anything goes" gap uniformly.
 */
@Injectable()
export class BodyGuardPipe implements PipeTransform {
  transform(value: any, meta: ArgumentMetadata) {
    if (meta.type !== 'body' || value === null || typeof value !== 'object') return value;
    const l = LIMITS(); let nodes = 0;
    const walk = (v: any, d: number) => {
      if (d > l.depth) throw new BadRequestException({ error: 'validation_failed', message: `body nesting deeper than ${l.depth}` });
      if (++nodes > l.nodes) throw new BadRequestException({ error: 'validation_failed', message: 'body has too many fields' });
      if (Array.isArray(v)) {
        if (v.length > l.array) throw new BadRequestException({ error: 'validation_failed', message: `array longer than ${l.array}` });
        for (const x of v) if (x && typeof x === 'object') walk(x, d + 1);
      } else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          if (FORBIDDEN_KEYS.has(k)) throw new BadRequestException({ error: 'validation_failed', message: `field name not allowed: ${k}` });
          if (v[k] && typeof v[k] === 'object') walk(v[k], d + 1);
        }
      }
    };
    walk(value, 1);
    return value;
  }
}

const flatten = (errs: ValidationError[], prefix = ''): string[] =>
  errs.flatMap((e) => [...(e.constraints ? [`${prefix}${e.property}`] : []), ...flatten(e.children ?? [], `${prefix}${e.property}.`)]);

/** DTO-typed handlers: unknown fields rejected, same error shape as need(). Handlers typed `any` pass through untouched. */
export const dtoPipe = () => new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, transform: false, stopAtFirstError: true,
  exceptionFactory: (errs) => new BadRequestException({ error: 'validation_failed', fields: flatten(errs) }),
});
