import { Controller, ForbiddenException, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { paged } from './common/page';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor } from './common/auth';
import { hasLearningAccess } from './domain/entitlement';

@Controller('v1/catalogue')
export class CatalogueController {
  constructor(private prisma: PrismaService) {}

  // Only PUBLISHED versions are ever visible here; unpublished assets never reach learners.
  @Get()
  async list(@Res({ passthrough: true }) res: any, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const vs = await paged(res, limit, cursor, (a) => this.prisma.programmeVersion.findMany({ where: { state: 'PUBLISHED' }, include: { programme: true }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], ...a }), 100, 200);
    return vs.map((v) => ({ versionId: v.id, code: v.programme.code, title: v.programme.title, discipline: v.programme.discipline, version: v.version, hours: v.hours, languages: v.languages }));
  }

  @Get('versions/:id')
  async detail(@Param('id') id: string, @CurrentActor() a: Actor) {
    const v = await this.prisma.programmeVersion.findFirst({ where: { id, state: 'PUBLISHED' }, include: { programme: true, modules: { orderBy: { position: 'asc' }, include: { topics: { orderBy: { position: 'asc' } } } } } });
    if (!v) throw new NotFoundException();
    if (a.roles.length === 1 && a.roles[0] === 'LEARNER') {
      const e = await this.prisma.entitlement.findUnique({ where: { learnerId_versionId: { learnerId: a.id, versionId: id } } });
      if (!e || !hasLearningAccess(e, new Date())) throw new ForbiddenException('no active entitlement');
    }
    const { authorId, provenance, ...safe } = v as any;
    return safe;
  }
}
