// Verifies a restored database: every tamper-evident chain, referential relationships, and row-count parity with the source.
// SOURCE_URL=... TARGET_URL=... ts-node scripts/dr/verify-restore.ts
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { IntegrityService } from '../../src/ops/integrity';

(async () => {
  const src = new PrismaClient({ datasources: { db: { url: process.env.SOURCE_URL! } } }), dst = new PrismaClient({ datasources: { db: { url: process.env.TARGET_URL! } } });
  const t0 = Date.now(); const report = await new IntegrityService(dst as any).verify();
  const tables = (await dst.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY 1`)).map((t) => t.tablename);
  const parity: Record<string, { source: number; restored: number }> = {}; const mismatched: string[] = [];
  for (const t of tables) { const s = Number((await src.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM "${t}"`))[0].n), d = Number((await dst.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM "${t}"`))[0].n); parity[t] = { source: s, restored: d }; if (s !== d) mismatched.push(t); }
  // immutability triggers must survive a restore, or the restored system would silently lose its append-only guarantees
  const trg = (await dst.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM pg_trigger WHERE tgname IN ('audit_event_immutable','grade_record_immutable','exam_event_immutable','exam_submission_immutable','approval_record_immutable','learning_event_immutable','submission_immutable','script_manifest_immutable','tutor_message_evidence','ticket_message_immutable','proctor_webhook_immutable')`))[0].n;
  const out = { integrity: report, rowCounts: { tables: tables.length, mismatched, rows: Object.values(parity).reduce((s, x) => s + x.restored, 0) }, immutabilityTriggersPresent: Number(trg), verifySeconds: (Date.now() - t0) / 1000, ok: report.ok && !mismatched.length && Number(trg) === 11 };
  console.log(JSON.stringify(out)); await src.$disconnect(); await dst.$disconnect(); process.exit(out.ok ? 0 : 2);
})();
