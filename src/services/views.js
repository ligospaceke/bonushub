import { notFound } from '../lib/http.js';
import { safeJson } from '../lib/validate.js';
import { allowedActions, PAID_STATES } from '../lib/orderMachine.js';
import { sellerPayable } from '../lib/commission.js';

export function shapeProduct(p, images = [], { owner = false } = {}) {
  const stock = p.stock_qty == null ? 'on_request' : p.stock_qty <= 0 ? 'out_of_stock' : p.stock_qty <= 5 ? 'low_stock' : 'in_stock';
  return {
    id: p.id, name: p.name, brand: p.brand, description: p.description, specs: safeJson(p.specs, []), unit: p.unit, moq: p.moq,
    stockStatus: stock, stockQty: owner ? p.stock_qty : undefined, priceModel: p.price_model, unitPriceMinor: p.unit_price_minor, currency: p.currency,
    originCountry: p.origin_country, deliveryOptions: p.delivery_options, status: owner ? p.status : undefined, statusReason: owner ? p.status_reason : undefined,
    category: p.category_name ? { id: p.category_id, name: p.category_name, slug: p.category_slug } : { id: p.category_id },
    seller: p.seller_name ? { id: p.seller_id, name: p.seller_name, slug: p.seller_slug, founding: !!p.seller_founding, town: p.seller_town } : undefined,
    images: images.map((i) => i.url), createdAt: p.created_at,
  };
}

