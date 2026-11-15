import { sha256Hex } from '../lib/crypto.js';
import { nowIso } from '../lib/db.js';

const canon = (r) => JSON.stringify({
  ts: r.ts, actorId: r.actorId ?? null, actorRole: r.actorRole ?? null, action: r.action,
  entity: r.entity ?? null, entityId: r.entityId ?? null, data: r.data ?? null,
});

/**
 * Append to the tamper-evident audit chain. Each row's hash covers the previous hash, so any edit or deletion
 * breaks verification. A UNIQUE index on prev_hash makes concurrent writers retry instead of forking the chain.
 * Best effort by design: the ledger and status history are written inside the financial transaction itself.
 */
export async function audit(env, { actor, action, entity, entityId, data }) {
  const dataStr = data === undefined ? null : JSON.stringify(data);
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await env.DB.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').first();
    const prev = last?.hash ?? 'GENESIS';
    const row = { ts: nowIso(env), actorId: actor?.id ?? null, actorRole: actor?.role ?? 'system', action, entity, entityId, data: dataStr };
    const hash = await sha256Hex(prev + canon(row));
    try {
      await env.DB.prepare('INSERT INTO audit_log (ts, actor_id, actor_role, action, entity, entity_id, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(row.ts, row.actorId, row.actorRole, action, entity ?? null, entityId ?? null, dataStr, prev, hash).run();
      return;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e?.message))) { console.error('audit failed', e); return; }
    }
  }
  console.error('audit failed after retries', action);
}

export async function verifyAuditChain(env) {
  const rows = (await env.DB.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all()).results;
  let prev = 'GENESIS';
  for (const r of rows) {
    const expect = await sha256Hex(prev + canon({
      ts: r.ts, actorId: r.actor_id, actorRole: r.actor_role, action: r.action, entity: r.entity, entityId: r.entity_id, data: r.data,
    }));
    if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, checked: rows.length, brokenAtSeq: r.seq };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}
