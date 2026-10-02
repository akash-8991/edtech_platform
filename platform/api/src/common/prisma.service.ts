import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { metrics } from '../platform/metrics';

/**
 * Connection-pool settings applied to a Postgres URL from the environment (explicit params already in the URL win):
 *   DB_CONNECTION_LIMIT  per-process pool size (size it so instances x limit stays under the pooler / server cap; see capacity-model.md)
 *   DB_POOL_TIMEOUT      seconds to wait for a free connection before failing
 *   DB_PGBOUNCER=1       the URL points at PgBouncer in TRANSACTION mode: disables prepared statements (`pgbouncer=true`).
 * The app is transaction-pooling safe: it uses only transaction-scoped features (pg_advisory_xact_lock, set_config(..., true), SKIP LOCKED);
 * no session state, LISTEN/NOTIFY or session advisory locks. Migrations must bypass the pooler (run prisma migrate against the direct URL).
 */
export function poolUrl(url: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!url) return url;
  const u = new URL(url); const set = (k: string, v: string | undefined) => { if (v && !u.searchParams.has(k)) u.searchParams.set(k, v); };
  set('connection_limit', env.DB_CONNECTION_LIMIT); set('pool_timeout', env.DB_POOL_TIMEOUT); if (env.DB_PGBOUNCER === '1') set('pgbouncer', 'true');
  return u.toString();
}
const clientOpts = (url: string | undefined): { datasources?: { db: { url: string } } } => (url ? { datasources: { db: { url: poolUrl(url)! } } } : {});

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() { super(clientOpts(process.env.DATABASE_URL) as any); }
  async onModuleInit() { await this.$connect(); }
}

/**
 * Read-only reporting path. With DATABASE_REPLICA_URL, heavy reports run on a streaming replica so they cannot compete with exam
 * traffic; results may lag the primary by the replication delay (fine for dashboards, never use for read-your-write flows).
 * If the replica is unreachable the query is retried once on the primary and counted in read_replica_fallback_total.
 */
@Injectable()
export class ReadDb implements OnModuleDestroy {
  private replica?: PrismaClient;
  constructor(private primary: PrismaService) { if (process.env.DATABASE_REPLICA_URL) this.replica = new PrismaClient(clientOpts(process.env.DATABASE_REPLICA_URL) as any); }
  get usingReplica() { return !!this.replica; }
  async run<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
    if (!this.replica) return fn(this.primary);
    try { return await fn(this.replica); }
    catch (e: any) {
      if (!['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(e?.code) && !/ECONNREFUSED|Can't reach database|terminating connection/i.test(String(e?.message))) throw e;
      metrics.inc('read_replica_fallback_total', {}, 1, 'Report queries retried on the primary because the replica failed'); return fn(this.primary);
    }
  }
  async onModuleDestroy() { await this.replica?.$disconnect(); }
}
