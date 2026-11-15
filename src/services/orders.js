import { ApiError, bad, conflict, forbidden, notFound } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';
import { nowIso, nowDate, getSettings, guardStmt, clearGuardStmt, isGuardError, pad6 } from '../lib/db.js';
import { selectRate, computeSubOrderCommission } from '../lib/commission.js';
import { mulDivRound } from '../lib/money.js';
import { canTransition, STOCK_RETURNABLE, PAID_STATES, allowedActions, parentStatus } from '../lib/orderMachine.js';
import { safeJson } from '../lib/validate.js';
import { ledgerStmt, historyStmt } from './ledger.js';
import { notifyStmts, notifyAdmins } from './notify.js';
import { audit } from './audit.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Reserve the next reference number for a counter, safely under concurrency (optimistic compare-and-set inside the batch). */
export async function nextRef(env, counter, prefix) {
  const year = nowDate(env).getUTCFullYear();
  const cur = await env.DB.prepare('SELECT value FROM counters WHERE name = ?').bind(counter).first();
  return { n: cur.value + 1, ref: `${prefix}-${year}-${pad6(cur.value + 1)}`, bump: () => [
    env.DB.prepare('UPDATE counters SET value = ? WHERE name = ? AND value = ?').bind(cur.value + 1, counter, cur.value),
    guardStmt(env.DB),
  ] };
}

function validateDelivery(b, method) {
  if (method === 'collection') return { name: String(b?.name ?? '').slice(0, 120), phone: String(b?.phone ?? '').slice(0, 30), method };
  const need = ['name', 'phone', 'county', 'town'];
  const errs = {};
  for (const k of need) if (!String(b?.[k] ?? '').trim()) errs[`address.${k}`] = 'Required.';
  if (Object.keys(errs).length) throw bad('Delivery details are incomplete.', errs);
  return {
    name: String(b.name).trim().slice(0, 120), phone: String(b.phone).trim().slice(0, 30),
    county: String(b.county).trim().slice(0, 80), town: String(b.town).trim().slice(0, 80),
    address: String(b.address ?? '').trim().slice(0, 300), notes: String(b.notes ?? '').trim().slice(0, 300), method,
  };
}

/**
 * Create one parent order with a sub-order per seller. Prices, stock, delivery and commission are all computed here on
 * the server from the database; nothing the browser sends about money is trusted. Everything is written in one atomic batch.
 * `quote` (optional) is an accepted quotation that supplies the price and quantity for its single line.
 */
