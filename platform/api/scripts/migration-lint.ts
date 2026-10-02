// Expand/contract policy for database migrations (see docs/ops/migrations.md). Run: ts-node scripts/migration-lint.ts
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LintProblem { rule: string; line: number; text: string }
const stripComments = (sql: string) => sql.split('\n').map((l) => l.replace(/--(?!\s*expand-contract:).*$/, ''));

/**
 * Rules (a migration that needs one of these must say why with `-- expand-contract: <reason, >=15 chars>` anywhere in the file):
 *   destructive        DROP TABLE / DROP COLUMN / TRUNCATE / DELETE or UPDATE without WHERE   (contract step: only after no deployed code reads it)
 *   rewrite            ALTER COLUMN ... TYPE / SET DATA TYPE                                   (full table rewrite + lock)
 *   rename             RENAME TO / RENAME COLUMN                                               (breaks the previous release mid-rollout)
 *   not-null-no-default ADD COLUMN ... NOT NULL without DEFAULT, or SET NOT NULL               (fails on populated tables / blocks old writers)
 * Dropping a trigger is allowed only when the same file re-creates it (replace pattern).
 */
export function lintMigration(sql: string): LintProblem[] {
  const ack = /--\s*expand-contract:\s*\S.{14,}/.test(sql); const out: LintProblem[] = [];
  const lines = stripComments(sql);
  // statement-level scan so multi-line statements are judged whole
  const stmts: { text: string; line: number }[] = []; let cur = '', start = 0;
  lines.forEach((l, i) => { if (!cur.trim()) start = i + 1; cur += l + '\n'; if (l.trim().endsWith(';')) { stmts.push({ text: cur.trim(), line: start }); cur = ''; } });
  for (const { text, line } of stmts) {
    const t = text.replace(/\s+/g, ' ');
    const flag = (rule: string) => { if (!ack) out.push({ rule, line, text: t.slice(0, 120) }); };
    const dropTrigger = /^DROP TRIGGER (IF EXISTS )?(\w+) ON/i.exec(t);
    if (dropTrigger) { if (!new RegExp(`CREATE (OR REPLACE )?TRIGGER ${dropTrigger[2]}\\b`, 'i').test(sql)) flag('destructive'); continue; }
    if (/^(DROP TABLE|DROP COLUMN|TRUNCATE)/i.test(t) || /ALTER TABLE .* DROP COLUMN/i.test(t) || /^DROP (TYPE|INDEX|CONSTRAINT)/i.test(t)) flag('destructive');
    else if (/^(DELETE FROM|UPDATE) /i.test(t) && !/\bWHERE\b/i.test(t)) flag('destructive');
    if (/ALTER COLUMN .* (SET DATA )?TYPE /i.test(t)) flag('rewrite');
    if (/RENAME (TO|COLUMN)/i.test(t)) flag('rename');
    for (const part of t.split(/ADD COLUMN/i).slice(1)) { const colDef = part.split(/,\s*(?=ADD COLUMN|ADD CONSTRAINT|DROP|ALTER)/i)[0]; if (/NOT NULL/i.test(colDef) && !/DEFAULT/i.test(colDef) && /^ALTER TABLE/i.test(t)) { flag('not-null-no-default'); break; } }
    if (/ALTER COLUMN .* SET NOT NULL/i.test(t)) flag('not-null-no-default');
  }
  return out;
}

export function lintAll(dir = join(__dirname, '../prisma/migrations')) {
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) => lintMigration(readFileSync(join(dir, d.name, 'migration.sql'), 'utf8')).map((p) => ({ migration: d.name, ...p })));
}
if (require.main === module) { const p = lintAll(); p.forEach((x) => console.error(`${x.migration}:${x.line} [${x.rule}] ${x.text}`)); if (p.length) { console.error(`${p.length} migration policy problem(s). Split into expand/contract steps or add "-- expand-contract: <reason>".`); process.exit(1); } console.log('migrations OK'); }
