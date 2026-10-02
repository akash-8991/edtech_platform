// SYNTHETIC DEV DATA ONLY. Never run against production.
import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/common/auth';

const prisma = new PrismaClient();
const users: [string, Role][] = [
  ['superadmin', 'SUPER_ADMIN'], ['admin', 'ACADEMIC_ADMIN'], ['platform', 'PLATFORM_ADMIN'], ['author', 'CONTENT_AUTHOR'],
  ['faculty', 'FACULTY_REVIEWER'], ['approver', 'APPROVER_PUBLISHER'], ['auditor', 'AUDITOR'], ['support', 'SUPPORT_OPERATOR'],
];
(async () => {
  for (const [k, role] of users)
    await prisma.user.upsert({ where: { email: `${k}@synthetic.test` }, update: {},
      create: { email: `${k}@synthetic.test`, name: `Synthetic ${k}`, passwordHash: hashPassword('Dev-Only-Pass1'), roles: { create: { role } } } });
  console.log(`seeded ${users.length} synthetic users (password: Dev-Only-Pass1)`);
})().finally(() => prisma.$disconnect());
