import { Controller, Get, Injectable, Param, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './common/prisma.service';
import { Actor, CurrentActor } from './common/auth';

/** In-app notifications written inside the causing transaction (outbox pattern). Email/SMS/push delivery is a later consumer (D-011). */
@Injectable()
export class NotificationsService {
  notify(tx: Prisma.TransactionClient, userId: string, type: string, payload: object) {
    return tx.notification.create({ data: { userId, type, payload } });
  }
}

@Controller('v1/me/notifications')
export class NotificationsController {
  constructor(private prisma: PrismaService) {}
  @Get() list(@CurrentActor() a: Actor) { return this.prisma.notification.findMany({ where: { userId: a.id }, orderBy: { createdAt: 'desc' }, take: 100 }); }
  @Post(':id/read') async read(@Param('id') id: string, @CurrentActor() a: Actor) {
    await this.prisma.notification.updateMany({ where: { id, userId: a.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }
}
