import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '../ai/config';
import { EMBEDDER, Embedder } from '../ai/embeddings';
import { buildIndex, Index } from '../ai/retrieval';

export interface ChunkMeta { id: string; versionId: string | null; programmeId: string; topicId: string | null; kind: string; ref: string; language: string; title: string; text: string }
interface Loaded { ix: Index; meta: Map<string, ChunkMeta>; stamp: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Versioned retrieval corpus built ONLY from approved material: scene narration, topic outcomes and assignment text of a
 * PUBLISHED/RETIRED version, plus APPROVED FAQs. Quiz content is never indexed (no answer leakage).
 */
@Injectable()
export class TutorIndexService {
  private log = new Logger('tutor-index');
  private cache = new Map<string, Loaded>();
  constructor(private prisma: PrismaService, private config: ConfigService, @Optional() @Inject(EMBEDDER) private embedder: Embedder | null) {}

  async build(versionId: string) {
    const v = await this.prisma.programmeVersion.findUnique({ where: { id: versionId }, include: { programme: true } });
    if (!v) throw new BadRequestException('version not found');
    if (!['PUBLISHED', 'RETIRED'].includes(v.state)) throw new BadRequestException(`version is ${v.state}: only approved content may be indexed`);
    const topics = await this.prisma.topic.findMany({ where: { module: { versionId } }, orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }], include: { assignment: true } });
    const lessonPlans = ((v.provenance as any)?.lessonPlans ?? {}) as Record<string, { lesson_plan?: string }>;
    const rows: Omit<Prisma.TutorChunkCreateManyInput, 'id'>[] = [];
    const add = (r: { topicId: string; kind: string; ref: string; language: string; title: string; text: string }) => {
      if (r.text.trim()) rows.push({ versionId, programmeId: v.programmeId, topicId: r.topicId, kind: r.kind, ref: r.ref, language: r.language, title: r.title, text: r.text.trim(), sourceHash: sha(r.text) });
    };
    for (const t of topics) {
      add({ topicId: t.id, kind: 'TOPIC', ref: `${t.id}#topic`, language: 'en', title: t.title, text: [`${t.title}.`, ...(t.outcomes as string[]), lessonPlans[t.title]?.lesson_plan ?? ''].join(' ') });
      const m = await this.prisma.scriptManifest.findFirst({ where: { topicId: t.id }, orderBy: { rev: 'desc' } });
      for (const s of ((m?.manifest as any)?.scenes ?? []) as any[])
        for (const [lang, narr] of Object.entries(s.narration ?? {}) as [string, string][])
          add({ topicId: t.id, kind: 'SCENE', ref: `${t.id}#${s.id}@rev${m!.rev}`, language: lang, title: t.title, text: [narr, s.on_screen_text].filter(Boolean).join(' ') });
      if (t.assignment) {
        add({ topicId: t.id, kind: 'ASSIGNMENT', ref: `${t.id}#assignment`, language: 'en', title: `${t.title} assignment`, text: t.assignment.instructions });
        const hi = (t.assignment.i18n as any)?.hi?.instructions; if (hi) add({ topicId: t.id, kind: 'ASSIGNMENT', ref: `${t.id}#assignment`, language: 'hi', title: `${t.title} assignment`, text: hi });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.tutorChunk.deleteMany({ where: { versionId } });
      if (rows.length) await tx.tutorChunk.createMany({ data: rows });
    });
    await this.embedPending();
    this.cache.clear();
    return { versionId, chunks: rows.length };
  }

  async stats(versionId: string) {
    const g = await this.prisma.tutorChunk.groupBy({ by: ['kind', 'language'], where: { versionId }, _count: true });
    return { versionId, chunks: g.reduce((s, x) => s + x._count, 0), breakdown: g.map((x) => ({ kind: x.kind, language: x.language, count: x._count })), embeddings: this.embedder?.model ?? null };
  }

  /** FAQ chunk lives at programme level; created in the approving transaction so approval and indexing are atomic. */
  async upsertFaq(tx: Prisma.TransactionClient, faq: { id: string; programmeId: string; topicId: string | null; language: string; question: string; answer: string }) {
    const text = `${faq.question} ${faq.answer}`;
    await tx.tutorChunk.deleteMany({ where: { faqId: faq.id } });
    await tx.tutorChunk.create({ data: { versionId: null, programmeId: faq.programmeId, topicId: faq.topicId, kind: 'FAQ', ref: `faq:${faq.id}`, language: faq.language, title: faq.question, text, sourceHash: sha(text), faqId: faq.id } });
  }
  removeFaq(tx: Prisma.TransactionClient, faqId: string) { return tx.tutorChunk.deleteMany({ where: { faqId } }); }

  /** Best-effort: lexical retrieval keeps working if embedding is unconfigured, switched off, or failing. */
  async embedPending() {
    if (!this.embedder) return;
    try {
      if (process.env.AI_KILL_SWITCH === '1' || (await this.config.get<boolean>('ai.kill_switch'))) return;
      for (;;) {
        const todo = await this.prisma.tutorChunk.findMany({ where: { embeddingModel: null }, take: 64 });
        if (!todo.length) return;
        const vecs = await this.embedder.embed(todo.map((c) => `${c.title}\n${c.text}`));
        await this.prisma.$transaction(todo.map((c, i) => this.prisma.tutorChunk.update({ where: { id: c.id }, data: { embedding: vecs[i], embeddingModel: this.embedder!.model } })));
        await this.prisma.aiCall.create({ data: { useCase: 'embedding', provider: 'openrouter', model: this.embedder.model, status: 'OK', inputTokens: todo.reduce((s, c) => s + Math.ceil(c.text.length / 4), 0) } });
      }
    } catch (e: any) { this.log.warn(`embedding skipped: ${e?.message}`); }
  }

  async embedQuery(q: string): Promise<number[] | undefined> {
    if (!this.embedder) return undefined;
    try { if (process.env.AI_KILL_SWITCH === '1' || (await this.config.get<boolean>('ai.kill_switch'))) return undefined; return (await this.embedder.embed([q]))[0]; } catch { return undefined; }
  }

  /** Cached per (version + FAQ state). Published versions are immutable, so the stamp only moves when FAQs change. */
  async load(versionId: string, programmeId: string): Promise<Loaded> {
    const where = { OR: [{ versionId }, { kind: 'FAQ', programmeId }] };
    if (!(await this.prisma.tutorChunk.count({ where: { versionId } }))) await this.build(versionId); // lazy first build
    const agg = await this.prisma.tutorChunk.aggregate({ where, _count: true, _max: { createdAt: true } });
    const stamp = `${agg._count}:${agg._max.createdAt?.getTime()}:${this.embedder?.model ?? ''}`;
    const key = `${versionId}:${programmeId}`; const hit = this.cache.get(key);
    if (hit && hit.stamp === stamp) return hit;
    const rows = await this.prisma.tutorChunk.findMany({ where });
    const meta = new Map<string, ChunkMeta>(rows.map((r) => [r.id, r as ChunkMeta]));
    const loaded = { ix: buildIndex(rows.map((r) => ({ id: r.id, title: r.title, text: r.text, embedding: r.embedding.length ? r.embedding : undefined }))), meta, stamp };
    this.cache.set(key, loaded); if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return loaded;
  }
}
