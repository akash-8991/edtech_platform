import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
process.env.JWT_SECRET = 'test-secret';
process.env.ADMISSIONS_HMAC_SECRET = 'hmac-secret';
// eslint-disable-next-line import/first
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/common/auth';
import { temporaryPassword, UsersService } from '../src/security/users';
import { passwordIssues } from '../src/domain/totp';

const prisma = new PrismaClient();
let app: INestApplication; let http: any;
const tok: Record<string, string> = {}; const id: Record<string, string> = {};
async function mk(key: string, role: string) {
  const u = await prisma.user.create({ data: { email: `${key}@x.test`, name: `Name ${key}`, passwordHash: hashPassword('pw-pw-pw-pw-1'), roles: { create: { role: role as any } } } }); id[key] = u.id;
  tok[key] = (await http.post('/v1/auth/login').send({ email: `${key}@x.test`, password: 'pw-pw-pw-pw-1' })).body.accessToken;
}
const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
const login = (email: string, password: string) => http.post('/v1/auth/login').send({ email, password });

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "AuditEvent","UserSession","TeacherProfile","UserRole","User" RESTART IDENTITY CASCADE');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ rawBody: true } as any); await app.init(); http = request(app.getHttpServer());
  await mk('sup', 'SUPER_ADMIN'); await mk('plat', 'PLATFORM_ADMIN'); await mk('audit', 'AUDITOR'); await mk('help', 'SUPPORT_OPERATOR'); await mk('acad', 'ACADEMIC_ADMIN'); await mk('learner', 'LEARNER'); await mk('victim', 'CONTENT_AUTHOR');
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe('temporary passwords', () => {
  it('always satisfy the password policy and are not guessable', () => { const seen = new Set<string>(); for (let i = 0; i < 200; i++) { const p = temporaryPassword('someone@x.test'); expect(passwordIssues(p, 'someone@x.test')).toEqual([]); seen.add(p); } expect(seen.size).toBe(200); });
});

describe('who may use the user directory', () => {
  it('reads: super, platform, auditor and support; academic admins only when looking up doubt teachers; never learners', async () => {
    for (const k of ['sup', 'plat', 'audit', 'help']) await http.get('/v1/admin/users').set(as(k)).expect(200);
    await http.get('/v1/admin/users').set(as('learner')).expect(403); await http.get('/v1/admin/users').expect(401);
    await http.get('/v1/admin/users').set(as('acad')).expect(403); await http.get('/v1/admin/users?role=CONTENT_AUTHOR').set(as('acad')).expect(403); await http.get('/v1/admin/users?role=DOUBT_TEACHER').set(as('acad')).expect(200);
  });
  it('writes: only super and platform admins', async () => {
    for (const k of ['audit', 'help', 'acad', 'learner']) { await http.post('/v1/admin/users').set(as(k)).send({ email: 'n@x.test', name: 'N', roles: ['LEARNER'] }).expect(403); await http.post(`/v1/admin/users/${id.victim}/status`).set(as(k)).send({ status: 'SUSPENDED', reason: 'x' }).expect(403); await http.post(`/v1/admin/users/${id.victim}/roles`).set(as(k)).send({ add: ['AUDITOR'], reason: 'x' }).expect(403); await http.post(`/v1/admin/users/${id.victim}/reset-password`).set(as(k)).send({ reason: 'x' }).expect(403); }
    await http.get(`/v1/admin/users/${id.victim}`).set(as('acad')).expect(403);
  });
});

describe('listing', () => {
  it('searches, filters, pages, and never returns secrets', async () => {
    const all = (await http.get('/v1/admin/users').set(as('audit')).expect(200)).body; expect(all.length).toBe(7); expect(JSON.stringify(all)).not.toMatch(/passwordHash|mfaSecret|mfaBackup/); expect(all[0]).toHaveProperty('roles');
    expect((await http.get('/v1/admin/users?q=VICTIM').set(as('audit'))).body.map((u: any) => u.email)).toEqual(['victim@x.test']); expect((await http.get('/v1/admin/users?role=AUDITOR').set(as('audit'))).body).toHaveLength(1);
    expect((await http.get('/v1/admin/users?status=SUSPENDED').set(as('audit'))).body).toHaveLength(0); await http.get('/v1/admin/users?status=weird').set(as('audit')).expect(400); await http.get('/v1/admin/users?role=NOPE').set(as('audit')).expect(400);
    const p1 = await http.get('/v1/admin/users?limit=3').set(as('audit')).expect(200); expect(p1.body).toHaveLength(3); const next = p1.headers['x-next-cursor']; expect(next).toBeTruthy();
    const p2 = await http.get(`/v1/admin/users?limit=3&cursor=${next}`).set(as('audit')).expect(200); expect(p2.body.some((u: any) => p1.body.some((x: any) => x.id === u.id))).toBe(false);
    const teacherLookup = (await http.get('/v1/admin/users?role=DOUBT_TEACHER').set(as('acad')).expect(200)).body; expect(teacherLookup).toEqual([]);
  });
});

