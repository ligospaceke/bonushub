import { ApiError, bad, conflict, notFound } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';
import { nowIso, guardStmt, clearGuardStmt, isGuardError, getSettings, addMinutes } from '../lib/db.js';
import { getProvider, providerByName } from '../payments/index.js';
import { ledgerStmt, historyStmt } from './ledger.js';
import { notifyStmts, notifyAdmins } from './notify.js';
import { audit } from './audit.js';
import { nextRef } from './orders.js';

const METHODS = ['mpesa', 'card'];

/** Begin (or resume) payment for every unpaid sub-order of an order. The amount is always computed from the database. */
export async function startPayment(env, buyer, orderId, { method, phone }) {
  if (!METHODS.includes(method)) throw bad('Choose M-Pesa or card.', { method: 'Not supported.' });
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND buyer_id = ?').bind(orderId, buyer.id).first();
  if (!order) throw notFound('Order');
  let msisdn = null;
  if (method === 'mpesa') {
    msisdn = String(phone ?? '').replace(/[\s()-]/g, '');
    if (!/^(\+?254|0)[17]\d{8}$/.test(msisdn)) throw bad('Enter a valid Safaricom number, for example 0712 345 678.', { phone: 'Invalid M-Pesa number.' });
    msisdn = '254' + msisdn.replace(/^(\+?254|0)/, '');
  }
  const due = (await env.DB.prepare("SELECT COALESCE(SUM(total_minor),0) AS amt, COUNT(*) AS n FROM seller_orders WHERE order_id = ? AND status = 'awaiting_payment'").bind(orderId).first());
  if (!due.n) throw conflict('nothing_due', 'This order has nothing awaiting payment.');

  const provider = getProvider(env);
  const existing = await env.DB.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").bind(orderId).first();
  const ts = nowIso(env);
  if (existing) {
    if (existing.method === method && existing.amount_minor === due.amt) return { payment: existing, resumed: true, action: await resumeAction(env, existing, provider) };
    await env.DB.prepare("UPDATE payments SET status = 'failed', failure_reason = 'Superseded by a new attempt', updated_at = ? WHERE id = ? AND status = 'pending'").bind(ts, existing.id).run();
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await nextRef(env, 'payment', 'PAY');
    const id = uuid();
    try {
      await env.DB.batch([...ref.bump(), env.DB.prepare("INSERT INTO payments (id, ref, order_id, amount_minor, currency, method, provider, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)")
        .bind(id, ref.ref, orderId, due.amt, 'KES', method, provider.name, ts, ts), clearGuardStmt(env.DB)]);
    } catch (e) { if (isGuardError(e) || /UNIQUE/i.test(String(e?.message))) continue; throw e; }
    const payment = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first();
    try {
      const started = await provider.initiate(env, payment, { method, phone: msisdn });
      await audit(env, { actor: { id: buyer.id, role: 'buyer' }, action: 'payment.initiated', entity: 'payment', entityId: id, data: { ref: ref.ref, amountMinor: due.amt, method } });
      return { payment: { ...payment, provider_ref: started.providerRef }, action: started.action };
    } catch (e) {
      await env.DB.prepare("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?").bind(String(e.message).slice(0, 200), nowIso(env), id).run();
      throw new ApiError(502, 'provider_error', 'The payment provider could not start the payment. Please try again.');
    }
  }
  throw new ApiError(503, 'busy', 'Could not start payment right now. Please try again.');
}

async function resumeAction(env, payment, provider) {
  return provider.name === 'sandbox' ? { type: 'sandbox_redirect', url: `/#/pay/${payment.ref}` } : { type: 'await_provider' };
}

/**
 * The only code path that marks money as received. It asks the payment provider server-to-server what really happened
 * (webhooks merely trigger this), checks the amount, and confirms every unpaid sub-order atomically.
 * Safe to call repeatedly: a payment that is already settled is left untouched.
 */
