import { INestApplication } from '@nestjs/common';
import { JsonLogger } from './logger';

/** App-level settings shared by main.ts and the tests that exercise them. */
export function configureApp(app: INestApplication, o: { logger?: boolean } = {}) {
  const x: any = app.getHttpAdapter().getInstance();
  x.disable?.('x-powered-by'); x.set?.('trust proxy', Number(process.env.TRUST_PROXY ?? 0)); // number of trusted proxy hops, never `true`
  (app as any).useBodyParser?.('json', { limit: process.env.JSON_BODY_LIMIT ?? '2mb' });
  app.enableShutdownHooks();
  if (o.logger) app.useLogger(new JsonLogger());
  const s = app.getHttpServer(); s.keepAliveTimeout = 65_000; s.headersTimeout = 66_000; s.requestTimeout = 15 * 60_000; // above typical LB idle timeouts
}