export async function imagesFor(env, ids) {
  if (!ids.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT * FROM product_images WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order`).bind(...ids).all()).results;
  const m = new Map();
  for (const r of rows) { if (!m.has(r.product_id)) m.set(r.product_id, []); m.get(r.product_id).push(r); }
  return m;
}

export const PRODUCT_SELECT = `SELECT p.*, c.name AS category_name, c.slug AS category_slug, s.business_name AS seller_name, s.slug AS seller_slug,
  s.founding AS seller_founding, s.town AS seller_town FROM products p JOIN categories c ON c.id = p.category_id JOIN seller_profiles s ON s.user_id = p.seller_id`;

async function itemsAndHistory(env, subId) {
  const items = (await env.DB.prepare('SELECT * FROM order_items WHERE seller_order_id = ?').bind(subId).all()).results;
  const history = (await env.DB.prepare('SELECT from_status, to_status, actor_role, note, created_at FROM order_status_history WHERE seller_order_id = ? ORDER BY id').bind(subId).all()).results;
  return { items, history };
}

const shapeItem = (i) => ({ productId: i.product_id, name: i.name, unit: i.unit, qty: i.qty, unitPriceMinor: i.unit_price_minor, lineSubtotalMinor: i.line_subtotal_minor });

/** What a buyer may see of a sub-order. Commission and seller finances are never included. */
function subForBuyer(s, extra) {
  return {
    id: s.id, ref: s.ref, status: s.status, seller: { name: s.seller_name, slug: s.seller_slug }, productSubtotalMinor: s.product_subtotal_minor, deliveryMinor: s.delivery_minor,
    taxMinor: s.tax_minor, totalMinor: s.total_minor, refundedMinor: s.refunded_minor, trackingRef: s.tracking_ref, carrier: s.carrier, proofNote: s.proof_note,
    disputeOpen: !!s.dispute_open, dispatchedAt: s.dispatched_at, deliveredAt: s.delivered_at, completedAt: s.completed_at, cancelReason: s.cancel_reason,
    actions: allowedActions(s.status, 'buyer').filter((a) => !['refund_requested'].includes(a)), canRequestRefund: ['delivered', 'completed'].includes(s.status) && s.refunded_minor < s.total_minor,
    canDispute: ['dispatched', 'delivered', 'completed'].includes(s.status) && !s.dispute_open,
    items: extra.items.map(shapeItem), history: extra.history,
  };
}

export async function orderForBuyer(env, buyerId, orderId) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND buyer_id = ?').bind(orderId, buyerId).first();
  if (!o) throw notFound('Order');
  const subs = (await env.DB.prepare('SELECT so.*, s.business_name AS seller_name, s.slug AS seller_slug FROM seller_orders so JOIN seller_profiles s ON s.user_id = so.seller_id WHERE so.order_id = ? ORDER BY so.ref').bind(orderId).all()).results;
  const payments = (await env.DB.prepare('SELECT ref, amount_minor, method, status, provider_ref, created_at, paid_at, refunded_minor FROM payments WHERE order_id = ? ORDER BY created_at').bind(orderId).all()).results;
  const out = [];
  for (const s of subs) out.push(subForBuyer(s, await itemsAndHistory(env, s.id)));
  const refunds = (await env.DB.prepare('SELECT r.ref, r.amount_minor, r.status, r.reason, r.created_at, so.ref AS sub_ref FROM refunds r JOIN seller_orders so ON so.id = r.seller_order_id WHERE so.order_id = ? ORDER BY r.created_at').bind(orderId).all()).results;
  return {
    id: o.id, ref: o.ref, createdAt: o.created_at, currency: o.currency, productSubtotalMinor: o.product_subtotal_minor, deliveryMinor: o.delivery_minor, taxMinor: o.tax_minor, totalMinor: o.total_minor,
    method: o.method, delivery: safeJson(o.delivery_json, {}), subOrders: out,
    payments: payments.map((p) => ({ ref: p.ref, amountMinor: p.amount_minor, method: p.method, status: p.status, providerRef: p.provider_ref, createdAt: p.created_at, paidAt: p.paid_at, refundedMinor: p.refunded_minor })),
    refunds: refunds.map((r) => ({ ref: r.ref, subRef: r.sub_ref, amountMinor: r.amount_minor, status: r.status, createdAt: r.created_at })),
    amountDueMinor: out.filter((s) => s.status === 'awaiting_payment').reduce((a, s) => a + s.totalMinor, 0),
  };
}

export async function listOrdersForBuyer(env, buyerId) {
  const rows = (await env.DB.prepare('SELECT * FROM orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 200').bind(buyerId).all()).results;
  const out = [];
  for (const o of rows) {
    const subs = (await env.DB.prepare('SELECT ref, status, total_minor FROM seller_orders WHERE order_id = ?').bind(o.id).all()).results;
    out.push({ id: o.id, ref: o.ref, createdAt: o.created_at, totalMinor: o.total_minor, subOrders: subs.map((s) => ({ ref: s.ref, status: s.status, totalMinor: s.total_minor })) });
  }
  return out;
}

/** What a seller may see of their own sub-order, including their commission. Buyer contact appears only once payment is confirmed. */
export async function subForSeller(env, sellerId, subId) {
  const s = await env.DB.prepare('SELECT so.*, o.ref AS order_ref, o.delivery_json, o.method, o.buyer_id FROM seller_orders so JOIN orders o ON o.id = so.order_id WHERE so.id = ? AND so.seller_id = ?').bind(subId, sellerId).first();
  if (!s) throw notFound('Order');
  const paid = PAID_STATES.has(s.status) || (s.status === 'cancelled' && s.refunded_minor > 0);
  let buyer = null;
  if (paid) {
    const u = await env.DB.prepare('SELECT full_name, email, phone, business_name FROM users WHERE id = ?').bind(s.buyer_id).first();
    buyer = { name: u.full_name, email: u.email, phone: u.phone, businessName: u.business_name, delivery: safeJson(s.delivery_json, {}) };
  }
  const x = await itemsAndHistory(env, subId);
  return {
    id: s.id, ref: s.ref, orderRef: s.order_ref, status: s.status, method: s.method, productSubtotalMinor: s.product_subtotal_minor, deliveryMinor: s.delivery_minor, taxMinor: s.tax_minor,
    totalMinor: s.total_minor, commissionBps: s.commission_bps, commissionRule: s.commission_rule, commissionMinor: s.commission_minor, commissionReversedMinor: s.commission_reversed_minor,
    commissionStatus: s.commission_status, sellerProceedsMinor: sellerPayable(s), refundedMinor: s.refunded_minor, settlementStatus: s.settlement_status, trackingRef: s.tracking_ref, carrier: s.carrier,
    disputeOpen: !!s.dispute_open, cancelReason: s.cancel_reason, createdAt: s.created_at, buyer, actions: allowedActions(s.status, 'seller'),
    items: x.items.map(shapeItem), history: x.history,
  };
}
