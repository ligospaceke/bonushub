// Turns a locally seeded database into a data-only SQL file you can load into a remote D1 database.
//   DB_FILE=/tmp/demo.sqlite npm run seed && DB_FILE=/tmp/demo.sqlite node scripts/export-seed.js > seed-demo.sql
// Demo data only. Never load it into production.
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const file = process.env.DB_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', '.dev', 'bonashub.sqlite');
const db = new DatabaseSync(file);
const skip = new Set(['sessions', 'rate_limits', 'verification_codes', 'outbox', 'd1_migrations', 'sqlite_sequence', '_migrations']);
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out = [];
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) {
  if (skip.has(name)) continue;
  const rows = db.prepare(`SELECT * FROM "${name}"`).all();
  if (name === 'categories' || name === 'settings' || name === 'counters') out.push(`DELETE FROM "${name}";`);
  for (const r of rows) { const k = Object.keys(r); out.push(`INSERT INTO "${name}" (${k.map((x) => `"${x}"`).join(',')}) VALUES (${k.map((x) => q(r[x])).join(',')});`); }
}
console.log(out.join('\n'));
