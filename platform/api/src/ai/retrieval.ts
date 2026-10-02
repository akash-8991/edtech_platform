// Retrieval + grounding primitives for the tutor. Pure and deterministic so they can be tested without a model.

const STOP = new Set(('a an the and or of to in on for with is are was were be been it this that these those as at by from what how why when which who whom do does did can could should would will '
  + 'i you we they he she me my our your their its not no yes if then than so such into about over under between'
  + ' है हैं था थे थी का की के को में से पर और या कि यह वह ये वे एक हो हूँ तो भी नहीं क्या कैसे क्यों कब कौन').split(/\s+/));

export const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2 && !STOP.has(t));

export interface ChunkLike { id: string; text: string; title?: string; embedding?: number[] }
export interface Hit { id: string; score: number; lexical: number; semantic?: number }

export interface Index { chunks: ChunkLike[]; tf: Map<string, number>[]; len: number[]; df: Map<string, number>; avg: number; N: number }

export function buildIndex(chunks: ChunkLike[]): Index {
  const tf = chunks.map((c) => { const m = new Map<string, number>(); tokenize(`${c.title ?? ''} ${c.text}`).forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)); return m; });
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const df = new Map<string, number>(); tf.forEach((m) => m.forEach((_, t) => df.set(t, (df.get(t) ?? 0) + 1)));
  return { chunks, tf, len, df, avg: len.reduce((a, b) => a + b, 0) / (len.length || 1), N: chunks.length };
}

const idf = (ix: Index, t: string) => Math.log(1 + (ix.N - (ix.df.get(t) ?? 0) + 0.5) / ((ix.df.get(t) ?? 0) + 0.5));

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

/**
 * Hybrid search. `lexical` is the idf-weighted share of in-corpus query terms the chunk covers (0..1): an interpretable relevance
 * that does not depend on corpus size, used for the minimum-relevance (no-answer) threshold. BM25 only orders ties.
 * With embeddings the final relevance averages lexical coverage and cosine similarity.
 */
export function search(ix: Index, query: string, k: number, opts: { allow?: (c: ChunkLike) => boolean; queryEmbedding?: number[] } = {}): Hit[] {
  const all = [...new Set(tokenize(query))];
  // Terms found nowhere in the corpus are conversational filler ("explain", "please") or genuinely foreign to the course.
  // They only dampen relevance mildly; a question with NO in-corpus term cannot match anything.
  const q = all.filter((t) => ix.df.has(t));
  const oov = all.length - q.length;
  const totalIdf = q.reduce((s, t) => s + idf(ix, t), 0);
  const hits: (Hit & { bm25: number })[] = [];
  if (!q.length && !opts.queryEmbedding) return [];
  ix.chunks.forEach((c, i) => {
    if (opts.allow && !opts.allow(c)) return;
    let cover = 0, bm = 0, matched = 0;
    for (const t of q) {
      const f = ix.tf[i].get(t); if (!f) continue;
      const w = idf(ix, t); cover += w; matched++;
      bm += w * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (ix.len[i] / (ix.avg || 1)))));
    }
    const lexical = totalIdf && matched ? (cover / totalIdf) * (matched / (matched + 0.25 * oov)) : 0;
    const semantic = opts.queryEmbedding && c.embedding?.length ? Math.max(0, cosine(opts.queryEmbedding, c.embedding)) : undefined;
    const score = semantic === undefined ? lexical : 0.5 * lexical + 0.5 * semantic;
    if (score > 0) hits.push({ id: c.id, score, lexical, semantic, bm25: bm });
  });
  return hits.sort((a, b) => b.score - a.score || b.bm25 - a.bm25).slice(0, k).map(({ bm25, ...h }) => h);
}

/** Share of the answer's content words that occur in the cited sources: cheap lexical grounding check. */
export function groundedness(answer: string, citedTexts: string[]): number {
  const a = [...new Set(tokenize(answer).filter((t) => t.length > 3))];
  if (!a.length) return 0;
  const src = new Set(citedTexts.flatMap(tokenize));
  return a.filter((t) => src.has(t)).length / a.length;
}

/** Assessment integrity: is the learner pasting a graded quiz question? (Jaccard on content tokens) */
export function isGradedQuestion(question: string, quizTexts: string[], threshold = 0.7): boolean {
  const q = new Set(tokenize(question)); if (q.size < 3) return false;
  return quizTexts.some((t) => { const s = new Set(tokenize(t)); const inter = [...q].filter((x) => s.has(x)).length; const uni = new Set([...q, ...s]).size; return uni > 0 && inter / uni >= threshold; });
}

export const REFUSAL_DEFAULT = { en: "I can't find this in your course materials, so I won't guess. I can pass your question to a teacher.", hi: 'यह आपकी कोर्स सामग्री में नहीं मिला, इसलिए मैं अनुमान नहीं लगाऊँगा। मैं आपका प्रश्न शिक्षक तक पहुँचा सकता हूँ।' } as const;
export const GRADED_REFUSAL = { en: "That looks like a graded question, so I can't answer it directly. I can explain the underlying concept if you ask about it.", hi: 'यह एक मूल्यांकित प्रश्न लगता है, इसलिए मैं सीधे उत्तर नहीं दे सकता। आप संबंधित अवधारणा पूछें तो मैं समझा सकता हूँ।' } as const;
export const UNAVAILABLE = { en: 'The tutor is temporarily unavailable. Here is what the course materials say, or you can ask a teacher.', hi: 'ट्यूटर अभी उपलब्ध नहीं है। कोर्स सामग्री के संबंधित अंश नीचे हैं, या आप शिक्षक से पूछ सकते हैं।' } as const;
