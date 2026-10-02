import { execFileSync } from 'child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { lintAll, lintMigration } from '../scripts/migration-lint';
import { ChainVerifier, chainHash, GENESIS } from '../src/domain/audit-chain';

const ROOT = join(__dirname, '..');
const BASE = process.env.TEST_DATABASE_URL ?? 'postgresql://edtech:edtech@localhost:5433/edtech_test';
const urlFor = (db: string) => BASE.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
const FRESH = BASE; // edtech_test is always fully migrated by the suite setup

describe('migration policy (expand/contract)', () => {
  it('every shipped migration passes the lint', () => { expect(lintAll()).toEqual([]); });
  it('flags destructive, rewriting, renaming and unsafe NOT NULL changes unless acknowledged', () => {
    const rules = (sql: string) => lintMigration(sql).map((p) => p.rule);
    expect(rules('ALTER TABLE "User" DROP COLUMN "x";')).toEqual(['destructive']);
    expect(rules('DROP TABLE "Old";')).toEqual(['destructive']);
    expect(rules('TRUNCATE "A";')).toEqual(['destructive']);
    expect(rules('DELETE FROM "A";')).toEqual(['destructive']); expect(rules('DELETE FROM "A" WHERE id = 1;')).toEqual([]);
    expect(rules('ALTER TABLE "A" ALTER COLUMN "n" TYPE BIGINT;')).toEqual(['rewrite']);
    expect(rules('ALTER TABLE "A" RENAME COLUMN "a" TO "b";')).toEqual(['rename']);
    expect(rules('ALTER TABLE "A" ADD COLUMN "n" TEXT NOT NULL;')).toEqual(['not-null-no-default']);
    expect(rules('ALTER TABLE "A" ADD COLUMN "n" TEXT NOT NULL DEFAULT \'x\', ADD COLUMN "m" INTEGER NOT NULL;')).toEqual(['not-null-no-default']);
    expect(rules('ALTER TABLE "A" ALTER COLUMN "n" SET NOT NULL;')).toEqual(['not-null-no-default']);
    expect(rules('ALTER TABLE "A" ADD COLUMN "n" TEXT NOT NULL DEFAULT \'x\';')).toEqual([]); expect(rules('ALTER TABLE "A" ADD COLUMN "n" TEXT;')).toEqual([]);
    expect(rules('CREATE TABLE "T" ("id" TEXT NOT NULL);')).toEqual([]); // new tables are always safe
    expect(rules('DROP TRIGGER IF EXISTS t1 ON "A";\nCREATE TRIGGER t1 BEFORE UPDATE ON "A" FOR EACH ROW EXECUTE FUNCTION f();')).toEqual([]); // replace pattern
    expect(rules('DROP TRIGGER IF EXISTS t1 ON "A";')).toEqual(['destructive']);
    expect(rules('-- expand-contract: column unused since release 2026.11, no reader remains\nALTER TABLE "A" DROP COLUMN "x";')).toEqual([]);
    expect(rules('-- expand-contract: ok\nALTER TABLE "A" DROP COLUMN "x";')).toEqual(['destructive']); // a reason must actually be given
  });
});

