import { json, readJson, bad, notFound } from '../lib/http.js';
import { fields } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { nowIso } from '../lib/db.js';
import { requireRole } from '../lib/permissions.js';
import { sellerPayable } from '../lib/commission.js';
import { subForSeller } from '../services/views.js';
import { audit } from '../services/audit.js';
import { notifyAdmins } from '../services/notify.js';

export async function sellerStats(env, sellerId) {
  const one = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first());
  const paidStates = "('payment_confirmed','seller_processing','ready_for_dispatch','dispatched','delivered','completed','refund_requested')";
  const total = await one(`SELECT COALESCE(SUM(product_subtotal_minor),0) v, COUNT(*) n FROM seller_orders WHERE seller_id = ? AND status IN ${paidStates}`, sellerId);
  const by = (await env.DB.prepare('SELECT status, COUNT(*) n FROM seller_orders WHERE seller_id = ? GROUP BY status').bind(sellerId).all()).results;
  const count = (...s) => by.filter((x) => s.includes(x.status)).reduce((a, x) => a + x.n, 0);
  const completed = (await env.DB.prepare("SELECT * FROM seller_orders WHERE seller_id = ? AND status = 'completed'").bind(sellerId).all()).results;
  const gross = completed.reduce((a, s) => a + s.product_subtotal_minor, 0);
  const commission = completed.reduce((a, s) => a + s.commission_minor - s.commission_reversed_minor, 0);
  const pendingSettle = completed.filter((s) => s.settlement_status !== 'settled').reduce((a, s) => a + sellerPayable(s), 0);
  const settled = await one("SELECT COALESCE(SUM(amount_minor),0) v FROM settlements WHERE seller_id = ? AND status = 'processed'", sellerId);
  const refunds = await one('SELECT COALESCE(SUM(refunded_minor),0) v FROM seller_orders WHERE seller_id = ?', sellerId);
  const prod = await one("SELECT COUNT(*) n, COALESCE(SUM(stock_qty),0) stock, SUM(CASE WHEN stock_qty IS NOT NULL AND stock_qty <= 0 THEN 1 ELSE 0 END) out, SUM(CASE WHEN stock_qty > 0 AND stock_qty <= 5 THEN 1 ELSE 0 END) low FROM products WHERE seller_id = ? AND status = 'active'", sellerId);
  return {
    sales: { totalSalesMinor: total.v, paidOrders: total.n, completedOrders: count('completed'), pendingOrders: count('awaiting_payment', 'payment_confirmed', 'seller_processing', 'ready_for_dispatch', 'dispatched', 'delivered'), cancelledOrders: count('cancelled'), productsListed: prod.n, availableStock: prod.stock, lowStock: prod.low || 0, outOfStock: prod.out || 0 },
    earnings: { grossSalesMinor: gross, commissionMinor: commission, netEarningsMinor: gross - commission, pendingSettlementsMinor: pendingSettle, completedSettlementsMinor: settled.v, refundsMinor: refunds.v },
  };
}

