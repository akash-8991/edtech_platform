import { HttpException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AI_PROVIDERS, Effort, ProviderMap, RefusalError } from './providers';
import { ConfigService } from './config';
import { external } from '../platform/trace';
import { redactPii } from './quality';

export type UseCase = 'curriculum' | 'topic_content' | 'translation' | 'judge' | 'evaluation' | 'tutor' | 'grading';
export interface Route { provider: 'anthropic' | 'openrouter'; model: string; effort?: Effort; maxTokens: number }

export class AiDisabledError extends HttpException { constructor() { super({ error: 'ai_disabled', message: 'AI generation is switched off' }, 503); } }
export class AiLimitError extends HttpException { constructor(what: string) { super({ error: 'ai_limit', message: what }, 429); } }
export class AiUnavailableError extends HttpException { constructor(public attempts: unknown[]) { super({ error: 'ai_unavailable', attempts }, 502); } }

// USD per 1M tokens (first-party list prices) for cost telemetry; OpenRouter reports its own cost per call.
export const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 }, 'claude-opus-5': { in: 5, out: 25 }, 'claude-sonnet-5-5': { in: 2, out: 10 }, 'claude-haiku-4-5': { in: 1, out: 5 },
};
export const costOf = (model: string, i: number, o: number) => { const p = PRICES[model]; return p ? (i * p.in + o * p.out) / 1e6 : 0; };

/** Use-case routing: ordered provider/model list, first healthy wins. Override via AI_ROUTES_JSON (must be allow-listed). */
export function defaultRoutes(env = process.env): Record<UseCase, Route[]> {
  const a = env.AI_ANTHROPIC_MODEL ?? 'claude-opus-5-5';
  const or = env.OPENROUTER_MODEL; // no default: OpenRouter slugs are deployment config, not assumed
  const mk = (effort: Effort, maxTokens: number): Route[] => [
    { provider: 'anthropic', model: a, effort, maxTokens },
    ...(or ? [{ provider: 'openrouter' as const, model: or, maxTokens }] : []),
  ];
  return { curriculum: mk('high', 32_000), topic_content: mk('medium', 32_000), translation: mk('medium', 16_000), judge: mk('low', 8_000), evaluation: mk('medium', 32_000), tutor: mk('low', 3_000), grading: mk('high', 8_000) };
}

export interface RunOpts {
  useCase: UseCase; system: string; user: string; schema: object; schemaName: string;
  promptKey?: string; promptVersion?: number; jobId?: string; actorId?: string;
}
export interface RunResult<T = unknown> { json: T; provider: string; model: string; costUsd: number; inputTokens: number; outputTokens: number; requestId?: string; redactions: number }

@Injectable()
export class GatewayService {
  constructor(@Inject(AI_PROVIDERS) private providers: ProviderMap, private prisma: PrismaService, private config: ConfigService) {}

  private routes(useCase: UseCase): Route[] {
    const custom = process.env.AI_ROUTES_JSON;
    const defaults = defaultRoutes();
    const allow = new Set((process.env.AI_MODEL_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    Object.values(defaults).flat().forEach((r) => allow.add(`${r.provider}:${r.model}`));
    const routes: Route[] = custom ? (JSON.parse(custom)[useCase] ?? defaults[useCase]) : defaults[useCase];
    return routes.filter((r) => allow.has(`${r.provider}:${r.model}`)); // fail closed on anything not allow-listed
  }

  async run<T = unknown>(o: RunOpts): Promise<RunResult<T>> {
    if (process.env.AI_KILL_SWITCH === '1' || (await this.config.get<boolean>('ai.kill_switch'))) throw new AiDisabledError();
    const perHour = Number(process.env.AI_RATE_PER_HOUR ?? 200);
    if (o.actorId && (await this.prisma.aiCall.count({ where: { actorId: o.actorId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } })) >= perHour) throw new AiLimitError(`rate limit ${perHour} model calls/hour`);
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const spent = (await this.prisma.aiCall.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: midnight } } }))._sum.costUsd ?? 0;
    if (spent >= (await this.config.get<number>('ai.daily_budget_usd'))) throw new AiLimitError('daily AI budget exhausted');

    const red = redactPii(o.user); // data minimisation: strip PII before it leaves
    const attempts: { provider: string; model: string; error: string }[] = [];
    for (const r of this.routes(o.useCase)) {
      const provider = this.providers[r.provider];
      const base = { useCase: o.useCase, provider: r.provider, model: r.model, promptKey: o.promptKey, promptVersion: o.promptVersion, jobId: o.jobId, actorId: o.actorId, piiRedactions: red.count };
      if (!provider) { attempts.push({ provider: r.provider, model: r.model, error: 'not_configured' }); continue; }
      const t0 = Date.now();
      try {
        const res = await external(provider.name, 'complete', () => provider.complete({ model: r.model, system: o.system, user: red.text, schema: o.schema, schemaName: o.schemaName, maxTokens: r.maxTokens, effort: r.effort }));
        const cost = res.costUsd ?? costOf(r.model, res.inputTokens, res.outputTokens);
        await this.prisma.aiCall.create({ data: { ...base, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost, latencyMs: Date.now() - t0, status: 'OK' } });
        return { json: res.json as T, provider: r.provider, model: res.model ?? r.model, costUsd: cost, inputTokens: res.inputTokens, outputTokens: res.outputTokens, requestId: res.requestId, redactions: red.count };
      } catch (e: any) {
        const refusal = e instanceof RefusalError;
        await this.prisma.aiCall.create({ data: { ...base, latencyMs: Date.now() - t0, status: refusal ? 'REFUSAL' : 'ERROR', errorCode: e?.code ?? 'error' } });
        attempts.push({ provider: r.provider, model: r.model, error: `${e?.code ?? 'error'}: ${String(e?.message ?? e).slice(0, 160)}` });
      }
    }
    throw new AiUnavailableError(attempts);
  }
}
