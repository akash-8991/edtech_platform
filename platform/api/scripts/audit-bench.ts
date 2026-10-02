// Throughput of the hash-chained audit log (global advisory lock => strictly serial). Run: ts-node scripts/audit-bench.ts
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../src/audit';
(async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://edtech:edtech@localhost:5433/edtech_perf' } } }); const audit = new AuditService(prisma as any);
  const N = 1500, C = Number(process.env.C ?? 16); let i = 0; const t0 = Date.now(); const lat: number[] = [];
  await Promise.all(Array.from({ length: C }, async () => { while (i < N) { const k = i++; const s = performance.now(); await prisma.$transaction((tx) => audit.record(tx, { actor: null, action: 'bench', objectType: 'Bench', objectId: String(k) })); lat.push(performance.now() - s); } }));
  lat.sort((a, b) => a - b); const secs = (Date.now() - t0) / 1000;
  console.log(JSON.stringify({ appends: N, concurrency: C, seconds: secs, perSecond: Math.round(N / secs), p50ms: Math.round(lat[N / 2]), p95ms: Math.round(lat[Math.floor(N * 0.95)]) }));
  await prisma.$disconnect();
})();
