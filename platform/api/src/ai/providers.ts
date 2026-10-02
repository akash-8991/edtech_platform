import { traceHeaders } from '../platform/trace';
import Anthropic from '@anthropic-ai/sdk';

export type Effort = 'low' | 'medium' | 'high';
export interface CompleteRequest {
  model: string; system: string; user: string; schema: object; schemaName: string;
  maxTokens: number; effort?: Effort; timeoutMs?: number;
}
export interface CompleteResult { json: unknown; text: string; inputTokens: number; outputTokens: number; costUsd?: number; requestId?: string; model: string }
export interface Provider { readonly name: 'anthropic' | 'openrouter'; complete(r: CompleteRequest): Promise<CompleteResult> }

/** A safety classifier declined: do not retry the same provider, let the gateway fall back. */
export class RefusalError extends Error { code = 'refusal'; }
export class ProviderError extends Error { constructor(msg: string, public code: string, public retryable = false, public status?: number) { super(msg); } }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ProviderError('model returned invalid JSON', 'invalid_json'); }
}

/** Claude via the official SDK. Thinking is always on for these models; depth is controlled with output_config.effort. */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic' as const;
  private client: Anthropic;
  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2 }); // SDK retries 408/409/429/5xx
  }
  async complete(r: CompleteRequest): Promise<CompleteResult> {
    try {
      // Streaming: structured generations are long and would otherwise risk request timeouts.
      const stream = this.client.messages.stream({
        model: r.model, max_tokens: r.maxTokens, system: r.system, messages: [{ role: 'user', content: r.user }],
        output_config: { effort: r.effort ?? 'medium', format: { type: 'json_schema', schema: r.schema } },
      } as any, { timeout: r.timeoutMs ?? 10 * 60_000, headers: traceHeaders() });
      const msg = await stream.finalMessage();
      if ((msg.stop_reason as string) === 'refusal') throw new RefusalError(`refused: ${JSON.stringify((msg as any).stop_details ?? {})}`);
      if (msg.stop_reason === 'max_tokens') throw new ProviderError('output truncated at max_tokens', 'truncated');
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { json: parseJson(text), text, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, requestId: msg.id, model: msg.model };
    } catch (e) {
      if (e instanceof RefusalError || e instanceof ProviderError) throw e;
      if (e instanceof Anthropic.APIError) throw new ProviderError(e.message, `http_${e.status ?? 'x'}`, false, e.status);
      throw new ProviderError(String((e as Error)?.message ?? e), 'network');
    }
  }
}

/** OpenRouter (OpenAI-compatible). Data-collection denied per request: provider must not retain/train on institute data. */
export class OpenRouterProvider implements Provider {
  readonly name = 'openrouter' as const;
  constructor(private apiKey: string, private baseURL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1') {}
  async complete(r: CompleteRequest): Promise<CompleteResult> {
    const body = {
      model: r.model, max_tokens: r.maxTokens,
      messages: [{ role: 'system', content: r.system }, { role: 'user', content: r.user }],
      response_format: { type: 'json_schema', json_schema: { name: r.schemaName, strict: true, schema: r.schema } },
      provider: { data_collection: 'deny', require_parameters: true },
      usage: { include: true },
    };
    const base = Number(process.env.AI_RETRY_BASE_MS ?? 500);
    let last: ProviderError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(base * 2 ** (attempt - 1));
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), r.timeoutMs ?? 10 * 60_000);
      try {
        const res = await fetch(`${this.baseURL}/chat/completions`, { method: 'POST', signal: ctl.signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'EdTech Platform', ...traceHeaders() }, body: JSON.stringify(body) });
        if (res.status === 429 || res.status >= 500) { last = new ProviderError(`HTTP ${res.status}`, `http_${res.status}`, true, res.status); continue; }
        if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, `http_${res.status}`, false, res.status);
        const j: any = await res.json();
        const choice = j.choices?.[0];
        if (choice?.finish_reason === 'content_filter') throw new RefusalError('content filtered');
        if (choice?.finish_reason === 'length') throw new ProviderError('output truncated', 'truncated');
        const text: string = choice?.message?.content ?? '';
        return { json: parseJson(text), text, inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0, costUsd: typeof j.usage?.cost === 'number' ? j.usage.cost : undefined, requestId: j.id, model: j.model ?? r.model };
      } catch (e) {
        if (e instanceof ProviderError && !e.retryable) throw e;
        if (e instanceof RefusalError) throw e;
        last = e instanceof ProviderError ? e : new ProviderError(String((e as Error)?.message ?? e), 'network', true);
      } finally { clearTimeout(t); }
    }
    throw last ?? new ProviderError('unavailable', 'unavailable');
  }
}

export const AI_PROVIDERS = Symbol('AI_PROVIDERS');
export type ProviderMap = Partial<Record<'anthropic' | 'openrouter', Provider>>;

/** Providers are constructed only when credentials exist; a missing key just removes that route. */
export function buildProviders(env = process.env): ProviderMap {
  const m: ProviderMap = {};
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) m.anthropic = new AnthropicProvider({ baseURL: env.ANTHROPIC_BASE_URL });
  if (env.OPENROUTER_API_KEY) m.openrouter = new OpenRouterProvider(env.OPENROUTER_API_KEY);
  return m;
}