describe('creating people', () => {
  it('creates an account with a one-time password that works once, and refuses duplicates and bad input', async () => {
    const r = await http.post('/v1/admin/users').set(as('plat')).send({ email: ' New.Person@X.test ', name: 'New Person', roles: ['CONTENT_AUTHOR'] }).expect(201); expect(r.headers['cache-control']).toBe('no-store'); expect(r.body.email).toBe('new.person@x.test'); expect(r.body.temporaryPassword).toBeTruthy();
    const ok = await login('new.person@x.test', r.body.temporaryPassword); expect(ok.status).toBe(201); expect(ok.body.roles).toEqual(['CONTENT_AUTHOR']);
    await http.post('/v1/admin/users').set(as('plat')).send({ email: 'NEW.person@x.test', name: 'Dup', roles: ['LEARNER'] }).expect(409);
    await http.post('/v1/admin/users').set(as('plat')).send({ email: 'not-an-email', name: 'N', roles: ['LEARNER'] }).expect(400); await http.post('/v1/admin/users').set(as('plat')).send({ email: 'a@x.test', name: '', roles: ['LEARNER'] }).expect(400);
    await http.post('/v1/admin/users').set(as('plat')).send({ email: 'a@x.test', name: 'A', roles: [] }).expect(400); await http.post('/v1/admin/users').set(as('plat')).send({ email: 'a@x.test', name: 'A', roles: ['KING'] }).expect(400);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'user.created' }, orderBy: { seq: 'desc' } }); expect(JSON.stringify({ ...audit, seq: 0 })).not.toContain(r.body.temporaryPassword);
  });
  it('can create an SSO-only account with no password', async () => {
    const r = await http.post('/v1/admin/users').set(as('plat')).send({ email: 'sso@x.test', name: 'Sso', roles: ['LEARNER'], ssoOnly: true }).expect(201); expect(r.body.temporaryPassword).toBeUndefined();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.body.id } })).passwordHash).toBeNull();
  });
  it('lets only a super admin create an administrator', async () => {
    await http.post('/v1/admin/users').set(as('plat')).send({ email: 'adm@x.test', name: 'Adm', roles: ['PLATFORM_ADMIN'] }).expect(403);
    await http.post('/v1/admin/users').set(as('plat')).send({ email: 'adm@x.test', name: 'Adm', roles: ['LEARNER', 'SUPER_ADMIN'] }).expect(403);
    await http.post('/v1/admin/users').set(as('sup')).send({ email: 'adm@x.test', name: 'Adm', roles: ['PLATFORM_ADMIN'] }).expect(201);
  });
});

