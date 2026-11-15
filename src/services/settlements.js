import { bad, conflict, notFound } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';
import { nowIso, addDays, getSettings, guardStmt, clearGuardStmt, isGuardError } from '../lib/db.js';
import { sellerPayable } from '../lib/commission.js';
import { ledgerStmt } from './ledger.js';
import { notifyStmts } from './notify.js';
import { audit } from './audit.js';
import { nextRef } from './orders.js';

/** Completed, undisputed, unsettled sub-orders whose hold period (dispute window) has passed. */
export async function eligibleSubOrders(env, sellerId) {
  const s = await getSettings(env.DB);
  const cutoff = addDays(nowIso(env), -s.disputeWindowDays);
  const rows = (await env.DB.prepare(
    `SELECT * FROM seller_orders WHERE seller_id = ? AND status = 'completed' AND settlement_status = 'unsettled' AND dispute_open = 0 AND completed_at <= ? ORDER BY completed_at`
  ).bind(sellerId, cutoff).all()).results;
  return rows.map((r) => ({ ...r, payableMinor: sellerPayable(r) }));
}

export async function settlementCandidates(env) {
  const sellers = (await env.DB.prepare("SELECT user_id, business_name FROM seller_profiles WHERE status IN ('approved','suspended')").all()).results;
  const out = [];
  for (const s of sellers) {
    const subs = await eligibleSubOrders(env, s.user_id);
    const total = subs.reduce((a, x) => a + x.payableMinor, 0);
    if (subs.length) out.push({ sellerId: s.user_id, businessName: s.business_name, orders: subs.length, amountMinor: total });
  }
  return out;
}

/** Group every eligible sub-order of one seller into a pending settlement. The administrator pays it out, then marks it processed. */
export async function createSettlement(env, actor, sellerId, { note } = {}) {
  const seller = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(sellerId).first();
  if (!seller) throw notFound('Seller');
  const subs = await eligibleSubOrders(env, sellerId);
  if (!subs.length) throw conflict('nothing_to_settle', 'This seller has nothing eligible for settlement yet.');
  const amount = subs.reduce((a, s) => a + s.payableMinor, 0);
  if (amount <= 0) throw conflict('nothing_to_settle', 'The eligible orders net to zero after refunds.');
  const id = uuid(), ts = nowIso(env);
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await nextRef(env, 'settlement', 'ST');
    const stmts = [...ref.bump(),
      env.DB.prepare("INSERT INTO settlements (id, ref, seller_id, amount_minor, status, note, created_by, created_at) VALUES (?,?,?,?,'pending',?,?,?)").bind(id, ref.ref, sellerId, amount, note ?? null, actor.id, ts)];
    for (const s of subs) stmts.push(
      env.DB.prepare("UPDATE seller_orders SET settlement_status = 'in_settlement', settlement_id = ?, updated_at = ? WHERE id = ? AND settlement_status = 'unsettled' AND status = 'completed' AND dispute_open = 0").bind(id, ts, s.id),
      guardStmt(env.DB));
    stmts.push(clearGuardStmt(env.DB));
    try {
      await env.DB.batch(stmts);
      await audit(env, { actor, action: 'settlement.created', entity: 'settlement', entityId: id, data: { ref: ref.ref, sellerId, amountMinor: amount, orders: subs.length } });
      return { id, ref: ref.ref, amountMinor: amount, orders: subs.length };
    } catch (e) {
      if (isGuardError(e) || /UNIQUE/i.test(String(e?.message))) { if (attempt === 3) throw conflict('stale', 'Orders changed while settling. Try again.'); continue; }
      throw e;
    }
  }
}

/** Record that the payout was made outside the platform (bank transfer or M-Pesa B2C) and close the settlement. */
export async function markSettlementProcessed(env, actor, settlementId, { method, reference }) {
  const st = await env.DB.prepare('SELECT * FROM settlements WHERE id = ?').bind(settlementId).first();
  if (!st) throw notFound('Settlement');
  if (st.status !== 'pending') throw conflict('already_processed', 'This settlement is already processed.');
  if (!String(reference ?? '').trim()) throw bad('Enter the bank or M-Pesa transaction reference.', { reference: 'Required.' });
  const subs = (await env.DB.prepare("SELECT * FROM seller_orders WHERE settlement_id = ? AND settlement_status = 'in_settlement'").bind(settlementId).all()).results;
  const amount = subs.reduce((a, s) => a + sellerPayable(s), 0);
  if (amount !== st.amount_minor) throw conflict('amount_changed', 'The settlement amount changed after it was created (a refund was processed). Cancel and recreate it.');
  const ts = nowIso(env);
  const stmts = [
    env.DB.prepare("UPDATE settlements SET status = 'processed', method = ?, reference = ?, processed_by = ?, processed_at = ? WHERE id = ? AND status = 'pending'").bind(String(method ?? 'bank').slice(0, 30), String(reference).trim().slice(0, 100), actor.id, ts, settlementId),
    guardStmt(env.DB),
  ];
  for (const s of subs) {
    const p = sellerPayable(s);
    const base = { sellerId: s.seller_id, subRef: s.ref, ref: st.ref };
    stmts.push(
      env.DB.prepare("UPDATE seller_orders SET settlement_status = 'settled', updated_at = ? WHERE id = ? AND settlement_status = 'in_settlement' AND refunded_minor = ?").bind(ts, s.id, s.refunded_minor),
      guardStmt(env.DB),
      ledgerStmt(env, { ...base, account: 'seller_payable', kind: 'settlement', amount: -p }),
      ledgerStmt(env, { ...base, account: 'gateway_clearing', kind: 'settlement', amount: -p }));
  }
  stmts.push(...notifyStmts(env, { userId: st.seller_id, kind: 'settlement_processed', title: `Settlement ${st.ref} processed`, body: `KSh ${(st.amount_minor / 100).toLocaleString('en-KE')} was paid out. Reference: ${String(reference).trim()}`, link: '#/seller/settlements' }), clearGuardStmt(env.DB));
  try { await env.DB.batch(stmts); }
  catch (e) { if (isGuardError(e)) throw conflict('stale', 'A refund or change happened while processing. Reload and check.'); throw e; }
  await audit(env, { actor, action: 'settlement.processed', entity: 'settlement', entityId: settlementId, data: { ref: st.ref, amountMinor: st.amount_minor, reference } });
  return { processed: true };
}

/** Release a pending (unpaid) settlement so its orders can be settled again. */
export async function cancelSettlement(env, actor, settlementId) {
  const st = await env.DB.prepare('SELECT * FROM settlements WHERE id = ?').bind(settlementId).first();
  if (!st) throw notFound('Settlement');
  if (st.status !== 'pending') throw conflict('already_processed', 'Only pending settlements can be cancelled.');
  const ts = nowIso(env);
  await env.DB.batch([
    env.DB.prepare("UPDATE seller_orders SET settlement_status = 'unsettled', settlement_id = NULL, updated_at = ? WHERE settlement_id = ? AND settlement_status = 'in_settlement'").bind(ts, settlementId),
    env.DB.prepare("UPDATE settlements SET status = 'processed', amount_minor = 0, note = COALESCE(note,'') || ' [cancelled]', processed_at = ?, processed_by = ? WHERE id = ? AND status = 'pending'").bind(ts, actor.id, settlementId),
  ]);
  await audit(env, { actor, action: 'settlement.cancelled', entity: 'settlement', entityId: settlementId });
  return { cancelled: true };
}
