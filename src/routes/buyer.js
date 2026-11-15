import { json, readJson, bad, notFound, forbidden, conflict, ApiError } from '../lib/http.js';
import { fields } from '../lib/validate.js';
import { uuid, hmacHex } from '../lib/crypto.js';
import { nowIso } from '../lib/db.js';
import { requireRole } from '../lib/permissions.js';
import { rateLimit } from '../lib/ratelimit.js';
import { createOrder } from '../services/orders.js';
import { startPayment, confirmPayment, processWebhook } from '../services/payments.js';
import { transition, openDispute, resolveDispute, loadSub, assertParty } from '../services/fulfilment.js';
import { requestRefund } from '../services/refunds.js';
import { orderForBuyer, listOrdersForBuyer, subForSeller } from '../services/views.js';
import { sandbox, sandboxSecret } from '../payments/sandbox.js';
import { audit } from '../services/audit.js';

async function priceCart(env, items, method) {
  if (!Array.isArray(items) || !items.length || items.length > 25) throw bad('Your cart is empty.');
  const lines = [], sellers = new Map();
  for (const it of items) {
    if (!it || typeof it.productId !== 'string' || !Number.isInteger(it.qty) || it.qty < 1) throw bad('A cart line is invalid.');
    const p = await env.DB.prepare(
      `SELECT p.*, s.business_name AS seller_name, s.user_id AS sid, s.status AS sstatus, s.delivery_flat_minor FROM products p JOIN seller_profiles s ON s.user_id = p.seller_id WHERE p.id = ?`).bind(it.productId).first();
    const problems = [];
    if (!p || p.status !== 'active' || p.sstatus !== 'approved') problems.push('No longer available');
    else {
      if (p.price_model === 'quote') problems.push('Sold by quotation only');
      if (it.qty < p.moq) problems.push(`Minimum order is ${p.moq}`);
      if (p.stock_qty != null && it.qty > p.stock_qty) problems.push(`Only ${p.stock_qty} in stock`);
      if (method === 'delivery' && p.delivery_options === 'collection') problems.push('Collection only');
      if (method === 'collection' && p.delivery_options === 'delivery') problems.push('Delivery only');
    }
    const line = { productId: it.productId, name: p?.name ?? 'Unavailable product', unit: p?.unit, qty: it.qty, moq: p?.moq, unitPriceMinor: p?.unit_price_minor ?? 0, lineSubtotalMinor: (p?.unit_price_minor ?? 0) * it.qty, sellerId: p?.sid, sellerName: p?.seller_name, problems };
    lines.push(line);
    if (p && !sellers.has(p.sid)) sellers.set(p.sid, { sellerId: p.sid, sellerName: p.seller_name, deliveryMinor: method === 'delivery' ? (p.delivery_flat_minor ?? 0) : 0, subtotalMinor: 0 });
    if (p) sellers.get(p.sid).subtotalMinor += line.lineSubtotalMinor;
  }
  const groups = [...sellers.values()];
  const sub = groups.reduce((a, g) => a + g.subtotalMinor, 0), del = groups.reduce((a, g) => a + g.deliveryMinor, 0);
  return { lines, sellers: groups, productSubtotalMinor: sub, deliveryMinor: del, totalMinor: sub + del, ok: lines.every((l) => !l.problems.length) };
}