describe('roles', () => {
  it('adds and removes roles with a reason, signs the person out, and records before and after', async () => {
    await prisma.userSession.create({ data: { userId: id.victim, authMethod: 'PASSWORD', expiresAt: new Date(Date.now() + 3_600_000) } });
    await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ add: ['DOUBT_TEACHER'] }).expect(400); // reason
    const r = (await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ add: ['DOUBT_TEACHER', 'DOUBT_TEACHER'], reason: 'Joins the doubt desk' }).expect(201)).body; expect(r.roles.sort()).toEqual(['CONTENT_AUTHOR', 'DOUBT_TEACHER']); expect(r.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(await prisma.userSession.count({ where: { userId: id.victim, revokedAt: null } })).toBe(0);
    await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ remove: ['CONTENT_AUTHOR'], reason: 'No longer writes content' }).expect(201);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'user.roles_changed', objectId: id.victim }, orderBy: { seq: 'desc' } }); expect(ev.before).toEqual({ roles: ['CONTENT_AUTHOR', 'DOUBT_TEACHER'] }); expect(ev.after).toEqual({ roles: ['DOUBT_TEACHER'] }); expect(ev.reason).toBe('No longer writes content');
    expect((await http.get('/v1/admin/users?role=DOUBT_TEACHER').set(as('acad'))).body.map((u: any) => u.id)).toEqual([id.victim]); // now visible to the doubt-teacher lookup
  });
  it('refuses nonsense: own roles, unheld roles, an empty result, unknown roles', async () => {
    await http.post(`/v1/admin/users/${id.plat}/roles`).set(as('plat')).send({ add: ['AUDITOR'], reason: 'x' }).expect(403);
    await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ remove: ['AUDITOR'], reason: 'x' }).expect(409);
    await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ remove: ['DOUBT_TEACHER'], reason: 'x' }).expect(400); // would leave no role
    await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ add: ['KING'], reason: 'x' }).expect(400); await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ reason: 'x' }).expect(400);
    await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ add: ['AUDITOR'], remove: ['AUDITOR'], reason: 'x' }).expect(400); await http.post('/v1/admin/users/00000000-0000-0000-0000-000000000000/roles').set(as('plat')).send({ add: ['AUDITOR'], reason: 'x' }).expect(404);
  });
  it('keeps administrators out of reach of a platform admin, and keeps at least one super admin', async () => {
    await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ add: ['PLATFORM_ADMIN'], reason: 'x' }).expect(403); await http.post(`/v1/admin/users/${id.victim}/roles`).set(as('plat')).send({ add: ['SUPER_ADMIN'], reason: 'x' }).expect(403);
    await http.post(`/v1/admin/users/${id.sup}/roles`).set(as('plat')).send({ add: ['AUDITOR'], reason: 'x' }).expect(403); // an administrator is not theirs to change
    await http.post(`/v1/admin/users/${id.sup}/status`).set(as('plat')).send({ status: 'SUSPENDED', reason: 'x' }).expect(403); await http.post(`/v1/admin/users/${id.sup}/reset-password`).set(as('plat')).send({ reason: 'x' }).expect(403);
    // a second super admin may demote the first; the first's sessions end
    await http.post('/v1/admin/users').set(as('sup')).send({ email: 'sup2@x.test', name: 'Sup Two', roles: ['SUPER_ADMIN'] }).expect(201);
    const sup2 = (await prisma.user.findUniqueOrThrow({ where: { email: 'sup2@x.test' } })).id;
    const pw = (await http.post(`/v1/admin/users/${sup2}/reset-password`).set(as('sup')).send({ reason: 'first sign-in' }).expect(201)).body.temporaryPassword; const t2 = { Authorization: `Bearer ${(await login('sup2@x.test', pw)).body.accessToken}` };
    await http.post(`/v1/admin/users/${id.sup}/roles`).set(t2).send({ remove: ['SUPER_ADMIN'], add: ['AUDITOR'], reason: 'rotation' }).expect(201);
    // the last active super admin cannot be demoted or suspended. Through the API this needs a second active super admin acting, so the guard is exercised at the service
    // with an actor who is not an account in the table (it protects against two super admins removing each other at the same moment).
    const svc = app.get(UsersService); const ghost = { id: '00000000-0000-0000-0000-0000000000aa', roles: ['SUPER_ADMIN'] };
    await prisma.userRole.create({ data: { userId: id.sup, role: 'SUPER_ADMIN' } }); await prisma.user.update({ where: { id: sup2 }, data: { status: 'SUSPENDED' } });
    await expect(svc.setRoles(ghost, id.sup, { remove: ['SUPER_ADMIN'], reason: 'x' })).rejects.toThrow(/last active super admin/); await expect(svc.setStatus(ghost, id.sup, 'SUSPENDED', 'x')).rejects.toThrow(/last active super admin/);
    await prisma.user.update({ where: { id: sup2 }, data: { status: 'ACTIVE' } }); await expect(svc.setRoles(ghost, id.sup, { remove: ['SUPER_ADMIN'], reason: 'x' })).resolves.toBeTruthy();
  });
});

