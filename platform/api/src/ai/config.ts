import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { Actor } from '../common/auth';
import { AuditService } from '../audit';

type Kind = 'boolean' | 'number' | 'string[]' | 'map' | 'numbermap';
// Whitelisted, typed keys: admins change these without a software release (ADM-001; build prompt: tool lists are configurable).
export const CONFIG_KEYS: Record<string, { kind: Kind; default: unknown; doc: string }> = {
  'ai.kill_switch': { kind: 'boolean', default: false, doc: 'Stops every model call immediately' },
  'ai.daily_budget_usd': { kind: 'number', default: 100, doc: 'Hard daily spend cap across all use cases' },
  'ai.prohibited_terms': { kind: 'string[]', default: [], doc: 'Extra phrases that block generated content' },
  'ai.glossary': { kind: 'map', default: {}, doc: 'English technical term -> locked Hindi rendering (acronyms map to themselves)' },
  'tutor.min_relevance': { kind: 'number', default: 0.4, doc: 'Minimum retrieval relevance (0..1) before the tutor may answer; below it the tutor declines' },
  'tutor.auto_escalate': { kind: 'boolean', default: true, doc: 'Open a doubt ticket automatically after repeated unsupported answers or when the model asks for a teacher' },
  'tutor.per_minute': { kind: 'number', default: 6, doc: 'Max tutor questions per learner per minute' },
  'doubt.sla_minutes': { kind: 'numbermap', default: { P1: 60, P2: 240, P3: 1440 }, doc: 'First-response SLA minutes by priority' },
  'doubt.max_teachers': { kind: 'number', default: 50, doc: 'Maximum active doubt-centre teachers' },
  'grading.sample_rate': { kind: 'number', default: 0.1, doc: 'Share of auto-finalised AI grades also sent for post-hoc faculty quality review (0..1)' },
  'grading.default_confidence_threshold': { kind: 'number', default: 0.8, doc: 'Default minimum calibrated confidence for auto-finalising an AI grade' },
  'grading.appeal_window_days': { kind: 'number', default: 7, doc: 'Days a learner can appeal a released grade' },
  'grading.similarity_threshold': { kind: 'number', default: 0.5, doc: 'Containment (0..1) between two submissions that triggers an integrity flag' },
  'grading.agreement_tolerance_pct': { kind: 'number', default: 10, doc: 'AI and human percent scores within this many points count as agreeing' },
  'grading.min_agreement': { kind: 'number', default: 0.8, doc: 'Minimum AI-human agreement rate for a grader benchmark pass' },
  'grading.max_ai_attempts': { kind: 'number', default: 5, doc: 'Retries while the model is unavailable before a submission goes to human grading' },
  'exam.change_freeze': { kind: 'boolean', default: false, doc: 'Exam-window change freeze: blocks exam definition, session and question-bank edits' },
  'exam.checkin_early_minutes': { kind: 'number', default: 15, doc: 'How early before a session starts a learner may check in' },
  'exam.appeal_window_days': { kind: 'number', default: 7, doc: 'Days a learner can appeal an invalidated or incident-affected exam result' },
  'exam.device_min_bandwidth_kbps': { kind: 'number', default: 500, doc: 'Minimum bandwidth for the pre-exam device check' },
  'lab.cancel_before_hours': { kind: 'number', default: 24, doc: 'Learners may cancel a lab booking up to this many hours before the slot' },
  'security.max_sessions': { kind: 'number', default: 5, doc: 'Concurrent sessions per user; the oldest is revoked beyond this' },
  'security.session_days': { kind: 'number', default: 30, doc: 'Absolute lifetime of a learner session (refresh token chain)' },
  'security.privileged_session_hours': { kind: 'number', default: 12, doc: 'Absolute lifetime of a privileged (staff) session' },
  'retention.notifications_days': { kind: 'number', default: 180, doc: 'Delete read/old in-app notifications after this many days' },
  'retention.tutor_days': { kind: 'number', default: 365, doc: 'Redact tutor conversations this many days after the last message' },
  'retention.webhook_days': { kind: 'number', default: 90, doc: 'Delete proctor webhook payload logs after this many days' },
  'retention.export_days': { kind: 'number', default: 7, doc: 'Delete data-export bundles after this many days' },
  'retention.sessions_days': { kind: 'number', default: 90, doc: 'Delete expired/revoked session records after this many days' },
  productivity_tools: { kind: 'string[]', default: [], doc: 'Named AI-productivity tools the curriculum may teach' },
};

function validate(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    case 'string[]': return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
    case 'numbermap': return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'number' && x >= 0);
    case 'map': return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'string');
  }
}

@Injectable()
export class ConfigService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async get<T = unknown>(key: string): Promise<T> {
    const def = CONFIG_KEYS[key]; if (!def) throw new BadRequestException(`unknown config key ${key}`);
    const row = await this.prisma.platformConfig.findUnique({ where: { key } });
    return (row ? row.value : def.default) as T;
  }

  async set(key: string, value: unknown, actor: Actor) {
    const def = CONFIG_KEYS[key]; if (!def) throw new BadRequestException(`unknown config key ${key}`);
    if (!validate(def.kind, value)) throw new BadRequestException(`value for ${key} must be ${def.kind}`);
    return this.prisma.$transaction(async (tx) => {
      const before = (await tx.platformConfig.findUnique({ where: { key } }))?.value ?? def.default;
      const row = await tx.platformConfig.upsert({ where: { key }, update: { value: value as any, updatedById: actor.id }, create: { key, value: value as any, updatedById: actor.id } });
      await this.audit.record(tx, { actor, action: 'config.changed', objectType: 'PlatformConfig', objectId: key, before, after: value });
      return row;
    });
  }
}