export function sellerRoutes(r) {
  r.get('/api/seller/dashboard', async ({ env, user }) => {
    requireRole(user, 'seller');
    const m = (await env.DB.prepare(`SELECT substr(created_at,1,7) AS month, SUM(product_subtotal_minor) AS v FROM seller_orders WHERE seller_id = ? AND status NOT IN ('awaiting_payment','cancelled') GROUP BY month ORDER BY month DESC LIMIT 6`).bind(user.id).all()).results.reverse();
    return json({ ...(await sellerStats(env, user.id)), monthly: m.map((x) => ({ month: x.month, salesMinor: x.v })) });
  });

  r.get('/api/seller/orders', async ({ env, user, url }) => {
    requireRole(user, 'seller');
    const st = url.searchParams.get('status');
    const rows = (await env.DB.prepare(
      `SELECT so.id, so.ref, so.status, so.total_minor, so.commission_minor, so.created_at, u.full_name AS buyer_name, (SELECT group_concat(name || ' × ' || qty, ', ') FROM order_items WHERE seller_order_id = so.id) AS items
       FROM seller_orders so JOIN orders o ON o.id = so.order_id JOIN users u ON u.id = o.buyer_id WHERE so.seller_id = ? ${st ? 'AND so.status = ?' : ''} ORDER BY so.created_at DESC LIMIT 200`
    ).bind(...(st ? [user.id, st] : [user.id])).all()).results;
    return json({ orders: rows.map((o) => ({ id: o.id, ref: o.ref, status: o.status, totalMinor: o.total_minor, items: o.items, createdAt: o.created_at, buyerName: ['awaiting_payment'].includes(o.status) ? null : o.buyer_name })) });
  });

  r.get('/api/seller/orders/:id', async ({ env, user, params }) => { requireRole(user, 'seller'); return json({ order: await subForSeller(env, user.id, params.id) }); });

  r.get('/api/seller/settlements', async ({ env, user }) => {
    requireRole(user, 'seller');
    const rows = (await env.DB.prepare('SELECT ref, amount_minor, status, method, reference, created_at, processed_at FROM settlements WHERE seller_id = ? ORDER BY created_at DESC').bind(user.id).all()).results;
    return json({ settlements: rows.map((s) => ({ ref: s.ref, amountMinor: s.amount_minor, status: s.status, method: s.method, reference: s.reference, createdAt: s.created_at, processedAt: s.processed_at })) });
  });

  r.get('/api/seller/profile', async ({ env, user }) => {
    requireRole(user, 'seller');
    const s = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(user.id).first();
    const docs = (await env.DB.prepare('SELECT id, kind, filename, note, created_at FROM seller_documents WHERE seller_id = ? ORDER BY created_at DESC').bind(user.id).all()).results;
    return json({ profile: { slug: s.slug, businessName: s.business_name, contactName: s.contact_name, regNo: s.reg_no, phone: s.phone, email: s.email, location: s.location, country: s.country, region: s.region, town: s.town, description: s.description, status: s.status, statusReason: s.status_reason, founding: !!s.founding, foundingExpiresAt: s.founding_expires_at, deliveryFlatMinor: s.delivery_flat_minor, commissionBps: s.commission_override_bps }, documents: docs });
  });

  r.put('/api/seller/profile', async ({ env, request, user }) => {
    requireRole(user, 'seller');
    const b = await readJson(request);
    const f = fields();
    const phone = f.phone(b), location = f.str(b, 'location', { max: 300 }), description = f.str(b, 'description', { max: 2000 });
    const deliveryFlatMinor = b.deliveryFlatMinor == null ? null : f.int(b, 'deliveryFlatMinor', { min: 0, max: 100000000, label: 'Delivery charge' });
    f.done();
    await env.DB.prepare('UPDATE seller_profiles SET phone = ?, location = ?, description = ?, delivery_flat_minor = ? WHERE user_id = ?').bind(phone, location, description, deliveryFlatMinor, user.id).run();
    await audit(env, { actor: user, action: 'seller.profile_updated', entity: 'seller', entityId: user.id });
    return json({ updated: true });
  });

  // Records which verification documents the seller has supplied. The files themselves must go to private storage (see README).
  r.post('/api/seller/documents', async ({ env, request, user }) => {
    requireRole(user, 'seller');
    const b = await readJson(request);
    const f = fields();
    const kind = f.oneOf(b, 'kind', ['business_registration', 'tax_certificate', 'national_id', 'trade_licence', 'other'], { label: 'Document type' });
    const filename = f.str(b, 'filename', { max: 200, label: 'File name' });
    const note = f.str(b, 'note', { max: 300, optional: true });
    f.done();
    const id = uuid();
    await env.DB.prepare('INSERT INTO seller_documents (id, seller_id, kind, filename, note, created_at) VALUES (?,?,?,?,?,?)').bind(id, user.id, kind, filename, note, nowIso(env)).run();
    await notifyAdmins(env, { kind: 'seller_document', title: `New document from ${user.seller.business_name}`, body: kind, link: '#/admin/sellers' });
    return json({ id }, 201);
  });
}