describe('suspending, unlocking, passwords, history', () => {
  it('suspends (signing the person out and refusing sign-in) and reactivates, with a reason, never yourself or an erased account', async () => {
    const u = (await http.post('/v1/admin/users').set(as('plat')).send({ email: 'susp@x.test', name: 'Susp', roles: ['LEARNER'] }).expect(201)).body;
    const first = await login('susp@x.test', u.temporaryPassword); expect(first.status).toBe(201); expect(await prisma.userSession.count({ where: { userId: u.id, revokedAt: null } })).toBe(1);
    await http.post(`/v1/admin/users/${u.id}/status`).set(as('plat')).send({ status: 'SUSPENDED' }).expect(400);
    await http.post(`/v1/admin/users/${u.id}/status`).set(as('plat')).send({ status: 'DELETED', reason: 'x' }).expect(400);
    const s = (await http.post(`/v1/admin/users/${u.id}/status`).set(as('plat')).send({ status: 'SUSPENDED', reason: 'Left the institute' }).expect(201)).body; expect(s.sessionsRevoked).toBe(1);
    expect((await login('susp@x.test', u.temporaryPassword)).status).toBe(401); await http.get('/v1/auth/me').set({ Authorization: `Bearer ${first.body.accessToken}` }).expect(401);
    await http.post(`/v1/admin/users/${u.id}/status`).set(as('plat')).send({ status: 'SUSPENDED', reason: 'again' }).expect(409);
    expect((await http.get('/v1/admin/users?status=SUSPENDED').set(as('audit'))).body.map((x: any) => x.email)).toEqual(['susp@x.test']);
    await http.post(`/v1/admin/users/${u.id}/status`).set(as('plat')).send({ status: 'ACTIVE', reason: 'Returned' }).expect(201); expect((await login('susp@x.test', u.temporaryPassword)).status).toBe(201);
    await http.post(`/v1/admin/users/${id.plat}/status`).set(as('plat')).send({ status: 'SUSPENDED', reason: 'x' }).expect(403);
    await prisma.user.update({ where: { id: u.id }, data: { erasedAt: new Date() } }); await http.post(`/v1/admin/users/${u.id}/status`).set(as('plat')).send({ status: 'SUSPENDED', reason: 'x' }).expect(409); await http.post(`/v1/admin/users/${u.id}/roles`).set(as('plat')).send({ add: ['AUDITOR'], reason: 'x' }).expect(409); await http.post(`/v1/admin/users/${u.id}/reset-password`).set(as('plat')).send({ reason: 'x' }).expect(409);
    expect((await http.get('/v1/admin/users?status=ERASED').set(as('audit'))).body.map((x: any) => x.email)).toEqual(['susp@x.test']);
  });
  it('unlocks a locked account', async () => {
    await prisma.user.update({ where: { id: id.victim }, data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 900_000) } });
    expect((await http.get(`/v1/admin/users/${id.victim}`).set(as('audit'))).body.locked).toBe(true);
    await http.post(`/v1/admin/users/${id.victim}/unlock`).set(as('plat')).send({}).expect(201); const u = await prisma.user.findUniqueOrThrow({ where: { id: id.victim } }); expect(u.lockedUntil).toBeNull(); expect(u.failedLogins).toBe(0);
  });
  it('resets a password to a one-time one, ending their sessions; the old password stops working; never your own', async () => {
    const v = id.victim; await prisma.userSession.create({ data: { userId: v, authMethod: 'PASSWORD', expiresAt: new Date(Date.now() + 3_600_000) } });
    await http.post(`/v1/admin/users/${v}/reset-password`).set(as('plat')).send({}).expect(400); await http.post(`/v1/admin/users/${id.plat}/reset-password`).set(as('plat')).send({ reason: 'x' }).expect(403);
    const r = (await http.post(`/v1/admin/users/${v}/reset-password`).set(as('plat')).send({ reason: 'Forgot it' }).expect(201)); expect(r.headers['cache-control']).toBe('no-store'); expect(r.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await login('victim@x.test', 'pw-pw-pw-pw-1')).status).toBe(401); expect((await login('victim@x.test', r.body.temporaryPassword)).status).toBe(201);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'user.password_reset_by_admin' }, orderBy: { seq: 'desc' } }); expect(JSON.stringify({ ...ev, seq: 0 })).not.toContain(r.body.temporaryPassword);
  });
  it("shows one person's details and the history of what was done to them, by name", async () => {
    const d = (await http.get(`/v1/admin/users/${id.victim}`).set(as('help')).expect(200)).body; expect(d).toMatchObject({ email: 'victim@x.test', roles: ['DOUBT_TEACHER'], mfaEnabled: false }); expect(typeof d.activeSessions).toBe('number');
    const actions = d.history.map((h: any) => h.action); expect(actions).toEqual(expect.arrayContaining(['user.roles_changed', 'user.password_reset_by_admin', 'user.unlocked'])); expect(d.history.find((h: any) => h.action === 'user.roles_changed').by).toBe('Name plat');
    await http.get('/v1/admin/users/00000000-0000-0000-0000-000000000000').set(as('help')).expect(404);
  });
});