describe('upgrade with live data', () => {
  jest.setTimeout(180_000);
  const names = readdirSync(join(ROOT, 'prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const work = mkdtempSync(join(tmpdir(), 'mig-')); const DB = 'edtech_upgrade';
  const admin = new PrismaClient({ datasources: { db: { url: urlFor('postgres') } } }); let scratch: PrismaClient; let fresh: PrismaClient;
  const deploy = (k: number) => {
    rmSync(join(work, 'migrations'), { recursive: true, force: true }); mkdirSync(join(work, 'migrations'));
    copyFileSync(join(ROOT, 'prisma/schema.prisma'), join(work, 'schema.prisma')); copyFileSync(join(ROOT, 'prisma/migrations/migration_lock.toml'), join(work, 'migrations/migration_lock.toml'));
    for (const n of names.slice(0, k)) cpSync(join(ROOT, 'prisma/migrations', n), join(work, 'migrations', n), { recursive: true });
    execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', join(work, 'schema.prisma')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: urlFor(DB) }, stdio: 'pipe' });
  };
  const counts = async () => Object.fromEntries(await Promise.all(['User', 'UserRole', 'Programme', 'LearnerApplication', 'AuditEvent'].map(async (t) => [t, Number((await scratch.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM "${t}"`))[0].n)])));
  const shape = async (c: PrismaClient) => (await c.$queryRaw<{ k: string }[]>`
    SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS k FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY 1`).map((r) => r.k);
  const triggers = async (c: PrismaClient) => (await c.$queryRaw<{ k: string }[]>`SELECT c.relname || '.' || t.tgname AS k FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal ORDER BY 1`).map((r) => r.k);
  const indexes = async (c: PrismaClient) => (await c.$queryRaw<{ k: string }[]>`SELECT indexname || ':' || indexdef AS k FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`).map((r) => r.k);

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.$executeRawUnsafe(`CREATE DATABASE ${DB}`);
    scratch = new PrismaClient({ datasources: { db: { url: urlFor(DB) } } }); fresh = new PrismaClient({ datasources: { db: { url: FRESH } } });
  });
  afterAll(async () => { await scratch?.$disconnect(); await fresh?.$disconnect(); await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.$disconnect(); rmSync(work, { recursive: true, force: true }); });

  it('data written under the FIRST schema survives every later migration, one step at a time', async () => {
    deploy(1); // baseline release
    await scratch.$executeRawUnsafe(`INSERT INTO "User"(id,email,name) VALUES ('u1','a@x.test','A'),('u2','b@x.test','B'),('u3','c@x.test','C')`);
    await scratch.$executeRawUnsafe(`INSERT INTO "UserRole"(id,"userId",role) VALUES ('r1','u1','LEARNER'),('r2','u2','ACADEMIC_ADMIN')`);
    await scratch.$executeRawUnsafe(`INSERT INTO "Programme"(id,code,title,discipline) VALUES ('p1','P1','Prog','AI')`);
    await scratch.$executeRawUnsafe(`INSERT INTO "LearnerApplication"(id,"externalRef",email,name,"programmeCode",duration,cohort,"updatedAt") VALUES ('la1','X1','a@x.test','A','P1','M12','C1',now())`).catch(async () => scratch.$executeRawUnsafe(`INSERT INTO "LearnerApplication"(id,"externalRef",email,name,"programmeCode",duration,cohort) VALUES ('la1','X1','a@x.test','A','P1','M12','C1')`));
    let prev = GENESIS; for (let i = 0; i < 5; i++) {
      const p = { actorId: 'u1', actorRole: null, action: `seed.${i}`, objectType: 'Seed', objectId: String(i), before: null, after: { i }, reason: null, ip: null, correlationId: null }; const hash = chainHash(prev, p);
      await scratch.$executeRawUnsafe(`INSERT INTO "AuditEvent"("actorId",action,"objectType","objectId",after,"prevHash",hash) VALUES ('u1',$1,'Seed',$2,$3::jsonb,$4,$5)`, p.action, p.objectId, JSON.stringify(p.after), prev, hash); prev = hash;
    }
    const baseline = await counts(); expect(baseline).toEqual({ User: 3, UserRole: 2, Programme: 1, LearnerApplication: 1, AuditEvent: 5 });
    for (let k = 2; k <= names.length; k++) { deploy(k); expect({ step: names[k - 1], ...(await counts()) }).toEqual({ step: names[k - 1], ...baseline }); } // no migration loses or duplicates a row
  });
  it('the upgraded database is identical to a freshly migrated one (columns, defaults, indexes, triggers)', async () => {
    expect(await shape(scratch)).toEqual(await shape(fresh)); expect(await triggers(scratch)).toEqual(await triggers(fresh)); expect(await indexes(scratch)).toEqual(await indexes(fresh));
    expect((await triggers(scratch)).length).toBeGreaterThanOrEqual(11);
  });
  it('after upgrade: old rows get safe defaults, the audit chain still verifies, and immutability is still enforced', async () => {
    const u = await scratch.$queryRawUnsafe<any[]>(`SELECT * FROM "User" WHERE id = 'u1'`); expect(u[0]).toMatchObject({ email: 'a@x.test', status: 'ACTIVE', failedLogins: 0, mfaEnabled: false });
    const rows = await scratch.$queryRawUnsafe<any[]>(`SELECT * FROM "AuditEvent" ORDER BY seq`); const v = new ChainVerifier();
    rows.forEach((r) => v.push({ prevHash: r.prevHash, hash: r.hash, payload: { actorId: r.actorId, actorRole: r.actorRole, action: r.action, objectType: r.objectType, objectId: r.objectId, before: r.before, after: r.after, reason: r.reason, ip: r.ip, correlationId: r.correlationId } }));
    expect(v.count).toBe(5); expect(v.broken).toBeNull();
    await expect(scratch.$executeRawUnsafe(`UPDATE "AuditEvent" SET action = 'tampered' WHERE seq = 1`)).rejects.toThrow(/immutable|append-only|not allowed/i);
    await expect(scratch.$executeRawUnsafe(`DELETE FROM "AuditEvent"`)).rejects.toThrow(/immutable|append-only|not allowed/i);
  });
  it('re-running deploy on an up-to-date database is a no-op', async () => { const before = await shape(scratch); deploy(names.length); expect(await shape(scratch)).toEqual(before); });
});
