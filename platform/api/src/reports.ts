import { Controller, Get, Header, Query } from '@nestjs/common';
import { PrismaService, ReadDb } from './common/prisma.service';
import { Actor, CurrentActor, Roles } from './common/auth';
import { AuditService } from './audit';
import { ProgressionService } from './learning';
import { BadRequestException } from '@nestjs/common';

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // formula-injection safe

@Controller('v1/reports')
export class ReportsController {
  constructor(private prisma: PrismaService, private read: ReadDb, private prog: ProgressionService, private audit: AuditService) {}

  /** Cohort progress: completion, last activity, quiz struggle, at-risk flag. CSV export is audited (privileged action). */
  @Get('progress') @Roles('ACADEMIC_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_OPERATOR', 'AUDITOR')
  async progress(@Query('versionId') versionId: string, @Query('cohort') cohort: string | undefined, @Query('format') format: string | undefined, @CurrentActor() a: Actor,
    @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.read.run(async (db) => {
    if (!versionId) throw new BadRequestException('versionId required');
    const page = Math.min(1000, Math.max(1, Number(limit) || 200));
    const fetch = (cur: string | undefined, n: number) => db.entitlement.findMany({ where: { versionId, ...(cohort && { cohort }) }, orderBy: { id: 'asc' }, take: n, ...(cur && { cursor: { id: cur }, skip: 1 }), include: { learner: { select: { name: true, email: true } } } });
    const build = async (ents: Awaited<ReturnType<typeof fetch>>) => {
      const now = Date.now(), out = [];
      for (const e of ents) {
        const st = await this.prog.state(db, e);
        const mand = st.rows.filter((r) => r.topic.mandatory), done = mand.filter((r) => r.complete).length;
        const last = await db.learningEvent.findFirst({ where: { entitlementId: e.id }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } });
        const attempts = await db.quizAttempt.count({ where: { entitlementId: e.id, status: 'SUBMITTED' } });
        const lastAt = last?.occurredAt ?? e.startAt;
        const daysIdle = Math.floor((now - lastAt.getTime()) / 86_400_000);
        out.push({ learner: e.learner.name, email: e.learner.email, cohort: e.cohort, status: e.status, completedTopics: done, totalTopics: mand.length,
          percent: mand.length ? Math.round((done / mand.length) * 100) : 0, quizAttempts: attempts, lastActivity: lastAt.toISOString(), daysIdle,
          atRisk: e.status === 'ACTIVE' && done < mand.length && daysIdle >= 14 });
      }
      return out;
    };
    if (format === 'csv') {
      // Full export, built in bounded batches (never the whole cohort in memory at once beyond the output rows); hard ceiling, audited.
      const max = Number(process.env.REPORT_CSV_MAX_ROWS ?? 100_000); const rows: any[] = [];
      for (let cur: string | undefined; rows.length < max;) { const ents = await fetch(cur, 500); if (!ents.length) break; cur = ents[ents.length - 1].id; rows.push(...(await build(ents))); }
      await this.prisma.$transaction((tx) => this.audit.record(tx, { actor: a, action: 'report.exported', objectType: 'Report', objectId: 'progress', after: { versionId, cohort, rows: rows.length, truncated: rows.length >= max } }));
      const head = Object.keys(rows[0] ?? { learner: 1 });
      return [head.join(','), ...rows.map((r) => head.map((h) => csvCell((r as any)[h])).join(','))].join('\n');
    }
    const ents = await fetch(cursor, page + 1); const more = ents.length > page; const rows = await build(ents.slice(0, page));
    const summary = { learners: rows.length, avgPercent: rows.length ? Math.round(rows.reduce((s, r) => s + r.percent, 0) / rows.length) : 0, atRisk: rows.filter((r) => r.atRisk).length, scope: 'page' };
    return { summary, rows, nextCursor: more ? ents[page - 1].id : null };
  });
  }
}
