import { nowIso } from '../lib/db.js';

/**
 * Double-entry style ledger, append-only. Invariant per sub-order and in total:
 *   gateway_clearing = seller_payable + commission_accrued + commission_earned
 * gateway_clearing is money BonasHub holds with the payment provider on behalf of buyers.
 */
export function ledgerStmt(env, { account, sellerId, orderRef, subRef, kind, amount, ref, note }) {
  return env.DB.prepare(
    'INSERT INTO ledger_entries (ts, account, seller_id, order_ref, sub_order_ref, kind, amount_minor, ref, note) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(nowIso(env), account, sellerId ?? null, orderRef ?? null, subRef ?? null, kind, amount, ref ?? null, note ?? null);
}

export function historyStmt(env, { subId, from, to, actor, note }) {
  return env.DB.prepare(
    'INSERT INTO order_status_history (seller_order_id, from_status, to_status, actor_id, actor_role, note, created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(subId, from ?? null, to, actor?.id ?? null, actor?.role ?? 'system', note ?? null, nowIso(env));
}

export async function ledgerBalances(env) {
  const rows = (await env.DB.prepare('SELECT account, SUM(amount_minor) AS total FROM ledger_entries GROUP BY account').all()).results;
  const b = { gateway_clearing: 0, seller_payable: 0, commission_accrued: 0, commission_earned: 0 };
  for (const r of rows) b[r.account] = r.total;
  b.balanced = b.gateway_clearing === b.seller_payable + b.commission_accrued + b.commission_earned;
  return b;
}
