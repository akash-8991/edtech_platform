import { Controller, Get, Headers, HttpException, NotFoundException, Header, Optional } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { metrics } from './metrics';
import { ConfigService } from '../ai/config';

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

@Controller()
export class HealthController {
  constructor(private prisma: PrismaService, @Optional() config?: ConfigService) {
    if (config) metrics.gauge('ai_budget_usd_daily', 'Configured daily AI spend cap', async () => [{ value: await config.get<number>('ai.daily_budget_usd') }]);
    metrics.gauge('jobs_queue_depth', 'Background jobs by kind/status', async () => (await prisma.generationJob.groupBy({ by: ['kind', 'status'], where: { status: { in: ['QUEUED', 'RUNNING'] } }, _count: true })).map((g) => ({ labels: { kind: g.kind, status: g.status }, value: g._count })));
    metrics.gauge('grading_pending_submissions', 'Submissions waiting for AI grading', async () => [{ value: await prisma.submissionGrade.count({ where: { state: 'PENDING_AI' } }) }]);
    metrics.gauge('exam_attempts_in_progress', 'Exam attempts currently in progress', async () => [{ value: await prisma.examAttempt.count({ where: { status: 'IN_PROGRESS' } }) }]);
    metrics.gauge('exam_incidents_open', 'Open exam incidents by severity', async () => (await prisma.incident.groupBy({ by: ['severity'], where: { status: { in: ['OPEN', 'NEEDS_INFO'] } }, _count: true })).map((g) => ({ labels: { severity: g.severity }, value: g._count })));
    metrics.gauge('ai_cost_usd_today', 'Model spend since UTC midnight', async () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return [{ value: (await prisma.aiCall.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: d } } }))._sum.costUsd ?? 0 }]; });
    metrics.gauge('doubt_tickets_unassigned', 'Doubt tickets waiting for a teacher', async () => [{ value: await prisma.doubtTicket.count({ where: { status: 'NEW', assignedTeacherId: null } }) }]);
  }

  @Public() @Get('health') live() { return { status: 'ok' }; }

  /** Readiness: only report ready when the database answers (load balancers stop sending traffic otherwise). */
  @Public() @Get('health/ready')
  async ready() {
    try { await Promise.race([this.prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2000))]); return { status: 'ready' }; }
    catch { throw new HttpException({ status: 'not_ready', reason: 'database unavailable' }, 503); }
  }

  /** Prometheus scrape. Disabled unless METRICS_TOKEN is set; bearer token compared in constant time. */
  @Public() @Get('metrics') @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(@Headers('authorization') auth?: string) {
    const t = process.env.METRICS_TOKEN; if (!t) throw new NotFoundException();
    if (!auth?.startsWith('Bearer ') || !eq(auth.slice(7), t)) throw new HttpException('unauthorized', 401);
    return metrics.render();
  }
}
