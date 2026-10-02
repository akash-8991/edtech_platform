import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './common/prisma.service';
import { Actor, Roles } from './common/auth';
import { ChainVerifier, chainHash, GENESIS } from './domain/audit-chain';

export interface AuditInput {
  actor: Actor | null; action: string; objectType: string; objectId: string;
  before?: unknown; after?: unknown; reason?: string;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /** Must be called inside the same transaction as the change it records: no change without audit (AUD-001). */
  async record(tx: Prisma.TransactionClient, e: AuditInput) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7001)`; // serialise chain appends
    const last = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS;
    const body = {
      actorId: e.actor?.id ?? null, actorRole: e.actor?.roles.join(',') ?? null, action: e.action,
      objectType: e.objectType, objectId: e.objectId, before: e.before ?? null, after: e.after ?? null,
      reason: e.reason ?? null, ip: e.actor?.ip ?? null, correlationId: e.actor?.correlationId ?? null,
    };
    // JSON round-trip so hashed form equals the form read back from JSONB
    const clean = JSON.parse(JSON.stringify(body));
    await tx.auditEvent.create({ data: { ...clean, prevHash, hash: chainHash(prevHash, clean) } });
  }

  /** Streams the chain in keyset batches (bounded memory regardless of table size). */
  async verify(batch = 5000) {
    const v = new ChainVerifier(); let after = 0n;
    for (;;) {
      const rows = await this.prisma.auditEvent.findMany({ where: { seq: { gt: after } }, orderBy: { seq: 'asc' }, take: batch });
      if (!rows.length) break;
      for (const r of rows) v.push({ prevHash: r.prevHash, hash: r.hash, payload: { actorId: r.actorId, actorRole: r.actorRole, action: r.action, objectType: r.objectType, objectId: r.objectId,
        before: r.before, after: r.after, reason: r.reason, ip: r.ip, correlationId: r.correlationId } });
      after = rows[rows.length - 1].seq;
    }
    return { events: v.count, intact: v.broken === null, firstBrokenIndex: v.broken };
  }
}

@Controller('v1/audit')
export class AuditController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get() @Roles('AUDITOR', 'SUPER_ADMIN')
  async list(@Query('objectType') objectType?: string, @Query('objectId') objectId?: string) {
    const rows = await this.prisma.auditEvent.findMany({
      where: { ...(objectType && { objectType }), ...(objectId && { objectId }) }, orderBy: { seq: 'desc' }, take: 200,
    });
    return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
  }

  @Get('verify') @Roles('AUDITOR', 'SUPER_ADMIN')
  verify() { return this.audit.verify(); }
}
