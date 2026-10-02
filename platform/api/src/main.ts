import { loadDotEnv } from './platform/env';
loadDotEnv(); // local development only; see platform/env.ts
// must be set before the libuv threadpool is first used (password hashing, fs, dns share it)
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE ?? '8';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadSecrets } from './platform/secrets';
import { configureApp } from './platform/configure';
import { productionConfigProblems } from './platform/config-guard';

async function bootstrap() {
  await loadSecrets(); // before anything reads configuration
  const { AppModule } = await import('./app.module'); // evaluated only after secrets are in the environment
  if (process.env.NODE_ENV === 'production') {
    const problems = productionConfigProblems(process.env);
    if (problems.length) { process.stderr.write(`Refusing to start: unsafe production configuration\n - ${problems.join('\n - ')}\n`); process.exit(1); }
  }
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  configureApp(app, { logger: process.env.NODE_ENV === 'production' || process.env.LOG_JSON === '1' });
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
bootstrap();
