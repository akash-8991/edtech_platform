import { external, traceHeaders } from '../platform/trace';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit';
import { AuthService, Ctx, isPrivileged, mfaEnforced } from './auth.service';

interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }
const b64u = (b: Buffer) => b.toString('base64url');

/**
 * OIDC authorization-code + PKCE login (IAM-006 "SSO-ready"). SAML is intentionally not implemented here: put a broker (Keycloak,
 * Entra, Okta) in front and use OIDC. Users are NOT auto-provisioned: an administrator-created account must already exist.
 */
@Injectable()
export class OidcService {
  private disc?: { d: Discovery; at: number };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(private prisma: PrismaService, private auth: AuthService, private audit: AuditService) {}

  private cfg() {
    const e = process.env; if (!e.OIDC_ISSUER || !e.OIDC_CLIENT_ID || !e.OIDC_CLIENT_SECRET || !e.OIDC_REDIRECT_URI) throw new NotFoundException('SSO is not configured');
    return { issuer: e.OIDC_ISSUER.replace(/\/$/, ''), id: e.OIDC_CLIENT_ID, secret: e.OIDC_CLIENT_SECRET, redirect: e.OIDC_REDIRECT_URI, amrMfa: (e.OIDC_MFA_AMR ?? 'mfa,otp,hwk').split(',') };
  }
  private async discovery(): Promise<Discovery> {
    const c = this.cfg(); if (this.disc && Date.now() - this.disc.at < 3_600_000) return this.disc.d;
    const r = await external('idp', 'discovery', () => fetch(`${c.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000), headers: traceHeaders() })); if (!r.ok) throw new BadRequestException('identity provider unavailable');
    const d = (await r.json()) as Discovery; if (d.issuer?.replace(/\/$/, '') !== c.issuer) throw new BadRequestException('issuer mismatch in discovery document');
    this.disc = { d, at: Date.now() }; this.jwks = createRemoteJWKSet(new URL(d.jwks_uri)); return d;
  }

  /** Lets the sign-in page decide whether to show the SSO button without creating a login attempt. */
  available() { const e = process.env; return { enabled: !!(e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET && e.OIDC_REDIRECT_URI), label: e.OIDC_LABEL ?? 'your institute account' }; }

  async start() {
    const c = this.cfg(); const d = await this.discovery();
    const state = b64u(randomBytes(24)), nonce = b64u(randomBytes(24)), verifier = b64u(randomBytes(32));
    await this.prisma.oidcLogin.create({ data: { state, nonce, verifier, expiresAt: new Date(Date.now() + 10 * 60_000) } });
    const q = new URLSearchParams({ response_type: 'code', client_id: c.id, redirect_uri: c.redirect, scope: 'openid email profile', state, nonce, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    return { authorizationUrl: `${d.authorization_endpoint}?${q}` };
  }

  async callback(code: string, state: string, ctx: Ctx) {
    if (!code || !state) throw new BadRequestException('code and state required');
    const c = this.cfg(); const d = await this.discovery();
    const login = await this.prisma.oidcLogin.findUnique({ where: { state } });
    if (!login || login.expiresAt < new Date()) throw new UnauthorizedException();
    await this.prisma.oidcLogin.delete({ where: { state } }).catch(() => { throw new UnauthorizedException(); }); // single use: a replayed callback finds nothing
    const tr = await external('idp', 'token', () => fetch(d.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...traceHeaders() }, signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirect, client_id: c.id, client_secret: c.secret, code_verifier: login.verifier }) }));
    if (!tr.ok) throw new UnauthorizedException();
    const tok: any = await tr.json(); if (!tok.id_token) throw new UnauthorizedException();
    let claims: any;
    try { claims = (await jwtVerify(tok.id_token, this.jwks!, { issuer: c.issuer, audience: c.id })).payload; } catch { throw new UnauthorizedException(); }
    if (claims.nonce !== login.nonce) throw new UnauthorizedException();
    if (claims.email_verified === false || typeof claims.email !== 'string') throw new ForbiddenException('identity provider did not supply a verified email');
    const email = claims.email.toLowerCase();
    let u = await this.prisma.user.findUnique({ where: { externalId: String(claims.sub) }, include: { roles: true } }) ?? await this.prisma.user.findUnique({ where: { email }, include: { roles: true } });
    if (!u || u.status !== 'ACTIVE') throw new ForbiddenException('no active account for this identity');
    if (u.externalId && u.externalId !== String(claims.sub)) throw new ForbiddenException('account is bound to a different identity');
    if (!u.externalId) u = await this.prisma.user.update({ where: { id: u.id }, data: { externalId: String(claims.sub) }, include: { roles: true } });
    const roles = [...new Set(u.roles.map((r) => r.role as string))];
    const amr: string[] = Array.isArray(claims.amr) ? claims.amr : [];
    const idpMfa = amr.some((x) => c.amrMfa.includes(x));
    if (isPrivileged(roles) && mfaEnforced() && !idpMfa) throw new ForbiddenException('privileged accounts must sign in with multi-factor authentication at the identity provider');
    await this.prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date(), failedLogins: 0 } });
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor: null, action: 'auth.login_sso', objectType: 'User', objectId: u!.id, after: { mfa: idpMfa } }));
    return this.auth.issue(u.id, roles, { method: 'OIDC', mfa: idpMfa }, ctx);
  }
}
