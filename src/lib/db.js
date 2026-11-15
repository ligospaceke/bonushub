import { SETTING_DEFAULTS } from './commission.js';

export const q = (db, sql, ...args) => db.prepare(sql).bind(...args);

/** Current time. Tests inject env.NOW (a function returning a Date) to control the clock. */
export const nowDate = (env) => (env.NOW ? env.NOW() : new Date());
export const nowIso = (env) => nowDate(env).toISOString();

export const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
export const addMinutes = (iso, mins) => new Date(new Date(iso).getTime() + mins * 60000).toISOString();
export function addMonths(iso, months) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

/** Aborts the surrounding D1 batch (and rolls it back) unless the previous statement changed exactly one row. */
export const guardStmt = (db) => db.prepare('INSERT INTO guard(ok) SELECT CASE WHEN changes() = 1 THEN 1 ELSE NULL END');
export const clearGuardStmt = (db) => db.prepare('DELETE FROM guard');
export const isGuardError = (e) => /guard\.ok/i.test(String(e?.message || e));

export async function getSettings(db) {
  const rows = (await db.prepare('SELECT key, value FROM settings').all()).results;
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) {
    const n = Number(r.value);
    out[r.key] = Number.isFinite(n) && r.value.trim() !== '' ? n : r.value;
  }
  return out;
}

export const pad6 = (n) => String(n).padStart(6, '0');
