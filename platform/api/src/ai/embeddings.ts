import { external, traceHeaders } from '../platform/trace';
export interface Embedder { readonly model: string; embed(texts: string[]): Promise<number[][]> }
export const EMBEDDER = Symbol('EMBEDDER');

/** OpenRouter embeddings endpoint. Optional: without OPENROUTER_EMBED_MODEL the tutor runs lexical-only. */
export class OpenRouterEmbedder implements Embedder {
  constructor(private apiKey: string, readonly model: string, private baseURL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1') {}
  async embed(texts: string[]): Promise<number[][]> {
    const res = await external('openrouter', 'embeddings', () => fetch(`${this.baseURL}/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...traceHeaders() },
      body: JSON.stringify({ model: this.model, input: texts, provider: { data_collection: 'deny' } }), signal: AbortSignal.timeout(60_000) }));
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    const j: any = await res.json();
    const out = (j.data ?? []).sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding as number[]);
    if (out.length !== texts.length) throw new Error('embedding count mismatch');
    return out;
  }
}
export const buildEmbedder = (env = process.env): Embedder | null =>
  env.OPENROUTER_API_KEY && env.OPENROUTER_EMBED_MODEL ? new OpenRouterEmbedder(env.OPENROUTER_API_KEY, env.OPENROUTER_EMBED_MODEL) : null;
