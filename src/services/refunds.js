import { bad, conflict, notFound } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';
import { nowIso, guardStmt, clearGuardStmt, isGuardError } from '../lib/db.js';
import { mulDivRound } from '../lib/money.js';
import { reverseCommission } from '../lib/commission.js';
import { providerByName } from '../payments/index.js';
import { ledgerStmt, historyStmt } from './ledger.js';
import { notifyStmts, notifyAdmins } from './notify.js';
import { audit } from './audit.js';
import { nextRef } from './orders.js';

/** Buyer asks for a refund of a delivered/completed sub-order. The money does not move until an administrator decides. */
export async function requestRefund(env, actor, subId, { amountMinor, reason }) {
  const { loadSub, assertParty } = await import('./fulfilment.js');
  const sub = await loadSub(env, subId);
  assertParty(sub, actor);
  if (!['delivered', 'completed'].includes(sub.status)) throw conflict('invalid_state', 'Refunds can be requested after delivery.');
  const text = String(reason ?? '').trim();
  if (text.length < 10) throw bad('Tell us what went wrong.', { reason: 'Please give more detail.' });
  const remaining = sub.total_minor - sub.refunded_minor;
  const amt = amountMinor ?? remaining;
  if (!Number.isInteger(amt) || amt < 1 || amt > remaining) throw bad(`Refund amount must be between 1 and ${remaining}.`, { amountMinor: 'Invalid amount.' });
  const open = await env.DB.prepare("SELECT 1 FROM refunds WHERE seller_order_id = ? AND status = 'requested'").bind(subId).first();
  if (open) throw conflict('refund_exists', 'A refund request is already open for this order.');
  const ref = await nextRef(env, 'refund', 'RF');
  const ts = nowIso(env);
  try {
    await env.DB.batch([
      ...ref.bump(),
      env.DB.prepare('INSERT INTO refunds (id, ref, seller_order_id, amount_minor, reason, status, requested_by, created_at) VALUES (?,?,?,?,?,?,?,?)').bind(uuid(), ref.ref, subId, amt, text.slice(0, 1000), 'requested', actor.id, ts),
      env.DB.prepare("UPDATE seller_orders SET prior_status = status, status = 'refund_requested', updated_at = ? WHERE id = ? AND status IN ('delivered','completed')").bind(ts, subId),
      guardStmt(env.DB),
      historyStmt(env, { subId, from: sub.status, to: 'refund_requested', actor, note: text.slice(0, 300) }),
      ...notifyStmts(env, { userId: sub.seller_id, kind: 'refund_requested', title: `Refund requested on ${sub.ref}`, body: text.slice(0, 200), link: `#/seller/orders/${sub.id}` }),
      clearGuardStmt(env.DB),
    ]);
  } catch (e) { if (isGuardError(e)) throw conflict('stale', 'This order was just updated. Refresh and try again.'); throw e; }
  await notifyAdmins(env, { kind: 'refund_requested', title: `Refund requested: ${sub.ref}`, body: text.slice(0, 200), link: '#/admin/refunds' });
  await audit(env, { actor, action: 'refund.requested', entity: 'seller_order', entityId: subId, data: { ref: ref.ref, amountMinor: amt } });
  return { ref: ref.ref };
}

/**
 * Pay money back to the buyer and reverse the matching share of commission, as one atomic write.
 * The refund is split between product value and delivery in proportion to the sub-order; commission is reversed only on
 * the product part, proportionally, and never beyond what is left.
 * `toStatus`: 'refunded' for a full refund, null to keep the current status (cancelled orders), or undefined to restore the
 * status the order had before the refund was requested.
 */