export function buyerRoutes(r) {
  r.post('/api/cart/price', { public: true }, async ({ env, request }) => {
    const b = await readJson(request);
    return json(await priceCart(env, b.items, b.method === 'collection' ? 'collection' : 'delivery'));
  });

  r.post('/api/checkout', async ({ env, request, user }) => {
    requireRole(user, 'buyer');
    await rateLimit(env, `checkout:${user.id}`, 20, 600);
    const b = await readJson(request);
    const res = await createOrder(env, user, { items: b.items, address: b.address, method: b.method === 'collection' ? 'collection' : 'delivery', idempotencyKey: b.idempotencyKey });
    return json(res, res.duplicate ? 200 : 201);
  });

  r.get('/api/me/orders', async ({ env, user }) => { requireRole(user, 'buyer'); return json({ orders: await listOrdersForBuyer(env, user.id) }); });
  r.get('/api/me/orders/:id', async ({ env, user, params }) => { requireRole(user, 'buyer'); return json({ order: await orderForBuyer(env, user.id, params.id) }); });

  r.post('/api/orders/:id/pay', async ({ env, request, user, params }) => {
    requireRole(user, 'buyer');
    await rateLimit(env, `pay:${user.id}`, 15, 600);
    const b = await readJson(request);
    const res = await startPayment(env, user, params.id, { method: b.method, phone: b.phone });
    return json({ payment: { ref: res.payment.ref, amountMinor: res.payment.amount_minor, method: res.payment.method, status: res.payment.status }, action: res.action });
  });

  // Polling this also re-verifies a pending payment with the provider, so a missed webhook never strands an order.
  r.get('/api/payments/:ref', async ({ env, user, params }) => {
    const p = await env.DB.prepare('SELECT p.*, o.buyer_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.ref = ?').bind(params.ref).first();
    if (!p || (user.role === 'buyer' && p.buyer_id !== user.id) || user.role === 'seller') throw notFound('Payment');
    let status = p.status;
    if (status === 'pending') status = (await confirmPayment(env, p.ref)).status;
    return json({ ref: p.ref, status, amountMinor: p.amount_minor, method: p.method, orderId: p.order_id, provider: p.provider });
  });

  r.post('/api/payments/webhook/:provider', { public: true }, async ({ env, request, params }) => {
    const raw = await request.text();
    if (raw.length > 20000) throw new ApiError(413, 'too_large', 'Too large.');
    return json(await processWebhook(env, params.provider, raw, request.headers));
  });

  // Sandbox only: stands in for the buyer approving the M-Pesa prompt or card page. Absent when a real provider is configured.
  r.post('/api/sandbox/pay/:ref', async ({ env, request, user, params }) => {
    if (!(env.DEV_MODE || env.SANDBOX_ENABLED === 'true')) throw notFound('Route');
    requireRole(user, 'buyer');
    const p = await env.DB.prepare('SELECT p.*, o.buyer_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.ref = ?').bind(params.ref).first();
    if (!p || p.buyer_id !== user.id || p.provider !== 'sandbox') throw notFound('Payment');
    const b = await readJson(request);
    const outcome = b.outcome === 'decline' ? 'failed' : 'success';
    await sandbox.settleSandboxTxn(env, p.ref, outcome);
    const body = JSON.stringify({ id: uuid(), type: `payment.${outcome}`, paymentRef: p.ref, providerRef: p.provider_ref });
    const headers = new Headers({ 'x-bh-signature': await hmacHex(sandboxSecret(env), body) });
    return json(await processWebhook(env, 'sandbox', body, headers));
  });

  r.post('/api/seller-orders/:id/transition', async ({ env, request, user, params }) => {
    const b = await readJson(request);
    if (!['buyer', 'seller', 'admin'].includes(user.role)) throw forbidden();
    if (user.role === 'admin' && !['owner', 'support', 'finance'].includes(user.staff_role)) throw forbidden();
    const to = String(b.to ?? '');
    const res = await transition(env, user, params.id, to, { note: b.note, trackingRef: b.trackingRef, carrier: b.carrier, proofNote: b.proofNote });
    return json(res);
  });

  r.post('/api/seller-orders/:id/dispute', async ({ env, request, user, params }) => {
    requireRole(user, 'buyer', 'seller');
    const b = await readJson(request);
    return json(await openDispute(env, user, params.id, b.reason), 201);
  });

  r.post('/api/seller-orders/:id/refund-request', async ({ env, request, user, params }) => {
    requireRole(user, 'buyer');
    const b = await readJson(request);
    return json(await requestRefund(env, user, params.id, { amountMinor: b.amountMinor, reason: b.reason }), 201);
  });

  // ---- profile, addresses, notifications ----
  r.put('/api/me/profile', async ({ env, request, user }) => {
    const b = await readJson(request);
    const f = fields();
    const fullName = f.str(b, 'fullName', { max: 120, label: 'Full name' });
    const phone = f.phone(b);
    const county = f.str(b, 'county', { max: 80, optional: true }), town = f.str(b, 'town', { max: 80, optional: true });
    const businessName = f.str(b, 'businessName', { max: 160, optional: true }), businessType = f.str(b, 'businessType', { max: 80, optional: true });
    f.done();
    await env.DB.prepare('UPDATE users SET full_name = ?, phone = ?, county = ?, town = ?, business_name = ?, business_type = ?, phone_verified_at = CASE WHEN phone = ? THEN phone_verified_at ELSE NULL END WHERE id = ?')
      .bind(fullName, phone, county, town, businessName, businessType, phone, user.id).run();
    await audit(env, { actor: user, action: 'profile.updated', entity: 'user', entityId: user.id });
    return json({ updated: true });
  });

  r.get('/api/me/addresses', async ({ env, user }) => json({ addresses: (await env.DB.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all()).results }));
  r.post('/api/me/addresses', async ({ env, request, user }) => {
    requireRole(user, 'buyer');
    const b = await readJson(request);
    const f = fields();
    const a = { label: f.str(b, 'label', { max: 40, optional: true }), name: f.str(b, 'name', { max: 120 }), phone: f.phone(b), county: f.str(b, 'county', { max: 80 }), town: f.str(b, 'town', { max: 80 }), address: f.str(b, 'address', { max: 300, optional: true }), notes: f.str(b, 'notes', { max: 300, optional: true }) };
    f.done();
    const n = (await env.DB.prepare('SELECT COUNT(*) n FROM addresses WHERE user_id = ?').bind(user.id).first()).n;
    if (n >= 20) throw conflict('too_many', 'You can save up to 20 addresses.');
    const id = uuid();
    await env.DB.prepare('INSERT INTO addresses (id, user_id, label, name, phone, county, town, address, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, user.id, a.label, a.name, a.phone, a.county, a.town, a.address, a.notes, nowIso(env)).run();
    return json({ id }, 201);
  });
  r.delete('/api/me/addresses/:id', async ({ env, user, params }) => {
    const res = await env.DB.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').bind(params.id, user.id).run();
    if (!res.meta.changes) throw notFound('Address');
    return json({ removed: true });
  });

  r.get('/api/me/notifications', async ({ env, user }) => {
    const rows = (await env.DB.prepare('SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(user.id).all()).results;
    return json({ unread: rows.filter((n) => !n.read_at).length, notifications: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: n.created_at })) });
  });
  r.post('/api/me/notifications/read', async ({ env, user }) => {
    await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(nowIso(env), user.id).run();
    return json({ ok: true });
  });
}