export async function createOrder(env, buyer, { items, address, method = 'delivery', idempotencyKey, quote = null }) {
  if (!['delivery', 'collection'].includes(method)) throw bad('Choose delivery or collection.');
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 80) throw bad('Missing idempotency key.');
  if (!Array.isArray(items) || !items.length || items.length > 25) throw bad('Your cart is empty.');

  const prior = await env.DB.prepare('SELECT id FROM orders WHERE buyer_id = ? AND idempotency_key = ?').bind(buyer.id, idempotencyKey).first();
  if (prior) return { duplicate: true, orderId: prior.id };

  const delivery = validateDelivery(address, method);
  const merged = new Map();
  for (const it of items) {
    if (!it || typeof it.productId !== 'string' || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > 1000000) throw bad('A cart line is invalid.');
    merged.set(it.productId, (merged.get(it.productId) || 0) + it.qty);
  }
  const settings = await getSettings(env.DB);
  const at = nowIso(env);
  const bySeller = new Map();

  for (const [productId, qty] of merged) {
    const p = await env.DB.prepare(
      `SELECT p.*, c.commission_bps AS cat_bps, s.status AS seller_status, s.user_id AS seller_uid, s.founding, s.founding_expires_at,
              s.commission_override_bps, s.delivery_flat_minor, s.business_name AS seller_name
       FROM products p JOIN seller_profiles s ON s.user_id = p.seller_id JOIN categories c ON c.id = p.category_id WHERE p.id = ?`
    ).bind(productId).first();
    if (!p || p.status !== 'active' || p.seller_status !== 'approved') throw conflict('product_unavailable', `"${p?.name ?? 'A product'}" is no longer available.`);
    let unitPrice = p.unit_price_minor;
    if (p.price_model === 'quote') {
      if (!quote || quote.product_id !== productId) throw conflict('quote_required', `"${p.name}" is sold by quotation. Request a quote first.`);
      unitPrice = quote.quoted_unit_price_minor;
    }
    if (qty < p.moq) throw conflict('below_moq', `"${p.name}" has a minimum order of ${p.moq}.`);
    if (p.stock_qty != null && qty > p.stock_qty) throw conflict('insufficient_stock', `Only ${p.stock_qty} of "${p.name}" in stock.`);
    if (method === 'delivery' && p.delivery_options === 'collection') throw conflict('delivery_not_offered', `"${p.name}" is collection only.`);
    if (method === 'collection' && p.delivery_options === 'delivery') throw conflict('collection_not_offered', `"${p.name}" is delivery only.`);
    const rate = selectRate({ seller: p, categoryBps: p.cat_bps, settings, at });
    const lineSubtotal = unitPrice * qty;
    if (!Number.isSafeInteger(lineSubtotal)) throw bad('Order value is too large.');
    if (!bySeller.has(p.seller_uid)) bySeller.set(p.seller_uid, { seller: p, lines: [] });
    bySeller.get(p.seller_uid).lines.push({ p, qty, unitPrice, lineSubtotal, bps: rate.bps, rule: rate.rule });
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await nextRef(env, 'order', 'BH');
    const orderId = uuid();
    const stmts = [...ref.bump()];
    let orderSub = 0, orderDel = 0, orderTax = 0;
    const subs = [];
    let idx = 0;
    for (const { seller, lines } of bySeller.values()) {
      const subtotal = lines.reduce((a, l) => a + l.lineSubtotal, 0);
      const deliveryMinor = quote && quote.quoted_delivery_minor != null ? quote.quoted_delivery_minor : method === 'delivery' ? (seller.delivery_flat_minor ?? 0) : 0;
      const tax = settings.vatBps ? mulDivRound(subtotal, settings.vatBps, 10000) : 0;
      const comm = computeSubOrderCommission(lines.map((l) => ({ lineSubtotalMinor: l.lineSubtotal, bps: l.bps, rule: l.rule })));
      const subId = uuid(), subRef = `${ref.ref}-${LETTERS[idx++]}`;
      const total = subtotal + deliveryMinor + tax;
      orderSub += subtotal; orderDel += deliveryMinor; orderTax += tax;
      subs.push({ id: subId, ref: subRef, sellerId: seller.seller_uid, sellerName: seller.seller_name, total, subtotal, deliveryMinor, commissionMinor: comm.commissionMinor });
      stmts.push(
        env.DB.prepare(`INSERT INTO seller_orders (id, ref, order_id, seller_id, status, product_subtotal_minor, delivery_minor, tax_minor, total_minor, commission_bps, commission_rule, commission_minor, quote_id, created_at, updated_at)
          VALUES (?,?,?,?, 'awaiting_payment', ?,?,?,?,?,?,?,?,?,?)`).bind(subId, subRef, orderId, seller.seller_uid, subtotal, deliveryMinor, tax, total, comm.bps, comm.rule, comm.commissionMinor, quote?.id ?? null, at, at),
        historyStmt(env, { subId, from: null, to: 'awaiting_payment', actor: { id: buyer.id, role: 'buyer' }, note: 'Order placed' }),
      );
      for (const l of lines) {
        stmts.push(env.DB.prepare(`INSERT INTO order_items (id, seller_order_id, product_id, category_id, name, unit, qty, unit_price_minor, line_subtotal_minor, commission_bps, commission_rule) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(uuid(), subId, l.p.id, l.p.category_id, l.p.name, l.p.unit, l.qty, l.unitPrice, l.lineSubtotal, l.bps, l.rule));
        // Products that do not track stock (stock_qty NULL) are never decremented. Tracked stock is taken atomically:
        // the UPDATE only matches when enough remains, and the guard aborts the whole batch otherwise.
        if (l.p.stock_qty != null) {
          stmts.push(
            env.DB.prepare('UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE id = ? AND stock_qty >= ?').bind(l.qty, at, l.p.id, l.qty),
            guardStmt(env.DB),
          );
        }
      }
    }
    const total = orderSub + orderDel + orderTax;
    stmts.splice(2, 0, env.DB.prepare('INSERT INTO orders (id, ref, buyer_id, idempotency_key, currency, product_subtotal_minor, delivery_minor, tax_minor, total_minor, delivery_json, method, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(orderId, ref.ref, buyer.id, idempotencyKey, 'KES', orderSub, orderDel, orderTax, total, JSON.stringify(delivery), method, at));
    for (const s of subs) {
      stmts.push(...notifyStmts(env, { userId: s.sellerId, kind: 'order_placed', title: `New order ${s.ref}`, body: 'Awaiting payment. You will be notified when payment is confirmed.', link: `#/seller/orders/${s.id}` }));
    }
    stmts.push(...notifyStmts(env, { userId: buyer.id, email: buyer.email, kind: 'order_placed', title: `Order ${ref.ref} placed`, body: 'Complete payment to confirm your order.', link: `#/account/orders/${orderId}` }));
    stmts.push(clearGuardStmt(env.DB));

    try {
      await env.DB.batch(stmts);
      await audit(env, { actor: { id: buyer.id, role: 'buyer' }, action: 'order.created', entity: 'order', entityId: orderId, data: { ref: ref.ref, totalMinor: total, sellers: subs.length } });
      return { duplicate: false, orderId, ref: ref.ref, totalMinor: total, subOrders: subs.map(({ id, ref: r, sellerName, total: t }) => ({ id, ref: r, sellerName, totalMinor: t })) };
    } catch (e) {
      if (/UNIQUE.*idempotency|orders\.buyer_id/i.test(String(e?.message))) {
        const again = await env.DB.prepare('SELECT id FROM orders WHERE buyer_id = ? AND idempotency_key = ?').bind(buyer.id, idempotencyKey).first();
        if (again) return { duplicate: true, orderId: again.id };
      }
      if (isGuardError(e)) {
        // Either the reference counter moved (retry) or stock ran out between our read and write.
        const stillOk = await stockStillOk(env, merged);
        if (!stillOk) throw conflict('insufficient_stock', 'Stock changed while you were checking out. Please review your cart.');
        continue;
      }
      if (/UNIQUE.*orders\.ref|UNIQUE.*seller_orders\.ref/i.test(String(e?.message))) continue;
      throw e;
    }
  }
  throw new ApiError(503, 'busy', 'We could not place your order right now. Please try again.');
}

async function stockStillOk(env, merged) {
  for (const [id, qty] of merged) {
    const p = await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(id).first();
    if (!p || (p.stock_qty != null && p.stock_qty < qty)) return false;
  }
  return true;
}
