import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
import { AppModule } from '../src/app.module';
import { JobWorker } from '../src/ai/generation';

const prisma = new PrismaClient(); let app: INestApplication;
beforeAll(async () => { await prisma.generationJob.deleteMany({}); app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(); await app.init(); });
afterAll(async () => { delete process.env.WORKER_JOB_KINDS; await prisma.generationJob.deleteMany({}); await app.close(); await prisma.$disconnect(); });

describe('a worker limited to some kinds of job (the grader host only grades; the general worker never grades)', () => {
  const add = (kind: string) => prisma.generationJob.create({ data: { kind, input: {}, requestedById: 'u' } });
  it('claims only its own kinds and leaves the rest queued', async () => {
    const t = await add('TRANSCODE'); const g = await add('GRADE_SUBMISSION'); const w = app.get(JobWorker);
    process.env.WORKER_JOB_KINDS = 'CURRICULUM,TOPIC_CONTENT,TRANSCODE'; expect(await w.runOnce()).toBe(true); expect(await w.runOnce()).toBe(false); // the general worker takes the transcode, never the grading job
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('QUEUED'); expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: t.id } })).status).not.toBe('QUEUED');
    process.env.WORKER_JOB_KINDS = 'GRADE_SUBMISSION'; expect(await w.runOnce()).toBe(true); expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: g.id } })).status).not.toBe('QUEUED'); // the grader takes it
  });
  it('with no limit set, a worker takes any kind (the default for a small pilot)', async () => {
    delete process.env.WORKER_JOB_KINDS; const j = await add('TOPIC_CONTENT'); expect(await app.get(JobWorker).runOnce()).toBe(true); expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: j.id } })).status).not.toBe('QUEUED');
  });
});