export async function confirmPayment(env, paymentRef) {
  const payment = await env.DB.prepare('SELECT * FROM payments WHERE ref = ?').bind(paymentRef).first();
  if (!payment) throw notFound('Payment');
  if (payment.status !== 'pending') return { status: payment.status, changed: false };
  const provider = providerByName(payment.provider);
  const truth = await provider.query(env, payment);
  const ts = nowIso(env);

  if (truth.state === 'pending') return { status: 'pending', changed: false };
  if (truth.state === 'failed') {
    const r = await env.DB.prepare("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind('Declined or cancelled at provider', ts, payment.id).run();
    if (r.meta.changes) {
      const o = await env.DB.prepare('SELECT o.buyer_id, o.ref, u.email FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.id = ?').bind(payment.order_id).first();
      await env.DB.batch(notifyStmts(env, { userId: o.buyer_id, email: o.email, kind: 'payment_failed', title: `Payment failed for ${o.ref}`, body: 'No money was taken. You can try again from your order page.', link: `#/account/orders/${payment.order_id}` }));
      await audit(env, { action: 'payment.failed', entity: 'payment', entityId: payment.id, data: { ref: payment.ref } });
    }
    return { status: 'failed', changed: !!r.meta.changes };
  }

  if (truth.amountMinor !== payment.amount_minor) {
    await notifyAdmins(env, { kind: 'payment_mismatch', title: `Payment amount mismatch: ${payment.ref}`, body: `Provider reports ${truth.amountMinor}, expected ${payment.amount_minor}. Not confirmed; reconcile manually.`, link: '#/admin/payments' });
    await audit(env, { action: 'payment.mismatch', entity: 'payment', entityId: payment.id, data: { expected: payment.amount_minor, reported: truth.amountMinor } });
    return { status: 'pending', changed: false, mismatch: true };
  }

  const subs = (await env.DB.prepare(
    `SELECT so.*, o.ref AS order_ref, o.buyer_id, u.email AS buyer_email, su.email AS seller_email
     FROM seller_orders so JOIN orders o ON o.id = so.order_id JOIN users u ON u.id = o.buyer_id JOIN users su ON su.id = so.seller_id
     WHERE so.order_id = ? AND so.status = 'awaiting_payment'`).bind(payment.order_id).all()).results;
  const dueSum = subs.reduce((a, s) => a + s.total_minor, 0);
  if (dueSum !== payment.amount_minor) {
    await notifyAdmins(env, { kind: 'payment_reconcile', title: `Reconcile payment ${payment.ref}`, body: 'Money was received but the order changed while paying. Not auto-confirmed.', link: '#/admin/payments' });
    return { status: 'pending', changed: false, needsReconcile: true };
  }

  const stmts = [
    env.DB.prepare("UPDATE payments SET status = 'successful', provider_ref = COALESCE(?, provider_ref), paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(truth.providerRef ?? null, ts, ts, payment.id),
    guardStmt(env.DB),
  ];
  for (const s of subs) {
    const base = { sellerId: s.seller_id, orderRef: s.order_ref, subRef: s.ref, ref: payment.ref };
    stmts.push(
      env.DB.prepare("UPDATE seller_orders SET status = 'payment_confirmed', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'").bind(ts, s.id),
      guardStmt(env.DB),
      historyStmt(env, { subId: s.id, from: 'awaiting_payment', to: 'payment_confirmed', actor: null, note: `Payment ${payment.ref} verified with provider` }),
      ledgerStmt(env, { ...base, account: 'gateway_clearing', kind: 'payment', amount: s.total_minor }),
      ledgerStmt(env, { ...base, account: 'seller_payable', kind: 'payment', amount: s.total_minor - s.commission_minor }),
      ledgerStmt(env, { ...base, account: 'commission_accrued', kind: 'commission_accrued', amount: s.commission_minor }),
      ...notifyStmts(env, { userId: s.seller_id, email: s.seller_email, kind: 'payment_confirmed', title: `Paid order ${s.ref}`, body: 'Payment is confirmed. Please accept and prepare the order.', link: `#/seller/orders/${s.id}` }),
    );
  }
  const buyer = subs[0];
  stmts.push(...notifyStmts(env, { userId: buyer.buyer_id, email: buyer.buyer_email, kind: 'payment_confirmed', title: `Payment confirmed for ${buyer.order_ref}`, body: 'Thank you. Sellers have been notified.', link: `#/account/orders/${payment.order_id}` }), clearGuardStmt(env.DB));
  try { await env.DB.batch(stmts); }
  catch (e) { if (isGuardError(e)) return { status: 'successful', changed: false, raced: true }; throw e; }
  await audit(env, { action: 'payment.confirmed', entity: 'payment', entityId: payment.id, data: { ref: payment.ref, amountMinor: payment.amount_minor } });
  return { status: 'successful', changed: true };
}

/** Handle a provider callback: authenticate it, store it once, then verify the truth with the provider. */
export async function processWebhook(env, providerName, rawBody, headers) {
  const provider = providerByName(providerName);
  if (!provider) throw notFound('Provider');
  const v = await provider.verifyWebhook(env, rawBody, headers);
  const ts = nowIso(env);
  if (!v.ok) {
    await env.DB.prepare('INSERT INTO payment_events (provider, provider_event_id, type, payload, signature_ok, received_at) VALUES (?,?,?,?,0,?)').bind(providerName, 'invalid-' + uuid(), 'invalid', rawBody.slice(0, 2000), ts).run();
    throw new ApiError(401, 'bad_signature', 'Invalid signature.');
  }
  try {
    await env.DB.prepare('INSERT INTO payment_events (provider, provider_event_id, payment_ref, type, payload, signature_ok, received_at) VALUES (?,?,?,?,?,1,?)')
      .bind(providerName, v.event.id, v.event.paymentRef ?? null, v.event.type ?? null, rawBody.slice(0, 4000), ts).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return { duplicate: true };
    throw e;
  }
  if (!v.event.paymentRef) return { ignored: true };
  return confirmPayment(env, v.event.paymentRef);
}
