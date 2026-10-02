// Creates or updates a user and (optionally) sets a password. This is the supported way to bootstrap the FIRST administrator and to give
// a local-dev learner a password (learners normally sign in through SSO). Idempotent: running it again adds roles / resets the password.
//   npm run user:create -- --email you@institute.edu --name "Your Name" --roles SUPER_ADMIN,PLATFORM_ADMIN --password '<12+ chars>'
//   npm run user:create -- --email learner@synthetic.test --name Learner --roles LEARNER --password 'Learner-Dev-Pass1'
// The password is read from --password or the USER_PASSWORD environment variable (prefer the variable so it stays out of shell history).
import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/common/auth';
import { passwordIssues } from '../src/domain/totp';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };
const ROLES = Object.keys(Role);

(async () => {
  const email = arg('email')?.toLowerCase(), name = arg('name') ?? email?.split('@')[0], password = arg('password') ?? process.env.USER_PASSWORD;
  const roles = (arg('roles') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('--email is required');
  const bad = roles.filter((r) => !ROLES.includes(r)); if (bad.length || !roles.length) throw new Error(`--roles must be a comma list of: ${ROLES.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`);
  if (password) { const issues = passwordIssues(password, email); if (issues.length) throw new Error(`password too weak: ${issues.join('; ')}`); }
  const prisma = new PrismaClient();
  try {
    const u = await prisma.user.upsert({ where: { email }, update: { name: name!, ...(password && { passwordHash: hashPassword(password), failedLogins: 0, lockedUntil: null }) }, create: { email, name: name!, ...(password && { passwordHash: hashPassword(password) }) } });
    const have = new Set((await prisma.userRole.findMany({ where: { userId: u.id } })).map((r) => r.role as string));
    for (const r of roles) if (!have.has(r)) await prisma.userRole.create({ data: { userId: u.id, role: r as Role } });
    await prisma.$transaction(async (tx) => { const { AuditService } = await import('../src/audit'); await new AuditService(tx as any).record(tx, { actor: null, action: 'user.provisioned_by_script', objectType: 'User', objectId: u.id, after: { email, roles, passwordSet: !!password } }); });
    console.log(JSON.stringify({ id: u.id, email, roles: [...new Set([...have, ...roles])], passwordSet: !!(password || u.passwordHash) }));
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
