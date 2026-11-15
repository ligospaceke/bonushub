import { bad, conflict, forbidden, notFound } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';
import { nowIso, guardStmt, clearGuardStmt, isGuardError, getSettings, addDays } from '../lib/db.js';
import { canTransition, STOCK_RETURNABLE } from '../lib/orderMachine.js';
import { ledgerStmt, historyStmt } from './ledger.js';
import { notifyStmts, notifyAdmins } from './notify.js';
import { audit } from './audit.js';
import { processRefund } from './refunds.js';

export async function loadSub(env, id) {
  const sub = await env.DB.prepare(
    `SELECT so.*, o.ref AS order_ref, o.buyer_id, o.id AS oid, u.email AS buyer_email, s.business_name AS seller_name, s.status AS seller_status, su.email AS seller_email
     FROM seller_orders so JOIN orders o ON o.id = so.order_id JOIN users u ON u.id = o.buyer_id
     JOIN seller_profiles s ON s.user_id = so.seller_id JOIN users su ON su.id = so.seller_id WHERE so.id = ?`
  ).bind(id).first();
  if (!sub) throw notFound('Order');
  return sub;
}

export function assertParty(sub, actor) {
  if (actor.role === 'seller' && sub.seller_id !== actor.id) throw notFound('Order');
  if (actor.role === 'buyer' && sub.buyer_id !== actor.id) throw notFound('Order');
}

const NOTES = {
  seller_processing: ['buyer', 'Order accepted', 'The seller has accepted your order and is preparing it.'],
  ready_for_dispatch: ['buyer', 'Order ready for dispatch', 'Your order is packed and ready to be dispatched.'],
  dispatched: ['buyer', 'Order dispatched', 'Your order is on its way.'],
  delivered: ['buyer', 'Order delivered', 'Please confirm that you received everything in good order.'],
  completed: ['seller', 'Order completed', 'The buyer confirmed the order. It is now eligible for settlement after the hold period.'],
};

/**
 * Move a seller sub-order to a new status. The state machine decides who may do what; the UPDATE is conditional on the
 * current status so two simultaneous requests cannot both win. Refund states go through services/refunds.js instead.
 */
