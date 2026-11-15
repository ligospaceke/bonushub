import { json, readJson, bad, notFound, conflict, forbidden } from '../lib/http.js';
import { fields, slugify } from '../lib/validate.js';
import { uuid, hashPassword } from '../lib/crypto.js';
import { nowIso, addMonths, getSettings, guardStmt } from '../lib/db.js';
import { need, can, requireRole, STAFF_PERMISSIONS } from '../lib/permissions.js';
import { sellerPayable } from '../lib/commission.js';
import { audit, verifyAuditChain } from '../services/audit.js';
import { notify, notifyStmts } from '../services/notify.js';
import { ledgerBalances } from '../services/ledger.js';
import { subForSeller, shapeProduct, imagesFor, PRODUCT_SELECT } from '../services/views.js';
import { decideRefund } from '../services/refunds.js';
import { resolveDispute } from '../services/fulfilment.js';
import { createSettlement, markSettlementProcessed, cancelSettlement, settlementCandidates } from '../services/settlements.js';
import { runJobs } from '../services/jobs.js';
import { sellerStats } from './seller.js';

const PAID = "('payment_confirmed','seller_processing','ready_for_dispatch','dispatched','delivered','completed','refund_requested','refunded')";

function range(url) {
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  return { from: ok(from) ? from : '1970-01-01', to: ok(to) ? to + 'T23:59:59.999Z' : '9999-12-31T00:00:00Z' };
}

