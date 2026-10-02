import { loadDotEnv } from './platform/env';
loadDotEnv();
process.env.PROCESS_ROLE = 'worker';
import 'reflect-metadata';
import { createServer } from 'http';
import { NestFactory } from '@nestjs/core';
import { loadSecrets } from './platform/secrets';
import { JsonLogger } from './platform/logger';
import { productionConfigProblems } from './platform/config-guard';
import { metrics } from './platform/metrics';

/**
 * Background worker entrypoint: job queue, exam/doubt/privacy sweeps, retention. No HTTP API; a tiny liveness/metrics port lets the
 * orchestrator probe it. Scale it independently of the API (the queue uses FOR UPDATE SKIP LOCKED, so N workers are safe).
 */
async function main() {
  await loadSecrets();
  const { AppModule } = await import('./app.module');
  if (process.env.NODE_ENV === 'production') {
    const problems = productionConfigProblems({ ...process.env, PROCESS_ROLE: 'worker' });
    if (problems.length) { process.stderr.write(`Refusing to start: unsafe production configuration\n - ${problems.join('\n - ')}\n`); process.exit(1); }
  }
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  if (process.env.NODE_ENV === 'production' || process.env.LOG_JSON === '1') app.useLogger(new JsonLogger());
  app.enableShutdownHooks();
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
  const probe = createServer(async (req, res) => {
    if (req.url === '/metrics' && process.env.METRICS_TOKEN && req.headers.authorization === `Bearer ${process.env.METRICS_TOKEN}`) { res.setHeader('Content-Type', 'text/plain'); return res.end(await metrics.render()); }
    res.statusCode = req.url === '/health' ? 200 : req.url === '/metrics' ? 401 : 404; res.end(req.url === '/health' ? 'ok' : '');
  }).listen(port, '0.0.0.0');
  process.on('SIGTERM', () => probe.close());
}
main();