export async function transition(env, actor, subId, to, { note, trackingRef, carrier, proofNote } = {}) {
  if (to === 'refund_requested' || to === 'refunded') throw bad('Use the refund request flow.');
  const sub = await loadSub(env, subId);
  assertParty(sub, actor);
  if (actor.role === 'seller' && sub.seller_status !== 'approved') throw forbidden('Your seller account is not active.');
  const from = sub.status;
  if (!canTransition(from, to, actor.role)) throw conflict('invalid_transition', `This order cannot move from "${from.replace(/_/g, ' ')}" to "${to.replace(/_/g, ' ')}".`);
  if (to === 'cancelled' && actor.role !== 'buyer' && !String(note ?? '').trim()) throw bad('Give a reason for cancelling.', { note: 'A reason is required.' });
  if (to === 'completed' && sub.dispute_open && actor.role === 'system') throw conflict('dispute_open', 'Open dispute.');

  if (from === 'awaiting_payment' && to === 'cancelled' && actor.role === 'buyer') {
    const pending = await env.DB.prepare("SELECT 1 FROM payments WHERE order_id = ? AND status = 'pending'").bind(sub.order_id).first();
    if (pending) throw conflict('payment_in_progress', 'A payment is in progress for this order. Wait for it to finish or expire.');
  }

  const ts = nowIso(env);
  const sets = ['status = ?', 'updated_at = ?'], args = [to, ts];
  if (to === 'dispatched') { sets.push('dispatched_at = ?', 'tracking_ref = ?', 'carrier = ?'); args.push(ts, trackingRef ?? null, carrier ?? null); }
  if (to === 'delivered') { sets.push('delivered_at = ?', 'proof_note = ?'); args.push(ts, proofNote ?? null); }
  if (to === 'completed') {
    sets.push('completed_at = ?', "delivered_at = COALESCE(delivered_at, ?)", "commission_status = CASE WHEN commission_status = 'accrued' THEN 'earned' ELSE commission_status END");
    args.push(ts, ts);
  }
  if (to === 'cancelled') { sets.push('cancel_reason = ?'); args.push(String(note ?? 'Cancelled by buyer').slice(0, 500)); }

  const stmts = [
    env.DB.prepare(`UPDATE seller_orders SET ${sets.join(', ')} WHERE id = ? AND status = ?`).bind(...args, subId, from),
    guardStmt(env.DB),
    historyStmt(env, { subId, from, to, actor, note }),
  ];

  if (to === 'completed' && sub.commission_status === 'accrued') {
    const amt = sub.commission_minor - sub.commission_reversed_minor;
    if (amt > 0) {
      const base = { sellerId: sub.seller_id, orderRef: sub.order_ref, subRef: sub.ref, ref: sub.ref };
      stmts.push(ledgerStmt(env, { ...base, account: 'commission_accrued', kind: 'commission_earned', amount: -amt }), ledgerStmt(env, { ...base, account: 'commission_earned', kind: 'commission_earned', amount: amt }));
    }
  }
  if (to === 'cancelled' && STOCK_RETURNABLE.has(from)) {
    const items = (await env.DB.prepare('SELECT product_id, qty FROM order_items WHERE seller_order_id = ?').bind(subId).all()).results;
    for (const it of items) stmts.push(env.DB.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND stock_qty IS NOT NULL').bind(it.qty, it.product_id));
  }

  const n = NOTES[to];
  if (n) {
    const target = n[0] === 'buyer' ? { userId: sub.buyer_id, email: sub.buyer_email, link: `#/account/orders/${sub.oid}` } : { userId: sub.seller_id, email: sub.seller_email, link: `#/seller/orders/${sub.id}` };
    stmts.push(...notifyStmts(env, { ...target, kind: `order_${to}`, title: `${n[1]}: ${sub.ref}`, body: n[2] }));
  }
  if (to === 'cancelled') {
    const reason = String(note ?? '').trim();
    const body = reason ? `Reason: ${reason}` : 'Cancelled by the buyer.';
    if (actor.role !== 'buyer') stmts.push(...notifyStmts(env, { userId: sub.buyer_id, email: sub.buyer_email, kind: 'order_cancelled', title: `Order ${sub.ref} cancelled`, body, link: `#/account/orders/${sub.oid}` }));
    if (actor.role !== 'seller') stmts.push(...notifyStmts(env, { userId: sub.seller_id, kind: 'order_cancelled', title: `Order ${sub.ref} cancelled`, body, link: `#/seller/orders/${sub.id}` }));
  }
  stmts.push(clearGuardStmt(env.DB));

  try { await env.DB.batch(stmts); }
  catch (e) { if (isGuardError(e)) throw conflict('stale', 'This order was just updated. Refresh and try again.'); throw e; }

  await audit(env, { actor, action: `order.${to}`, entity: 'seller_order', entityId: subId, data: { ref: sub.ref, from, note: note ?? null } });

  // A cancelled order that had already been paid is refunded in full automatically.
  if (to === 'cancelled' && from !== 'awaiting_payment') {
    const owed = sub.total_minor - sub.refunded_minor;
    if (owed > 0) {
      try { await processRefund(env, { sub: await loadSub(env, subId), amountMinor: owed, reason: `Order cancelled: ${note ?? ''}`.trim(), actor, requestedBy: sub.buyer_id, toStatus: null }); }
      catch (e) {
        console.error('auto refund failed', e);
        await notifyAdmins(env, { kind: 'refund_failed', title: `Manual refund needed for ${sub.ref}`, body: `Cancelled after payment but the refund could not be processed automatically.`, link: '#/admin/refunds' });
      }
    }
  }
  return { ref: sub.ref, from, to };
}

export async function openDispute(env, actor, subId, reason) {
  const sub = await loadSub(env, subId);
  assertParty(sub, actor);
  if (!['dispatched', 'delivered', 'completed'].includes(sub.status)) throw conflict('invalid_state', 'A dispute can be opened once the order is dispatched.');
  if (sub.dispute_open) throw conflict('dispute_exists', 'A dispute is already open for this order.');
  const text = String(reason ?? '').trim();
  if (text.length < 10) throw bad('Describe the problem in a few words.', { reason: 'Please give more detail.' });
  const id = uuid(), ts = nowIso(env);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO disputes (id, seller_order_id, opened_by, reason, created_at) VALUES (?,?,?,?,?)').bind(id, subId, actor.id, text.slice(0, 1000), ts),
    env.DB.prepare('UPDATE seller_orders SET dispute_open = 1, updated_at = ? WHERE id = ?').bind(ts, subId),
    historyStmt(env, { subId, from: sub.status, to: sub.status, actor, note: `Dispute opened: ${text.slice(0, 200)}` }),
    ...notifyStmts(env, { userId: sub.seller_id, kind: 'dispute_opened', title: `Dispute opened on ${sub.ref}`, body: text.slice(0, 200), link: `#/seller/orders/${sub.id}` }),
  ]);
  await notifyAdmins(env, { kind: 'dispute_opened', title: `Dispute opened on ${sub.ref}`, body: text.slice(0, 200), link: '#/admin/orders' });
  await audit(env, { actor, action: 'dispute.opened', entity: 'seller_order', entityId: subId, data: { ref: sub.ref } });
  return { id };
}

export async function resolveDispute(env, actor, subId, resolution) {
  const sub = await loadSub(env, subId);
  const text = String(resolution ?? '').trim();
  if (!sub.dispute_open) throw conflict('no_dispute', 'There is no open dispute.');
  if (text.length < 5) throw bad('Record how it was resolved.', { resolution: 'Required.' });
  const ts = nowIso(env);
  await env.DB.batch([
    env.DB.prepare("UPDATE disputes SET status = 'resolved', resolution = ?, resolved_at = ? WHERE seller_order_id = ? AND status = 'open'").bind(text.slice(0, 1000), ts, subId),
    env.DB.prepare('UPDATE seller_orders SET dispute_open = 0, updated_at = ? WHERE id = ?').bind(ts, subId),
    historyStmt(env, { subId, from: sub.status, to: sub.status, actor, note: `Dispute resolved: ${text.slice(0, 200)}` }),
    ...notifyStmts(env, { userId: sub.buyer_id, email: sub.buyer_email, kind: 'dispute_resolved', title: `Dispute resolved on ${sub.ref}`, body: text.slice(0, 200), link: `#/account/orders/${sub.oid}` }),
    ...notifyStmts(env, { userId: sub.seller_id, kind: 'dispute_resolved', title: `Dispute resolved on ${sub.ref}`, body: text.slice(0, 200), link: `#/seller/orders/${sub.id}` }),
  ]);
  await audit(env, { actor, action: 'dispute.resolved', entity: 'seller_order', entityId: subId, data: { ref: sub.ref } });
  return { resolved: true };
}
