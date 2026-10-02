# Database migration policy: expand / contract

**Why.** Deploys are rolling: for several minutes the previous and the new release run against the same database, and a rollback must be possible without a restore. Migrations are forward-only, so every migration must be safe for the release before it.

## Rules (enforced by `scripts/migration-lint.ts`, run in CI)
| Change | Allowed in one step? | How |
|---|---|---|
| New table, new nullable column, new column with a DEFAULT, new index, new trigger | Yes | Expand |
| `ADD COLUMN ... NOT NULL` without DEFAULT, `SET NOT NULL` | No | Add nullable (release N) -> backfill -> `SET NOT NULL` in release N+1 |
| `DROP COLUMN` / `DROP TABLE` / `DROP INDEX` / `DROP TYPE` | No | Release N stops reading and writing it; drop in N+1 or later (contract) |
| Rename a column/table | No | Add new, dual-write, backfill, switch reads, drop old (4 steps over 2+ releases) |
| `ALTER COLUMN ... TYPE` | No | Add new column of the new type and follow the rename pattern |
| `DELETE`/`UPDATE` without `WHERE`, `TRUNCATE` | No | Batched data fix, outside the schema migration |
| `DROP TRIGGER` | Only with a `CREATE TRIGGER` of the same name in the same file | Replace pattern |

A migration that genuinely needs an exception must contain `-- expand-contract: <reason of at least 15 characters>`; the reason is reviewed in the PR. The append-only evidence tables (audit, exam events, submissions, grade records) additionally never get a destructive migration; privacy erasure is the only sanctioned deletion path.

## Release order
1. Run `prisma migrate deploy` against the **direct** database URL, never through PgBouncer.
2. Roll the API, then the worker (both tolerate the expanded schema).
3. Only after the whole fleet runs the new release: ship the contract migration in a later release.

## Verification (CI and before each release)
`test/migrations.spec.ts` builds a scratch database at the **first** schema, writes representative rows (users, roles, programme, application, a hash-chained audit trail), applies every later migration one at a time, and asserts after each step that no row is lost or duplicated. It then checks the upgraded database is identical to a freshly migrated one (columns, defaults, indexes, triggers), that the audit chain still verifies, and that append-only triggers still reject updates and deletes. Row volumes are small; it proves correctness of the migrations, **not their lock time on a production-sized database**. Before a release that touches a large table, rehearse it on a restored copy of production-sized data (the DR drill gives you one) and record the duration.

## Rollback
Application rollback = redeploy the previous image (safe by the rules above). Data rollback = restore per `dr-plan.md`; never hand-edit `_prisma_migrations`.
