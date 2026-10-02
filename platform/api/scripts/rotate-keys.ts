// Re-seals stored ciphertext under the CURRENT keys after a rotation. Run after deploying the new NAME with the old value in NAME_PREVIOUS.
//   DRY_RUN=1 ts-node scripts/rotate-keys.ts      report only
//   ts-node scripts/rotate-keys.ts                re-seal, idempotent, resumable (rows already under the current key are skipped)
import 'reflect-metadata';
import { Prisma, PrismaClient } from '@prisma/client';
import { dataKeys, masterKeys, needsRotation, openWith, sealWith } from '../src/security/keyring';

export async function rotateKeys(prisma: PrismaClient, dry = false) {
  const out = { mfaSecrets: 0, exports: 0, offlinePackages: 0, scanned: 0, failed: [] as string[] };
  const dk = dataKeys(), mk = masterKeys();
  for (let cursor: string | undefined; ;) {
    const users = await prisma.user.findMany({ where: { mfaSecretEnc: { not: null } }, orderBy: { id: 'asc' }, take: 500, ...(cursor && { cursor: { id: cursor }, skip: 1 }), select: { id: true, mfaSecretEnc: true } });
    if (!users.length) break; cursor = users[users.length - 1].id;
    for (const u of users) { out.scanned++; if (!needsRotation(dk, u.mfaSecretEnc!)) continue;
      try { const plain = openWith(dk, u.mfaSecretEnc!); if (!dry) await prisma.user.update({ where: { id: u.id }, data: { mfaSecretEnc: sealWith(dk, plain) } }); out.mfaSecrets++; } catch { out.failed.push(`user:${u.id}`); } }
  }
  for (const r of await prisma.dataSubjectRequest.findMany({ where: { exportKey: { not: null } }, select: { id: true, exportCrypto: true } })) {
    out.scanned++; const c: any = r.exportCrypto; if (!c?.wrapped || !needsRotation(dk, c.wrapped)) continue;
    try { const plain = openWith(dk, c.wrapped); if (!dry) await prisma.dataSubjectRequest.update({ where: { id: r.id }, data: { exportCrypto: { ...c, wrapped: sealWith(dk, plain) } as Prisma.InputJsonValue } }); out.exports++; } catch { out.failed.push(`dsr:${r.id}`); }
  }
  for (let cursor: string | undefined; ;) {
    const pk = await prisma.offlinePackage.findMany({ orderBy: { id: 'asc' }, take: 500, ...(cursor && { cursor: { id: cursor }, skip: 1 }), select: { id: true, wrappedKey: true } });
    if (!pk.length) break; cursor = pk[pk.length - 1].id;
    for (const p of pk) { out.scanned++; if (!needsRotation(mk, p.wrappedKey)) continue;
      try { const plain = openWith(mk, p.wrappedKey); if (!dry) await prisma.offlinePackage.update({ where: { id: p.id }, data: { wrappedKey: sealWith(mk, plain) } }); out.offlinePackages++; } catch { out.failed.push(`pkg:${p.id}`); } }
  }
  return out;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  rotateKeys(prisma, process.env.DRY_RUN === '1').then((r) => { console.log(JSON.stringify({ dryRun: process.env.DRY_RUN === '1', ...r })); return prisma.$disconnect().then(() => process.exit(r.failed.length ? 1 : 0)); });
}
