import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Headers, Inject, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor, Roles } from './common/auth';
import { need } from './common/http';
import { AuditService } from './audit';
import { readBody, ScanProvider, SCANNER, StorageService } from './storage';

const WRITERS = ['ACADEMIC_ADMIN', 'CONTENT_AUTHOR'];
const LABELS = ['master', '720p', '360p', 'audio', 'transcript', 'captions', 'slides'];
const MAX_ASSET = 500 * 1024 * 1024;

/** Authoring of learning components. Only a DRAFT version is editable; components freeze with the version. */
@Controller('v1/authoring')
export class ContentController {
  constructor(private prisma: PrismaService, private audit: AuditService, private storage: StorageService, @Inject(SCANNER) private scanner: ScanProvider) {}

  private async draftTopic(db: PrismaService | any, topicId: string, a: Actor) {
    const t = await db.topic.findUnique({ where: { id: topicId }, include: { module: { include: { version: true } } } });
    if (!t) throw new NotFoundException();
    if (t.module.version.state !== 'DRAFT') throw new ConflictException(`version is ${t.module.version.state}; components are frozen`);
    if (t.module.version.authorId !== a.id && !a.roles.includes('ACADEMIC_ADMIN')) throw new ForbiddenException();
    return t;
  }

  @Put('topics/:id/quiz') @Roles(...WRITERS)
  async quiz(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { questions: 'array' });
    if (!b.questions.length) throw new BadRequestException('at least one question');
    const passPercent = b.passPercent ?? 70, maxAttempts = b.maxAttempts ?? 3;
    if (passPercent < 1 || passPercent > 100 || maxAttempts < 1) throw new BadRequestException('bad pass/attempt config');
    const qs = b.questions.map((q: any, i: number) => {
      if (!['MCQ_SINGLE', 'MCQ_MULTI', 'NUMERIC'].includes(q.type) || typeof q.text !== 'string' || q.answer === undefined) throw new BadRequestException(`question ${i + 1} invalid`);
      if (q.type !== 'NUMERIC' && (!Array.isArray(q.options) || q.options.length < 2)) throw new BadRequestException(`question ${i + 1}: options required`);
      return { position: i + 1, type: q.type, text: q.text, options: q.options ?? [], answer: q.answer, tolerance: q.tolerance ?? 0, points: q.points ?? 1, rationale: q.rationale, ...(q.i18n && { i18n: q.i18n }) };
    });
    return this.prisma.$transaction(async (tx) => {
      await this.draftTopic(tx, id, a);
      const old = await tx.quiz.findUnique({ where: { topicId: id } });
      if (old) { await tx.question.deleteMany({ where: { quizId: old.id } }); await tx.quiz.delete({ where: { id: old.id } }); }
      const q = await tx.quiz.create({ data: { topicId: id, passPercent, maxAttempts, questions: { create: qs } } });
      await this.audit.record(tx, { actor: a, action: 'topic.quiz_set', objectType: 'Topic', objectId: id, after: { questions: qs.length, passPercent, maxAttempts } });
      return { id: q.id, questions: qs.length };
    });
  }

  @Put('topics/:id/assignment') @Roles(...WRITERS)
  async assignment(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { instructions: 'string' });
    return this.prisma.$transaction(async (tx) => {
      await this.draftTopic(tx, id, a);
      const data = { instructions: b.instructions, rubric: b.rubric ?? {}, maxSubmissions: b.maxSubmissions ?? 3 };
      const r = await tx.assignment.upsert({ where: { topicId: id }, update: data, create: { topicId: id, ...data } });
      await this.audit.record(tx, { actor: a, action: 'topic.assignment_set', objectType: 'Topic', objectId: id, after: { maxSubmissions: data.maxSubmissions } });
      return r;
    });
  }

  @Post('topics/:id/assets') @Roles(...WRITERS)
  async registerAsset(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) {
    need(b, { language: 'string', durationSec: 'number' });
    if (!['en', 'hi'].includes(b.language)) throw new BadRequestException('language en|hi');
    return this.prisma.$transaction(async (tx) => {
      await this.draftTopic(tx, id, a);
      const ix = Array.isArray(b.interactions) ? b.interactions : [];
      if (ix.some((i: any) => typeof i?.id !== 'string' || typeof i.atSec !== 'number' || i.atSec > b.durationSec)) throw new BadRequestException('interactions need id and atSec within duration');
      // provenance (VID-006): model/provider/prompt hash/sources, e.g. from video_engine/provenance.json
      const asset = await tx.contentAsset.create({ data: { topicId: id, kind: b.kind ?? 'VIDEO', language: b.language, durationSec: b.durationSec, interactions: ix, provenance: b.provenance ?? {}, rights: b.rights ?? {}, createdById: a.id } });
      await this.audit.record(tx, { actor: a, action: 'asset.registered', objectType: 'ContentAsset', objectId: asset.id, after: { topicId: id, language: b.language, provenance: asset.provenance, rights: asset.rights } });
      return asset;
    });
  }

  // Raw-body upload; optional x-checksum-sha256 verified server-side. Content-addressed key: immutable once written.
  @Put('assets/:id/files/:label') @Roles(...WRITERS)
  async upload(@Param('id') id: string, @Param('label') label: string, @Headers('x-checksum-sha256') sum: string | undefined, @Req() req: any, @CurrentActor() a: Actor) {
    if (!LABELS.includes(label)) throw new BadRequestException(`label must be one of ${LABELS.join(',')}`);
    const asset = await this.prisma.contentAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException();
    await this.draftTopic(this.prisma, asset.topicId, a);
    const data = await readBody(req, MAX_ASSET);
    if (!data.length) throw new BadRequestException('empty body');
    // Inline scan up to SCAN_MAX_BYTES; larger masters (staff-authored video) are recorded as unscanned in the audit trail (D-078).
    const scanned = data.length <= Number(process.env.SCAN_MAX_BYTES ?? 25 * 1024 * 1024);
    if (scanned && (await this.scanner.scan(data, label)) !== 'CLEAN') throw new BadRequestException('file rejected by malware scan');
    const key = `assets/${id}/${label}`;
    const f = await this.storage.put(key, data);
    if (sum && sum.toLowerCase() !== f.checksum) throw new BadRequestException('checksum mismatch');
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.contentAsset.findUniqueOrThrow({ where: { id } });
      const files = { ...(cur.files as object), [label]: { key, checksum: f.checksum, size: f.size } };
      const u = await tx.contentAsset.update({ where: { id }, data: { files } });
      await this.audit.record(tx, { actor: a, action: 'asset.file_uploaded', objectType: 'ContentAsset', objectId: id, after: { label, checksum: f.checksum, size: f.size, scan: scanned ? 'clean' : 'skipped_oversize' } });
      return u;
    });
  }
}
