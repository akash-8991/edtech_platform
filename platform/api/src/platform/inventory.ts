import { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';

export interface RouteInfo { method: string; path: string; public: boolean; roles: string[] | null; rateLimit?: number; controller: string; handler: string }
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ALL'];

/** Reflects every controller route with its access rule. Used by the authorization audit test and to generate docs/api-inventory.json. */
export function listRoutes(app: INestApplication): RouteInfo[] { return listRoutesFrom(app.get(ModulesContainer)); }
export function listRoutesFrom(container: ModulesContainer): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const mod of container.values()) {
    for (const w of mod.controllers.values()) {
      const proto = w.metatype?.prototype; if (!proto) continue;
      const base = Reflect.getMetadata('path', w.metatype!) ?? '';
      for (const name of Object.getOwnPropertyNames(proto)) {
        const h = proto[name]; if (typeof h !== 'function' || name === 'constructor') continue;
        const path = Reflect.getMetadata('path', h); const m = Reflect.getMetadata('method', h); if (path === undefined || m === undefined) continue;
        const roles = Reflect.getMetadata('roles', h) ?? Reflect.getMetadata('roles', w.metatype!) ?? null;
        out.push({ method: METHODS[m], path: ('/' + [base, path].join('/')).replace(/\/+/g, '/').replace(/\/$/, '') || '/', public: !!(Reflect.getMetadata('public', h) ?? Reflect.getMetadata('public', w.metatype!)), roles: roles ? [...roles].sort() : null,
          rateLimit: Reflect.getMetadata('rate_limit', h), controller: w.metatype!.name, handler: name });
      }
    }
  }
  return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}