export async function processRefund(env, { sub, amountMinor, reason, actor, requestedBy, toStatus, refundRowId }) {
  const remaining = sub.total_minor - sub.refunded_minor;
  if (!Number.isInteger(amountMinor) || amountMinor < 1 || amountMinor > remaining) throw bad(`Refund amount must be between 1 and ${remaining}.`);
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE order_id = ? AND status IN ('successful','partially_refunded') ORDER BY paid_at LIMIT 1").bind(sub.order_id).first();
  if (!payment) throw conflict('no_payment', 'There is no successful payment to refund.');
  if (payment.refunded_minor + amountMinor > payment.amount_minor) throw conflict('exceeds_payment', 'Refund exceeds the amount paid.');

  const productPortion = mulDivRound(amountMinor, sub.product_subtotal_minor, sub.total_minor);
  const rev = reverseCommission({ commissionMinor: sub.commission_minor, reversedMinor: sub.commission_reversed_minor, subtotalMinor: sub.product_subtotal_minor, productRefundMinor: productPortion });
  const full = amountMinor === remaining;
  const newRefunded = sub.refunded_minor + amountMinor;
  const newStatus = toStatus === undefined ? (full ? 'refunded' : (sub.prior_status || sub.status)) : toStatus;

  // Ask the gateway to return the money first. If this throws, nothing in our books has changed.
  const provider = providerByName(payment.provider);
  await provider.refund(env, payment, amountMinor);

  const ref = await nextRef(env, 'refund', 'RF');
  const ts = nowIso(env);
  const base = { sellerId: sub.seller_id, orderRef: sub.order_ref, subRef: sub.ref, ref: ref.ref };
  const commAccount = sub.commission_status === 'earned' ? 'commission_earned' : 'commission_accrued';
  const newCommStatus = sub.commission_reversed_minor + rev >= sub.commission_minor ? 'reversed' : sub.commission_status;
  const payStatus = payment.refunded_minor + amountMinor >= payment.amount_minor ? 'refunded' : 'partially_refunded';
  const stmts = [
    ...ref.bump(),
    env.DB.prepare('UPDATE seller_orders SET refunded_minor = refunded_minor + ?, commission_reversed_minor = commission_reversed_minor + ?, commission_status = ?, status = ?, prior_status = NULL, updated_at = ? WHERE id = ? AND refunded_minor = ?')
      .bind(amountMinor, rev, newCommStatus, newStatus ?? sub.status, ts, sub.id, sub.refunded_minor),
    guardStmt(env.DB),
    env.DB.prepare('UPDATE payments SET refunded_minor = refunded_minor + ?, status = ?, updated_at = ? WHERE id = ? AND refunded_minor = ?').bind(amountMinor, payStatus, ts, payment.id, payment.refunded_minor),
    guardStmt(env.DB),
  ];
  if (refundRowId) {
    stmts.push(env.DB.prepare("UPDATE refunds SET status = 'processed', amount_minor = ?, product_portion_minor = ?, commission_reversal_minor = ?, payment_id = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'requested'")
      .bind(amountMinor, productPortion, rev, payment.id, actor?.id ?? null, ts, refundRowId), guardStmt(env.DB));
  } else {
    stmts.push(env.DB.prepare("INSERT INTO refunds (id, ref, seller_order_id, payment_id, amount_minor, product_portion_minor, commission_reversal_minor, reason, status, requested_by, decided_by, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(uuid(), ref.ref, sub.id, payment.id, amountMinor, productPortion, rev, String(reason ?? '').slice(0, 1000), 'processed', requestedBy ?? null, actor?.id ?? null, ts, ts));
  }
  stmts.push(
    ledgerStmt(env, { ...base, account: 'gateway_clearing', kind: 'refund', amount: -amountMinor }),
    ledgerStmt(env, { ...base, account: 'seller_payable', kind: 'refund', amount: -(amountMinor - rev) }),
  );
  if (rev > 0) stmts.push(ledgerStmt(env, { ...base, account: commAccount, kind: 'commission_reversal', amount: -rev }));
  if (newStatus && newStatus !== sub.status) stmts.push(historyStmt(env, { subId: sub.id, from: sub.status, to: newStatus, actor, note: `Refund of ${amountMinor} minor units processed` }));
  stmts.push(...notifyStmts(env, { userId: sub.buyer_id, email: sub.buyer_email, kind: 'refund_processed', title: `Refund processed for ${sub.ref}`, body: `KSh ${(amountMinor / 100).toLocaleString('en-KE')} is being returned to you.`, link: `#/account/orders/${sub.oid}` }));
  stmts.push(...notifyStmts(env, { userId: sub.seller_id, kind: 'refund_processed', title: `Refund processed for ${sub.ref}`, body: 'The refund and a matching commission reversal were recorded.', link: `#/seller/orders/${sub.id}` }));
  stmts.push(clearGuardStmt(env.DB));
  try { await env.DB.batch(stmts); }
  catch (e) { if (isGuardError(e)) throw conflict('stale', 'This refund was just processed or the order changed. Refresh and check.'); throw e; }

  if (sub.settlement_status === 'settled') {
    await notifyAdmins(env, { kind: 'refund_after_settlement', title: `Refund after settlement: ${sub.ref}`, body: 'This sub-order was already settled with the seller. Recover the refunded amount from their next settlement.', link: '#/admin/settlements' });
  }
  await audit(env, { actor, action: 'refund.processed', entity: 'seller_order', entityId: sub.id, data: { ref: ref.ref, amountMinor, commissionReversalMinor: rev } });
  return { ref: ref.ref, amountMinor, commissionReversalMinor: rev };
}

/** Administrator decision on a requested refund. `amountMinor` may be less than requested (partial refund). */
export async function decideRefund(env, actor, refundId, { approve, amountMinor, note }) {
  const { loadSub } = await import('./fulfilment.js');
  const rf = await env.DB.prepare('SELECT * FROM refunds WHERE id = ?').bind(refundId).first();
  if (!rf) throw notFound('Refund');
  if (rf.status !== 'requested') throw conflict('already_decided', 'This refund has already been decided.');
  const sub = await loadSub(env, rf.seller_order_id);
  if (!approve) {
    const ts = nowIso(env);
    const back = sub.prior_status || 'delivered';
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE refunds SET status = 'rejected', decided_by = ?, decided_at = ?, reason = reason || ? WHERE id = ? AND status = 'requested'").bind(actor.id, ts, ` [Rejected: ${String(note ?? '').slice(0, 300)}]`, refundId),
        guardStmt(env.DB),
        env.DB.prepare("UPDATE seller_orders SET status = ?, prior_status = NULL, updated_at = ? WHERE id = ? AND status = 'refund_requested'").bind(back, ts, sub.id),
        guardStmt(env.DB),
        historyStmt(env, { subId: sub.id, from: 'refund_requested', to: back, actor, note: `Refund declined: ${String(note ?? '').slice(0, 200)}` }),
        ...notifyStmts(env, { userId: sub.buyer_id, email: sub.buyer_email, kind: 'refund_declined', title: `Refund request declined for ${sub.ref}`, body: String(note ?? '').slice(0, 200) || 'Contact support if you disagree.', link: `#/account/orders/${sub.oid}` }),
        clearGuardStmt(env.DB),
      ]);
    } catch (e) { if (isGuardError(e)) throw conflict('stale', 'Already updated.'); throw e; }
    await audit(env, { actor, action: 'refund.declined', entity: 'refund', entityId: refundId });
    return { declined: true };
  }
  const amt = amountMinor ?? rf.amount_minor;
  return processRefund(env, { sub, amountMinor: amt, reason: rf.reason, actor, requestedBy: rf.requested_by, refundRowId: refundId });
}
