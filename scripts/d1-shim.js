// A small stand-in for Cloudflare D1 built on node:sqlite, so the same Worker code runs in tests and local development.
// Mirrors the D1 surface the app uses: prepare().bind().run/all/first/raw, batch() (atomic), exec().
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isRead = (sql) => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql);
const norm = (rows) => rows.map((r) => ({ ...r }));

export function createD1(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');

  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Stmt(this.sql, args.map((a) => (a === undefined ? null : a))); }
    _exec() {
      const st = db.prepare(this.sql);
      if (isRead(this.sql)) return { success: true, results: norm(st.all(...this.args)), meta: {} };
      const r = st.run(...this.args);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async run() { return this._exec(); }
    async all() { const st = db.prepare(this.sql); return { success: true, results: norm(st.all(...this.args)), meta: {} }; }
    async first(col) { const row = db.prepare(this.sql).get(...this.args); if (!row) return null; return col ? row[col] : { ...row }; }
    async raw() { return db.prepare(this.sql).all(...this.args).map((r) => Object.values(r)); }
  }

  return {
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
    close: () => db.close(),
    _raw: db,
  };
}

/** Apply every migrations/*.sql file not yet recorded. Works for both the shim and `wrangler d1 migrations apply`. */
export function migrate(d1, dir = join(here, '..', 'migrations')) {
  const db = d1._raw;
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