export async function salesReport(env, { from, to, group = 'month' }) {
  const fmt = { day: 10, month: 7, year: 4 }[group] || 7;
  const rows = (await env.DB.prepare(
    `SELECT substr(so.created_at,1,${fmt}) AS period, COUNT(*) AS orders, SUM(so.product_subtotal_minor) AS product_value, SUM(so.total_minor) AS total_value,
       SUM(CASE WHEN so.status = 'completed' THEN so.commission_minor - so.commission_reversed_minor ELSE 0 END) AS commission_earned,
       SUM(CASE WHEN so.status IN ('payment_confirmed','seller_processing','ready_for_dispatch','dispatched','delivered','refund_requested') THEN so.commission_minor - so.commission_reversed_minor ELSE 0 END) AS commission_accrued,
       SUM(so.refunded_minor) AS refunds
     FROM seller_orders so WHERE so.status IN ${PAID} AND so.created_at >= ? AND so.created_at <= ? GROUP BY period ORDER BY period`
  ).bind(from, to).all()).results;
  const topSellers = (await env.DB.prepare(
    `SELECT s.business_name AS name, COUNT(*) AS orders, SUM(so.product_subtotal_minor) AS sales, SUM(so.commission_minor - so.commission_reversed_minor) AS commission
     FROM seller_orders so JOIN seller_profiles s ON s.user_id = so.seller_id WHERE so.status IN ${PAID} AND so.created_at >= ? AND so.created_at <= ? GROUP BY so.seller_id ORDER BY sales DESC LIMIT 10`).bind(from, to).all()).results;
  const topProducts = (await env.DB.prepare(
    `SELECT oi.name, SUM(oi.qty) AS units, SUM(oi.line_subtotal_minor) AS sales FROM order_items oi JOIN seller_orders so ON so.id = oi.seller_order_id
     WHERE so.status IN ${PAID} AND so.created_at >= ? AND so.created_at <= ? GROUP BY oi.product_id ORDER BY sales DESC LIMIT 10`).bind(from, to).all()).results;
  return { periods: rows, topSellers, topProducts };
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (head, rows) => [head.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

export function adminRoutes(r) {
  r.get('/api/admin/overview', async ({ env, user, url }) => {
    need(user, 'overview');
    const { from, to } = range(url);
    const one = async (sql, ...a) => await env.DB.prepare(sql).bind(...a).first();
    const t = await one(`SELECT COALESCE(SUM(total_minor),0) tv, COUNT(*) n, COALESCE(SUM(CASE WHEN status='completed' THEN product_subtotal_minor END),0) cs,
        COALESCE(SUM(CASE WHEN status='completed' THEN commission_minor - commission_reversed_minor END),0) ce,
        COALESCE(SUM(CASE WHEN status IN ('payment_confirmed','seller_processing','ready_for_dispatch','dispatched','delivered','refund_requested') THEN commission_minor - commission_reversed_minor END),0) ca
      FROM seller_orders WHERE status IN ${PAID} AND created_at >= ? AND created_at <= ?`, from, to);
    const allOrders = (await one('SELECT COUNT(*) n FROM orders WHERE created_at >= ? AND created_at <= ?', from, to)).n;
    const sellers = await one("SELECT SUM(status='approved') a, SUM(status='pending') p, SUM(status='suspended') s, SUM(founding=1) f FROM seller_profiles");
    const set = await getSettings(env.DB);
    const attention = {
      failedPayments: (await one("SELECT COUNT(*) n FROM payments WHERE status = 'failed' AND created_at >= ?", from)).n,
      refundRequests: (await one("SELECT COUNT(*) n FROM refunds WHERE status = 'requested'")).n,
      openDisputes: (await one('SELECT COUNT(*) n FROM seller_orders WHERE dispute_open = 1')).n,
      pendingProducts: (await one("SELECT COUNT(*) n FROM products WHERE status = 'pending'")).n,
      outOfStock: (await one("SELECT COUNT(*) n FROM products WHERE status = 'active' AND stock_qty IS NOT NULL AND stock_qty <= 0")).n,
      settlementsDue: (await settlementCandidates(env)).reduce((a, c) => a + c.amountMinor, 0),
    };
    const rep = await salesReport(env, { from, to, group: 'month' });
    return json({
      totals: { transactionValueMinor: t.tv, completedSalesMinor: t.cs, totalOrders: allOrders, paidSubOrders: t.n, commissionEarnedMinor: t.ce, commissionAccruedMinor: t.ca,
        sellersApproved: sellers.a || 0, sellersPending: sellers.p || 0, sellersSuspended: sellers.s || 0, foundingUsed: sellers.f || 0, foundingSlots: set.foundingSlots,
        buyers: (await one("SELECT COUNT(*) n FROM users WHERE role = 'buyer'")).n, activeProducts: (await one("SELECT COUNT(*) n FROM products p JOIN seller_profiles s ON s.user_id = p.seller_id WHERE p.status = 'active' AND s.status = 'approved'")).n },
      attention, monthly: rep.periods, topSellers: rep.topSellers, topProducts: rep.topProducts,
      ledger: can(user, 'payments') ? await ledgerBalances(env) : undefined,
    });
  });

  r.get('/api/admin/reports/sales', async ({ env, user, url }) => {
    need(user, 'reports');
    const { from, to } = range(url);
    const group = ['day', 'week', 'month', 'year'].includes(url.searchParams.get('group')) ? url.searchParams.get('group') : 'month';
    const g = group === 'week' ? 'day' : group;
    let rep = await salesReport(env, { from, to, group: g });
    if (group === 'week') {
      const weeks = new Map();
      for (const p of rep.periods) {
        const d = new Date(p.period + 'T00:00:00Z'); const wk = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
        const x = weeks.get(wk) || { period: wk, orders: 0, product_value: 0, total_value: 0, commission_earned: 0, commission_accrued: 0, refunds: 0 };
        for (const k of ['orders', 'product_value', 'total_value', 'commission_earned', 'commission_accrued', 'refunds']) x[k] += p[k];
        weeks.set(wk, x);
      }
      rep = { ...rep, periods: [...weeks.values()] };
    }
    await audit(env, { actor: user, action: 'report.generated', data: { from, to, group } });
    if (url.searchParams.get('format') === 'csv') {
      const csv = toCsv(['Period', 'Paid orders', 'Product value (KES)', 'Total value (KES)', 'Commission earned (KES)', 'Commission accrued (KES)', 'Refunds (KES)'],
        rep.periods.map((p) => [p.period, p.orders, p.product_value / 100, p.total_value / 100, p.commission_earned / 100, p.commission_accrued / 100, p.refunds / 100]));
      return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bonashub-sales-${group}.csv"`, 'Cache-Control': 'no-store' } });
    }
    return json({ group, ...rep });
  });

  // ---- orders and payments ----
  r.get('/api/admin/orders', async ({ env, user, url }) => {
    need(user, 'orders');
    const st = url.searchParams.get('status'), q = url.searchParams.get('q');
    const w = [], a = [];
    if (st) { w.push('so.status = ?'); a.push(st); }
    if (q) { w.push('(so.ref LIKE ? OR s.business_name LIKE ? OR u.full_name LIKE ?)'); const l = `%${q.replace(/[%_]/g, '')}%`; a.push(l, l, l); }
    const rows = (await env.DB.prepare(`SELECT so.id, so.ref, so.status, so.total_minor, so.product_subtotal_minor, so.commission_bps, so.commission_minor, so.settlement_status, so.dispute_open, so.created_at, s.business_name AS seller, u.full_name AS buyer,
      (SELECT status FROM payments p WHERE p.order_id = so.order_id ORDER BY p.created_at DESC LIMIT 1) AS payment_status
      FROM seller_orders so JOIN seller_profiles s ON s.user_id = so.seller_id JOIN orders o ON o.id = so.order_id JOIN users u ON u.id = o.buyer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY so.created_at DESC LIMIT 300`).bind(...a).all()).results;
    return json({ orders: rows.map((o) => ({ id: o.id, ref: o.ref, status: o.status, totalMinor: o.total_minor, productSubtotalMinor: o.product_subtotal_minor, commissionBps: o.commission_bps, commissionMinor: o.commission_minor, settlementStatus: o.settlement_status, disputeOpen: !!o.dispute_open, seller: o.seller, buyer: o.buyer, paymentStatus: o.payment_status, createdAt: o.created_at })) });
  });

  r.get('/api/admin/orders/:id', async ({ env, user, params }) => {
    need(user, 'orders');
    const s = await env.DB.prepare('SELECT seller_id FROM seller_orders WHERE id = ?').bind(params.id).first();
    if (!s) throw notFound('Order');
    const order = await subForSeller(env, s.seller_id, params.id);
    const buyer = await env.DB.prepare('SELECT u.full_name, u.email, u.phone FROM seller_orders so JOIN orders o ON o.id = so.order_id JOIN users u ON u.id = o.buyer_id WHERE so.id = ?').bind(params.id).first();
    const ledger = (await env.DB.prepare('SELECT ts, account, kind, amount_minor, ref FROM ledger_entries WHERE sub_order_ref = ? ORDER BY id').bind(order.ref).all()).results;
    return json({ order, buyer: { name: buyer.full_name, email: buyer.email, phone: buyer.phone }, ledger });
  });

  r.get('/api/admin/payments', async ({ env, user, url }) => {
    need(user, 'payments');
    const st = url.searchParams.get('status');
    const rows = (await env.DB.prepare(`SELECT p.*, o.ref AS order_ref FROM payments p JOIN orders o ON o.id = p.order_id ${st ? 'WHERE p.status = ?' : ''} ORDER BY p.created_at DESC LIMIT 300`).bind(...(st ? [st] : [])).all()).results;
    return json({ payments: rows.map((p) => ({ ref: p.ref, orderRef: p.order_ref, amountMinor: p.amount_minor, method: p.method, provider: p.provider, providerRef: p.provider_ref, status: p.status, failureReason: p.failure_reason, refundedMinor: p.refunded_minor, createdAt: p.created_at, paidAt: p.paid_at })) });
  });

  r.get('/api/admin/refunds', async ({ env, user }) => {
    need(user, 'refunds');
    const rows = (await env.DB.prepare(`SELECT r.*, so.ref AS sub_ref, so.total_minor, so.refunded_minor, s.business_name AS seller FROM refunds r JOIN seller_orders so ON so.id = r.seller_order_id JOIN seller_profiles s ON s.user_id = so.seller_id ORDER BY (r.status = 'requested') DESC, r.created_at DESC LIMIT 200`).all()).results;
    return json({ refunds: rows.map((x) => ({ id: x.id, ref: x.ref, subRef: x.sub_ref, seller: x.seller, amountMinor: x.amount_minor, orderTotalMinor: x.total_minor, status: x.status, reason: x.reason, commissionReversalMinor: x.commission_reversal_minor, createdAt: x.created_at, decidedAt: x.decided_at })) });
  });
  r.post('/api/admin/refunds/:id/decide', async ({ env, request, user, params }) => {
    need(user, 'refunds');
    const b = await readJson(request);
    if (user.staff_role === 'support' && b.approve) throw forbidden('Support staff can decline or escalate refunds; finance or the owner approves payouts.');
    return json(await decideRefund(env, user, params.id, { approve: !!b.approve, amountMinor: b.amountMinor, note: b.note }));
  });
  r.post('/api/admin/disputes/:subId/resolve', async ({ env, request, user, params }) => {
    need(user, 'disputes');
    const b = await readJson(request);
    return json(await resolveDispute(env, user, params.subId, b.resolution));
  });

  // ---- sellers ----
  r.get('/api/admin/sellers', async ({ env, user, url }) => {
    need(user, 'sellers.read');
    const st = url.searchParams.get('status');
    const rows = (await env.DB.prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.seller_id = s.user_id AND p.status = 'active') AS products,
      (SELECT COALESCE(SUM(product_subtotal_minor),0) FROM seller_orders so WHERE so.seller_id = s.user_id AND so.status = 'completed') AS sales FROM seller_profiles s ${st ? 'WHERE s.status = ?' : ''} ORDER BY s.created_at DESC LIMIT 300`).bind(...(st ? [st] : [])).all()).results;
    return json({ sellers: rows.map((s) => ({ id: s.user_id, slug: s.slug, businessName: s.business_name, contactName: s.contact_name, email: s.email, phone: s.phone, town: s.town, region: s.region, status: s.status, statusReason: s.status_reason, founding: !!s.founding, foundingExpiresAt: s.founding_expires_at, commissionOverrideBps: s.commission_override_bps, products: s.products, completedSalesMinor: s.sales, createdAt: s.created_at })) });
  });
  r.get('/api/admin/sellers/:id', async ({ env, user, params }) => {
    need(user, 'sellers.read');
    const s = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(params.id).first();
    if (!s) throw notFound('Seller');
    const docs = (await env.DB.prepare('SELECT * FROM seller_documents WHERE seller_id = ? ORDER BY created_at DESC').bind(params.id).all()).results;
    const hist = (await env.DB.prepare("SELECT ts, action, actor_role, data FROM audit_log WHERE entity_id = ? AND (action LIKE 'seller.%' OR action LIKE 'commission.%') ORDER BY seq DESC LIMIT 30").bind(params.id).all()).results;
    return json({ seller: s, documents: docs, stats: await sellerStats(env, params.id), history: hist });
  });

  r.post('/api/admin/sellers/:id/decision', async ({ env, request, user, params }) => {
    need(user, 'sellers.manage');
    const b = await readJson(request);
    const s = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(params.id).first();
    if (!s) throw notFound('Seller');
    const action = b.action, reason = String(b.reason ?? '').trim();
    const ts = nowIso(env), set = await getSettings(env.DB);
    const email = (await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(params.id).first()).email;
    if (action === 'approve') {
      if (!['pending', 'rejected', 'suspended'].includes(s.status)) throw conflict('invalid_state', 'This seller is already approved.');
      let founding = s.founding;
      if (!s.approved_at) {
        const used = (await env.DB.prepare('SELECT COUNT(*) n FROM seller_profiles WHERE founding = 1').first()).n;
        const want = b.founding === false ? false : b.founding === true ? true : used < set.foundingSlots;
        if (want && used >= set.foundingSlots) throw conflict('founding_full', `All ${set.foundingSlots} Founding Seller places are taken.`);
        founding = want ? 1 : 0;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE seller_profiles SET status = 'approved', status_reason = NULL, status_changed_at = ?, approved_at = COALESCE(approved_at, ?), founding = ?, founding_expires_at = CASE WHEN ? = 1 AND founding_expires_at IS NULL THEN ? ELSE founding_expires_at END WHERE user_id = ?")
          .bind(ts, ts, founding, founding, addMonths(ts, set.foundingMonths), params.id),
        ...notifyStmts(env, { userId: params.id, email, kind: 'seller_approved', title: s.status === 'suspended' ? 'Your seller account is active again' : 'Your seller account is approved', body: founding ? `Welcome, Founding Seller. You pay ${set.foundingBps / 100}% commission for ${set.foundingMonths} months.` : 'You can now list products and receive orders.', link: '#/seller' }),
      ]);
    } else if (action === 'reject' || action === 'suspend') {
      if (!reason) throw bad('Give a reason. The seller will see it.', { reason: 'Required.' });
      const to = action === 'reject' ? 'rejected' : 'suspended';
      await env.DB.batch([
        env.DB.prepare('UPDATE seller_profiles SET status = ?, status_reason = ?, status_changed_at = ? WHERE user_id = ?').bind(to, reason.slice(0, 500), ts, params.id),
        ...notifyStmts(env, { userId: params.id, email, kind: `seller_${to}`, title: action === 'reject' ? 'Your seller application was not approved' : 'Your seller account is suspended', body: reason.slice(0, 300), link: '#/seller' }),
      ]);
    } else throw bad('Unknown action.');
    await audit(env, { actor: user, action: `seller.${action}`, entity: 'seller', entityId: params.id, data: { reason: reason || null, founding: b.founding ?? null } });
    return json({ ok: true });
  });

  r.post('/api/admin/sellers/:id/commission', async ({ env, request, user, params }) => {
    need(user, 'commission.write');
    const b = await readJson(request);
    const s = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(params.id).first();
    if (!s) throw notFound('Seller');
    const clear = b.bps === null;
    if (!clear && (!Number.isInteger(b.bps) || b.bps < 0 || b.bps > 5000)) throw bad('Commission must be between 0% and 50%.', { bps: 'Invalid rate.' });
    if (!clear && !String(b.reason ?? '').trim()) throw bad('Record why this rate was agreed.', { reason: 'Required.' });
    await env.DB.prepare('UPDATE seller_profiles SET commission_override_bps = ?, commission_override_reason = ? WHERE user_id = ?').bind(clear ? null : b.bps, clear ? null : String(b.reason).slice(0, 300), params.id).run();
    await audit(env, { actor: user, action: 'commission.seller_override', entity: 'seller', entityId: params.id, data: { from: s.commission_override_bps, to: clear ? null : b.bps, reason: b.reason ?? null } });
    return json({ ok: true });
  });

  // ---- products and categories ----
  r.get('/api/admin/products', async ({ env, user, url }) => {
    need(user, 'products');
    const st = url.searchParams.get('status');
    const rows = (await env.DB.prepare(`${PRODUCT_SELECT} ${st ? 'WHERE p.status = ?' : "WHERE p.status != 'removed'"} ORDER BY (p.status = 'pending') DESC, p.updated_at DESC LIMIT 300`).bind(...(st ? [st] : [])).all()).results;
    const imgs = await imagesFor(env, rows.map((x) => x.id));
    return json({ products: rows.map((p) => ({ ...shapeProduct(p, imgs.get(p.id) || [], { owner: true }), seller: { id: p.seller_id, name: p.seller_name } })) });
  });
  r.post('/api/admin/products/:id/decision', async ({ env, request, user, params }) => {
    need(user, 'products');
    const b = await readJson(request);
    const p = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
    if (!p) throw notFound('Product');
    const map = { approve: 'active', reject: 'rejected', remove: 'removed' };
    const to = map[b.action];
    if (!to) throw bad('Unknown action.');
    if (to !== 'active' && !String(b.reason ?? '').trim()) throw bad('Give a reason.', { reason: 'Required.' });
    await env.DB.prepare('UPDATE products SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').bind(to, to === 'active' ? null : String(b.reason).slice(0, 300), nowIso(env), params.id).run();
    await notify(env, { userId: p.seller_id, kind: `product_${to}`, title: `Product ${to === 'active' ? 'approved' : to}: ${p.name}`, body: b.reason ?? null, link: '#/seller/products' });
    await audit(env, { actor: user, action: `product.${b.action}`, entity: 'product', entityId: params.id, data: { reason: b.reason ?? null } });
    return json({ status: to });
  });

  r.get('/api/admin/categories', async ({ env, user }) => {
    need(user, 'categories');
    const rows = (await env.DB.prepare('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status != \'removed\') AS products FROM categories c ORDER BY sort_order, name').all()).results;
    return json({ categories: rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name, sortOrder: c.sort_order, active: !!c.active, commissionBps: c.commission_bps, products: c.products })) });
  });
  r.post('/api/admin/categories', async ({ env, request, user }) => {
    need(user, 'categories');
    const b = await readJson(request);
    const f = fields(); const name = f.str(b, 'name', { max: 100, label: 'Name' }); f.done();
    let slug = slugify(name);
    if (await env.DB.prepare('SELECT 1 FROM categories WHERE slug = ?').bind(slug).first()) slug += '-' + uuid().slice(0, 4);
    const max = (await env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM categories').first()).m;
    const id = 'cat_' + uuid().slice(0, 8);
    await env.DB.prepare('INSERT INTO categories (id, slug, name, sort_order) VALUES (?,?,?,?)').bind(id, slug, name, max + 1).run();
    await audit(env, { actor: user, action: 'category.created', entity: 'category', entityId: id, data: { name } });
    return json({ id }, 201);
  });
  r.put('/api/admin/categories/:id', async ({ env, request, user, params }) => {
    need(user, 'categories');
    const b = await readJson(request);
    const c = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(params.id).first();
    if (!c) throw notFound('Category');
    const bps = 'commissionBps' in b ? b.commissionBps : c.commission_bps;
    if (bps != null && (!Number.isInteger(bps) || bps < 0 || bps > 5000)) throw bad('Commission must be between 0% and 50%.');
    if ('commissionBps' in b) need(user, 'commission.write');
    await env.DB.prepare('UPDATE categories SET name = ?, sort_order = ?, active = ?, commission_bps = ? WHERE id = ?')
      .bind(typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 100) : c.name, Number.isInteger(b.sortOrder) ? b.sortOrder : c.sort_order, 'active' in b ? (b.active ? 1 : 0) : c.active, bps, params.id).run();
    await audit(env, { actor: user, action: 'category.updated', entity: 'category', entityId: params.id, data: b });
    return json({ ok: true });
  });

  // ---- settlements ----
  r.get('/api/admin/settlements', async ({ env, user }) => {
    need(user, 'settlements');
    const rows = (await env.DB.prepare('SELECT st.*, s.business_name FROM settlements st JOIN seller_profiles s ON s.user_id = st.seller_id ORDER BY st.created_at DESC LIMIT 200').all()).results;
    return json({ candidates: await settlementCandidates(env), settlements: rows.map((s) => ({ id: s.id, ref: s.ref, seller: s.business_name, sellerId: s.seller_id, amountMinor: s.amount_minor, status: s.status, method: s.method, reference: s.reference, createdAt: s.created_at, processedAt: s.processed_at })) });
  });
  r.post('/api/admin/settlements', async ({ env, request, user }) => { need(user, 'settlements'); const b = await readJson(request); return json(await createSettlement(env, user, b.sellerId, { note: b.note }), 201); });
  r.post('/api/admin/settlements/:id/process', async ({ env, request, user, params }) => { need(user, 'settlements'); const b = await readJson(request); return json(await markSettlementProcessed(env, user, params.id, { method: b.method, reference: b.reference })); });
  r.post('/api/admin/settlements/:id/cancel', async ({ env, user, params }) => { need(user, 'settlements'); return json(await cancelSettlement(env, user, params.id)); });

  // ---- settings, staff, audit, jobs ----
  r.get('/api/admin/settings', async ({ env, user }) => { need(user, 'commission.read'); return json({ settings: await getSettings(env.DB) }); });
  r.put('/api/admin/settings', async ({ env, request, user }) => {
    need(user, 'commission.write');
    const b = await readJson(request);
    const limits = { defaultBps: [0, 5000], foundingBps: [0, 5000], foundingSlots: [0, 1000], foundingMonths: [0, 60], disputeWindowDays: [0, 90], autoCompleteDays: [1, 90], paymentExpiryMinutes: [5, 1440], vatBps: [0, 3000] };
    const before = await getSettings(env.DB), stmts = [];
    for (const [k, v] of Object.entries(b)) {
      if (!limits[k]) continue;
      if (!Number.isInteger(v) || v < limits[k][0] || v > limits[k][1]) throw bad(`${k} must be between ${limits[k][0]} and ${limits[k][1]}.`, { [k]: 'Out of range.' });
      stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(v)));
    }
    if (stmts.length) await env.DB.batch(stmts);
    await audit(env, { actor: user, action: 'settings.changed', data: { before, change: b } });
    return json({ settings: await getSettings(env.DB) });
  });

  r.get('/api/admin/staff', async ({ env, user }) => {
    need(user, 'staff');
    return json({ roles: Object.keys(STAFF_PERMISSIONS), staff: (await env.DB.prepare("SELECT id, email, full_name, staff_role, status, created_at FROM users WHERE role = 'admin' ORDER BY created_at").all()).results });
  });
  r.post('/api/admin/staff', async ({ env, request, user }) => {
    need(user, 'staff');
    const b = await readJson(request);
    const f = fields();
    const email = f.email(b), fullName = f.str(b, 'fullName', { max: 120 }), password = f.password(b), staffRole = f.oneOf(b, 'staffRole', ['finance', 'catalogue', 'support', 'owner']);
    f.done();
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw conflict('email_taken', 'That email is already registered.');
    const id = uuid();
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, role, staff_role, full_name, email_verified_at, created_at) VALUES (?,?,?,'admin',?,?,?,?)").bind(id, email, await hashPassword(password), staffRole, fullName, nowIso(env), nowIso(env)).run();
    await audit(env, { actor: user, action: 'staff.created', entity: 'user', entityId: id, data: { email, staffRole } });
    return json({ id }, 201);
  });
  r.put('/api/admin/staff/:id', async ({ env, request, user, params }) => {
    need(user, 'staff');
    if (params.id === user.id) throw conflict('self', 'You cannot change your own access.');
    const b = await readJson(request);
    const status = b.status === 'suspended' ? 'suspended' : 'active';
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = ? AND role = 'admin'").bind(status, params.id).run();
    if (status === 'suspended') await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(params.id).run();
    await audit(env, { actor: user, action: 'staff.status', entity: 'user', entityId: params.id, data: { status } });
    return json({ ok: true });
  });

  r.get('/api/admin/audit', async ({ env, user, url }) => {
    need(user, 'audit');
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10));
    const rows = (await env.DB.prepare('SELECT seq, ts, actor_id, actor_role, action, entity, entity_id, data FROM audit_log ORDER BY seq DESC LIMIT ?').bind(limit).all()).results;
    return json({ entries: rows });
  });
  r.get('/api/admin/audit/verify', async ({ env, user }) => { need(user, 'audit'); return json(await verifyAuditChain(env)); });
  r.post('/api/admin/jobs/run', async ({ env, user }) => { need(user, 'jobs'); return json(await runJobs(env)); });
}
