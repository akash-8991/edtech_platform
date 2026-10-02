import { Controller, Get, Injectable, Post } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { metrics } from '../platform/metrics';
import { Roles } from '../common/auth';
import { AuditService } from '../audit';
import { ChainVerifier, chainHash, GENESIS, verifyChain } from '../domain/audit-chain';

export interface IntegrityReport { ok: boolean; checkedAt: string; audit: { events: number; intact: boolean; firstBroken: number | null }; examLogs: { attempts: number; broken: string[] }; counts: Record<string, number>; orphans: Record<string, number> }

/**
 * Whole-database integrity check used by the disaster-recovery drill (after a restore), by operators, and as a periodic job: verifies
 * every tamper-evident chain and the core referential relationships the schema does not enforce with foreign keys.
 */
@Injectable()
export class IntegrityService {
  private last: { ok: boolean; at: number } | null = null;
  constructor(private prisma: PrismaService, private audit: AuditService) {
    // absent until the first run (alert rules treat "never ran" as stale, not as healthy)
    metrics.gauge('integrity_ok', '1 if the last scheduled integrity check passed, 0 if it failed', () => (this.last ? [{ value: this.last.ok ? 1 : 0 }] : []));
    metrics.gauge('integrity_last_run_timestamp_seconds', 'When the last scheduled integrity check finished', () => (this.last ? [{ value: Math.floor(this.last.at / 1000) }] : []));
  }

  /** Called by the worker every INTEGRITY_CHECK_HOURS (default 6). Failure is logged at error level and exported as integrity_ok=0. */
  async runScheduled(): Promise<IntegrityReport> {
    const r = await this.verify(); this.last = { ok: r.ok, at: Date.now() };
    if (!r.ok) process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ctx: 'integrity', msg: 'integrity check FAILED', audit: r.audit, brokenExamLogs: r.examLogs.broken.length, orphans: r.orphans }) + '\n');
    return r;
  }

  async verify(): Promise<IntegrityReport> {
    const audit = await this.audit.verify(); const bad = audit.firstBrokenIndex;
    // One keyset pass over all exam events ordered (attemptId, seq): bounded memory, one verifier per attempt.
    const broken: string[] = []; let attempts = 0; let cur: { id: string; v: ChainVerifier; expectSeq: number; seqOk: boolean } | null = null;
    const close = () => { if (cur && (cur.v.broken !== null || !cur.seqOk)) broken.push(cur.id); };
    let last: { attemptId: string; seq: number } | null = null;
    for (;;) {
      const rows: any[] = await this.prisma.examEvent.findMany({ where: last ? { OR: [{ attemptId: { gt: last.attemptId } }, { attemptId: last.attemptId, seq: { gt: last.seq } }] } : {}, orderBy: [{ attemptId: 'asc' }, { seq: 'asc' }], take: 5000 });
      if (!rows.length) break;
      for (const r of rows) {
        if (!cur || cur.id !== r.attemptId) { close(); cur = { id: r.attemptId, v: new ChainVerifier(), expectSeq: 1, seqOk: true }; attempts++; }
        cur.v.push({ prevHash: r.prevHash, hash: r.hash, payload: { attemptId: r.attemptId, seq: r.seq, type: r.type, payload: r.payload, at: r.at.toISOString() } });
        if (r.seq !== cur.expectSeq++) cur.seqOk = false;
      }
      last = { attemptId: rows[rows.length - 1].attemptId, seq: rows[rows.length - 1].seq };
    }
    close();
    const q = async (sql: string) => Number(((await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0]?.n) ?? 0);
    const counts: Record<string, number> = {};
    for (const [k, t] of Object.entries({ users: 'User', entitlements: 'Entitlement', submissions: 'Submission', gradeRecords: 'GradeRecord', examAttempts: 'ExamAttempt', examSubmissions: 'ExamSubmission', learningEvents: 'LearningEvent', tutorMessages: 'TutorMessage', auditEvents: 'AuditEvent' })) counts[k] = await q(`SELECT count(*)::bigint AS n FROM "${t}"`);
    const orphans = {
      submissionsWithoutGradeState: await q(`SELECT count(*)::bigint n FROM "Submission" s LEFT JOIN "SubmissionGrade" g ON g."submissionId" = s.id WHERE g."submissionId" IS NULL`),
      gradesPointingAtMissingRecord: await q(`SELECT count(*)::bigint n FROM "SubmissionGrade" g WHERE g."currentSeq" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "GradeRecord" r WHERE r."submissionId" = g."submissionId" AND r.seq = g."currentSeq")`),
      submittedAttemptsWithoutReceipt: await q(`SELECT count(*)::bigint n FROM "ExamAttempt" a LEFT JOIN "ExamSubmission" s ON s."attemptId" = a.id WHERE a.status = 'SUBMITTED' AND s."attemptId" IS NULL`),
      entitlementsWithoutUser: await q(`SELECT count(*)::bigint n FROM "Entitlement" e LEFT JOIN "User" u ON u.id = e."learnerId" WHERE u.id IS NULL`),
      progressWithoutEntitlement: await q(`SELECT count(*)::bigint n FROM "TopicProgress" p LEFT JOIN "Entitlement" e ON e.id = p."entitlementId" WHERE e.id IS NULL`),
    };
    const ok = bad === null && broken.length === 0 && Object.values(orphans).every((n) => n === 0);
    return { ok, checkedAt: new Date().toISOString(), audit: { events: audit.events, intact: bad === null, firstBroken: bad }, examLogs: { attempts, broken }, counts, orphans };
  }
}

@Controller('v1/ops')
export class OpsController {
  constructor(private integrity: IntegrityService) {}
  @Get('integrity') @Roles('PLATFORM_ADMIN', 'SUPER_ADMIN', 'AUDITOR') report() { return this.integrity.verify(); }
}
export { chainHash, GENESIS };
