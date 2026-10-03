import { CodeDto, LoginDto, MfaVerifyDto, PasswordChangeDto, RefreshDto } from '../common/dto';
import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { Actor, CurrentActor, Public, Roles } from '../common/auth';
import { need } from '../common/http';
import { AuthService, Ctx } from './auth.service';
import { SessionService } from './sessions';
import { OidcService } from './oidc';

const ctxOf = (req: any): Ctx => ({ ip: req.ip, ua: req.headers['user-agent'], label: req.headers['x-device-label'] });
const bearer = (h?: string) => { if (!h?.startsWith('Bearer ')) throw new BadRequestException('Authorization: Bearer <token> required'); return h.slice(7); };

@Controller('v1')
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService, private sessions: SessionService, private oidc: OidcService) {}

  @Public() @Post('auth/login') @HttpCode(201)
  login(@Body() b: LoginDto, @Req() req: any) { need(b, { email: 'string', password: 'string' }); return this.auth.login(b.email, b.password, ctxOf(req)); }
  @Public() @Post('auth/mfa/verify') @HttpCode(201)
  mfa(@Body() b: MfaVerifyDto, @Req() req: any) { need(b, { mfaToken: 'string', code: 'string' }); return this.auth.verifyMfa(b.mfaToken, b.code, ctxOf(req)); }
  @Public() @Post('auth/mfa/enroll/start') @HttpCode(201)
  enrollStart(@Headers('authorization') h?: string) { return this.auth.enrollStart(bearer(h)); }
  @Public() @Post('auth/mfa/enroll/confirm') @HttpCode(201)
  enrollConfirm(@Headers('authorization') h: string | undefined, @Body() b: CodeDto, @Req() req: any) { need(b, { code: 'string' }); return this.auth.enrollConfirm(bearer(h), b.code, ctxOf(req)); }
  @Public() @Post('auth/refresh') @HttpCode(201)
  refresh(@Body() b: RefreshDto, @Req() req: any) { need(b, { refreshToken: 'string' }); return this.auth.refresh(b.refreshToken, ctxOf(req)); }
  @Post('auth/logout') @HttpCode(201) logout(@CurrentActor() a: Actor) { return this.auth.logout(a); }
  @Post('auth/password') @HttpCode(201) password(@Body() b: PasswordChangeDto, @CurrentActor() a: Actor) { need(b, { current: 'string', next: 'string' }); return this.auth.changePassword(a, b.current, b.next); }

  @Get('auth/me')
  async me(@CurrentActor() a: Actor) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: a.id }, select: { id: true, email: true, name: true, language: true, mfaEnabled: true } });
    return { ...u, roles: a.roles, sessionId: a.sid };
  }

  // ---- sessions & devices ---------------------------------------------------------------------------------------------------------------
  @Get('me/sessions')
  async mine(@CurrentActor() a: Actor) {
    const rows = await this.prisma.userSession.findMany({ where: { userId: a.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
    return rows.map((s) => ({ id: s.id, current: s.id === a.sid, method: s.authMethod, mfa: s.mfa, device: s.deviceLabel, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt }));
  }
  @Delete('me/sessions/:id')
  async revokeMine(@Param('id') id: string, @CurrentActor() a: Actor) {
    const s = await this.prisma.userSession.findFirst({ where: { id, userId: a.id } }); if (!s) throw new NotFoundException();
    await this.sessions.revoke(id, 'user_revoked'); return { ok: true };
  }
  @Post('admin/users/:id/revoke-sessions') @Roles('PLATFORM_ADMIN', 'SUPER_ADMIN', 'SUPPORT_OPERATOR') @HttpCode(201)
  adminRevoke(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.auth.adminRevoke(a, id, b?.reason); }
  @Post('admin/users/:id/mfa-reset') @Roles('PLATFORM_ADMIN', 'SUPER_ADMIN') @HttpCode(201)
  mfaReset(@Param('id') id: string, @Body() b: any, @CurrentActor() a: Actor) { return this.auth.adminMfaReset(a, id, b?.reason); }

  // ---- OIDC single sign-on --------------------------------------------------------------------------------------------------------------------
  @Public() @Get('auth/sso/config') ssoConfig() { return this.oidc.available(); }
  @Public() @Get('auth/sso/start') sso() { return this.oidc.start(); }
  @Public() @Get('auth/sso/callback') ssoCallback(@Query('code') code: string, @Query('state') state: string, @Req() req: any) { return this.oidc.callback(code, state, ctxOf(req)); }
}
