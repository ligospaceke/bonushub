import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, advance, DAY, MIN, client, makeAdmin, registerBuyer, registerSeller, approvedSellerWithProduct, placeAndPay, address } from './helpers.js';
import { ledgerBalances } from '../src/services/ledger.js';
import { verifyAuditChain } from '../src/services/audit.js';
import { hmacHex } from '../src/lib/crypto.js';
import { runJobs } from '../src/services/jobs.js';

async function world() {
  const env = makeEnv();
  const admin = await makeAdmin(env);
  const a = await approvedSellerWithProduct(env, admin, { email: 'a@seller.ke', name: 'Seller A', price: 10000000, stock: 10 });
  const b = await approvedSellerWithProduct(env, admin, { email: 'b@seller.ke', name: 'Seller B', price: 5000000, stock: 5, categoryId: 'cat_building_materials' });
  const buyer = await registerBuyer(env);
  return { env, admin, a, b, buyer };
}
const sub = async (env, ref) => env.DB.prepare('SELECT * FROM seller_orders WHERE ref = ?').bind(ref).first();

test('full journey: two sellers, one payment, fulfilment, commission earned, settlement, books balanced', async () => {
  const { env, admin, a, b, buyer } = await world();
  const { order, payRef, sim } = await placeAndPay(env, buyer, [{ productId: a.productId, qty: 1 }, { productId: b.productId, qty: 2 }]);
  assert.match(order.ref, /^BH-2026-\d{6}$/);
  assert.equal(order.subOrders.length, 2);
  assert.equal(order.totalMinor, 10000000 + 10000000);
  assert.equal(sim.data.status, 'successful');

  // Each sub-order carries its own commission fixed at creation. Founding sellers (first approved) pay 3%.
  const sa = await sub(env, order.subOrders[0].ref), sb = await sub(env, order.subOrders[1].ref);
  assert.equal(sa.status, 'payment_confirmed');
  assert.equal(sa.commission_bps, 300);
  assert.equal(sa.commission_minor, 300000);
  assert.equal(sa.commission_rule, 'founding');
  assert.equal(sb.commission_minor, 300000);

  // Seller can now see the buyer; progress through fulfilment
  const detail = await a.c.get(`/api/seller/orders/${sa.id}`);
  assert.equal(detail.data.order.buyer.name, 'Test Buyer');
  assert.equal((await a.c.post(`/api/seller-orders/${sa.id}/transition`, { to: 'seller_processing' })).status, 200);
  assert.equal((await a.c.post(`/api/seller-orders/${sa.id}/transition`, { to: 'ready_for_dispatch' })).status, 200);
  assert.equal((await a.c.post(`/api/seller-orders/${sa.id}/transition`, { to: 'dispatched', trackingRef: 'TRK-1', carrier: 'Own truck' })).status, 200);
  assert.equal((await a.c.post(`/api/seller-orders/${sa.id}/transition`, { to: 'delivered', proofNote: 'Signed by site clerk' })).status, 200);

  // Commission is accrued, not earned, until the sale completes
  assert.equal((await sub(env, sa.ref)).commission_status, 'accrued');
  const done = await buyer.c.post(`/api/seller-orders/${sa.id}/transition`, { to: 'completed' });
  assert.equal(done.status, 200);
  const after = await sub(env, sa.ref);
  assert.equal(after.status, 'completed');
  assert.equal(after.commission_status, 'earned');

  // Not settleable until the dispute window passes
  assert.equal((await admin.c.post('/api/admin/settlements', { sellerId: a.id })).status, 409);
  advance(env, 8 * DAY);
  const st = await admin.c.post('/api/admin/settlements', { sellerId: a.id });
  assert.equal(st.status, 201);
  assert.equal(st.data.amountMinor, 10000000 - 300000);       // seller proceeds on product value, no delivery charged
  assert.equal((await admin.c.post(`/api/admin/settlements/${st.data.id}/process`, { method: 'bank', reference: '' })).status, 422);
  assert.equal((await admin.c.post(`/api/admin/settlements/${st.data.id}/process`, { method: 'bank', reference: 'EFT-889' })).status, 200);
  assert.equal((await sub(env, sa.ref)).settlement_status, 'settled');
  assert.equal((await admin.c.post(`/api/admin/settlements/${st.data.id}/process`, { method: 'bank', reference: 'EFT-889' })).status, 409); // cannot pay out twice

  const bal = await ledgerBalances(env);
  assert.ok(bal.balanced, JSON.stringify(bal));
  assert.equal(bal.commission_earned, 300000);
  assert.equal(bal.commission_accrued, 300000);   // Seller B's order is still in flight

  const dash = await a.c.get('/api/seller/dashboard');
  assert.equal(dash.data.earnings.grossSalesMinor, 10000000);
  assert.equal(dash.data.earnings.commissionMinor, 300000);
  assert.equal(dash.data.earnings.completedSettlementsMinor, 9700000);
  assert.deepEqual(await verifyAuditChain(env), { ok: true, checked: (await env.DB.prepare('SELECT COUNT(*) n FROM audit_log').first()).n });
});

test('an order is never marked paid because someone says so: forged webhook, replay, and unpaid sandbox', async () => {
  const { env, a, buyer } = await world();
  const o = await buyer.c.post('/api/checkout', { items: [{ productId: a.productId, qty: 1 }], address, idempotencyKey: 'k1' });
  const pay = await buyer.c.post(`/api/orders/${o.data.orderId}/pay`, { method: 'mpesa', phone: '0712345678' });
  const ref = pay.data.payment.ref;

  // Forged callback without a valid signature
  const forged = JSON.stringify({ id: 'evt-1', type: 'payment.success', paymentRef: ref });
  const bad = await client(env).call('POST', '/api/payments/webhook/sandbox', forged, { headers: { 'x-bh-signature': 'deadbeef' } });
  assert.equal(bad.status, 401);

  // A correctly signed callback for a payment the provider never completed does not mark it paid
  const sig = await hmacHex('dev-webhook-secret', forged);
  const signedButUnpaid = await client(env).call('POST', '/api/payments/webhook/sandbox', forged, { headers: { 'x-bh-signature': sig } });
  assert.equal(signedButUnpaid.status, 200);
  assert.equal((await env.DB.prepare('SELECT status FROM payments WHERE ref = ?').bind(ref).first()).status, 'pending');
  assert.equal((await env.DB.prepare("SELECT status FROM seller_orders WHERE order_id = ?").bind(o.data.orderId).first()).status, 'awaiting_payment');

  // Real approval, then the same callback delivered twice must not double-count
  await buyer.c.post(`/api/sandbox/pay/${ref}`, { outcome: 'approve' });
  const body = JSON.stringify({ id: 'evt-dup', type: 'payment.success', paymentRef: ref });
  const h = { 'x-bh-signature': await hmacHex('dev-webhook-secret', body) };
  await client(env).call('POST', '/api/payments/webhook/sandbox', body, { headers: h });
  await client(env).call('POST', '/api/payments/webhook/sandbox', body, { headers: h });
  const entries = (await env.DB.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE kind = 'payment' AND account = 'gateway_clearing'").first()).n;
  assert.equal(entries, 1);
  assert.ok((await ledgerBalances(env)).balanced);
});

test('declined payment leaves the order unpaid and cancels with stock returned after the window', async () => {
  const { env, a, buyer } = await world();
  const { order, sim } = await placeAndPay(env, buyer, [{ productId: a.productId, qty: 4 }], { outcome: 'decline' });
  assert.equal(sim.data.status, 'failed');
  assert.equal((await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(a.productId).first()).stock_qty, 6);
  advance(env, 31 * MIN);
  const out = await runJobs(env);
  assert.equal(out.cancelledOrders, 1);
  assert.equal((await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(a.productId).first()).stock_qty, 10);
  assert.equal((await sub(env, order.subOrders[0].ref)).status, 'cancelled');
});

test('stock cannot be oversold and checkout is idempotent', async () => {
  const { env, b, buyer } = await world();
  const b2 = await registerBuyer(env, 'two@test.ke');
  const items = [{ productId: b.productId, qty: 3 }];
  const [r1, r2] = await Promise.all([
    buyer.c.post('/api/checkout', { items, address, idempotencyKey: 'x1' }),
    b2.c.post('/api/checkout', { items, address, idempotencyKey: 'x2' }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  assert.equal((await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(b.productId).first()).stock_qty, 2);
  const again = await buyer.c.post('/api/checkout', { items, address, idempotencyKey: 'x1' });
  assert.ok(again.data.duplicate || again.status === 409);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM orders').first()).n, 1);
});

test('people cannot see or touch each other: buyers, sellers, and unapproved sellers', async () => {
  const { env, admin, a, b, buyer } = await world();
  const { order } = await placeAndPay(env, buyer, [{ productId: a.productId, qty: 1 }]);
  const sa = await sub(env, order.subOrders[0].ref);
  const other = await registerBuyer(env, 'other@test.ke');
  assert.equal((await other.c.get(`/api/me/orders/${order.orderId}`)).status, 404);
  assert.equal((await b.c.get(`/api/seller/orders/${sa.id}`)).status, 404);
  assert.equal((await b.c.post(`/api/seller-orders/${sa.id}/transition`, { to: 'seller_processing' })).status, 404);
  assert.equal((await other.c.post(`/api/seller-orders/${sa.id}/transition`, { to: 'completed' })).status, 404);
  assert.equal((await buyer.c.get('/api/admin/overview')).status, 403);
  assert.equal((await a.c.get('/api/admin/orders')).status, 403);
  assert.equal((await client(env).get('/api/me/orders')).status, 401);
  // Sellers never see commission info of other sellers; buyers never see commission at all
  const view = await buyer.c.get(`/api/me/orders/${order.orderId}`);
  assert.ok(!JSON.stringify(view.data).includes('commission'));
  // Pending seller cannot list
  const pending = await registerSeller(env, 'p@seller.ke', 'Pending Co');
  const res = await pending.c.post('/api/seller/products', { name: 'x', categoryId: 'cat_other', priceModel: 'fixed', unitPriceMinor: 100 });
  assert.equal(res.status, 403);
  // Their product stays out of the public catalogue until approved
  const list = await client(env).get('/api/products');
  assert.ok(list.data.products.every((p) => p.seller.name !== 'Pending Co'));
});

test('buyer cannot tamper with prices: price, commission and totals come only from the server', async () => {
  const { env, a, buyer } = await world();
  const o = await buyer.c.post('/api/checkout', { items: [{ productId: a.productId, qty: 1, unitPriceMinor: 1, priceMinor: 1 }], address, idempotencyKey: 'tamper', totalMinor: 1, commissionBps: 0 });
  assert.equal(o.status, 201);
  assert.equal(o.data.totalMinor, 10000000);
  assert.equal((await buyer.c.post('/api/checkout', { items: [{ productId: a.productId, qty: -3 }], address, idempotencyKey: 't2' })).status, 422);
  assert.equal((await buyer.c.post('/api/checkout', { items: [{ productId: a.productId, qty: 1.5 }], address, idempotencyKey: 't3' })).status, 422);
});

test('quotation to order: price is locked, conversion happens once, expiry is enforced', async () => {
  const { env, admin, a, buyer } = await world();
  const q = await a.c.post('/api/seller/products', { name: 'Tracked excavator', categoryId: 'cat_construction_machinery', priceModel: 'quote', moq: 1, stockQty: 3, deliveryOptions: 'both' });
  await admin.c.post(`/api/admin/products/${q.data.id}/decision`, { action: 'approve' });
  // Quote products cannot be bought through the cart
  assert.equal((await buyer.c.post('/api/checkout', { items: [{ productId: q.data.id, qty: 1 }], address, idempotencyKey: 'q0' })).status, 409);
  const req = await buyer.c.post('/api/quotes', { productId: q.data.id, quantity: 2, deliveryMethod: 'delivery', deliveryLocation: 'Kimana' });
  assert.equal(req.status, 201);
  assert.equal((await buyer.c.post(`/api/quotes/${req.data.id}/accept`, { address, idempotencyKey: 'a0' })).status, 409); // nothing quoted yet
  assert.equal((await a.c.post(`/api/quotes/${req.data.id}/respond`, { unitPriceMinor: 250000000, deliveryMinor: 1500000, validDays: 7 })).status, 200);
  const acc = await buyer.c.post(`/api/quotes/${req.data.id}/accept`, { address, idempotencyKey: 'a1' });
  assert.equal(acc.status, 201);
  assert.equal(acc.data.totalMinor, 2 * 250000000 + 1500000);
  const second = await buyer.c.post(`/api/quotes/${req.data.id}/accept`, { address, idempotencyKey: 'a2' });
  assert.equal(second.status, 409);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM orders').first()).n, 1);
  // Expiry
  const req2 = await buyer.c.post('/api/quotes', { productId: q.data.id, quantity: 1 });
  await a.c.post(`/api/quotes/${req2.data.id}/respond`, { unitPriceMinor: 240000000, validDays: 1 });
  advance(env, 2 * DAY);
  assert.equal((await buyer.c.post(`/api/quotes/${req2.data.id}/accept`, { address, idempotencyKey: 'a3' })).status, 409);
});

test('refunds reverse commission proportionally and the ledger still balances; settled refunds alert the admin', async () => {
  const { env, admin, a, buyer } = await world();
  const { order } = await placeAndPay(env, buyer, [{ productId: a.productId, qty: 1 }]);
  const s = await sub(env, order.subOrders[0].ref);
  for (const to of ['seller_processing', 'ready_for_dispatch', 'dispatched', 'delivered']) await a.c.post(`/api/seller-orders/${s.id}/transition`, { to });
  const rr = await buyer.c.post(`/api/seller-orders/${s.id}/refund-request`, { amountMinor: 2500000, reason: 'Part of the order arrived damaged' });
  assert.equal(rr.status, 201);
  assert.equal((await sub(env, s.ref)).status, 'refund_requested');
  const list = await admin.c.get('/api/admin/refunds');
  const rf = list.data.refunds[0];
  const done = await admin.c.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(done.status, 200);
  assert.equal(done.data.commissionReversalMinor, 75000);   // 3% of the 25% product share
  const after = await sub(env, s.ref);
  assert.equal(after.status, 'delivered');                  // partial refund restores the prior status
  assert.equal(after.refunded_minor, 2500000);
  assert.equal(after.commission_reversed_minor, 75000);
  assert.ok((await ledgerBalances(env)).balanced);
  assert.equal((await admin.c.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).status, 409);   // not twice
  // Full remainder refunded turns the commission fully reversed and the order refunded
  const rr2 = await buyer.c.post(`/api/seller-orders/${s.id}/refund-request`, { reason: 'Returning everything else now' });
  const rf2 = (await admin.c.get('/api/admin/refunds')).data.refunds.find((x) => x.status === 'requested');
  assert.equal((await admin.c.post(`/api/admin/refunds/${rf2.id}/decide`, { approve: true })).status, 200);
  const fin = await sub(env, s.ref);
  assert.equal(fin.status, 'refunded');
  assert.equal(fin.commission_reversed_minor, fin.commission_minor);
  assert.equal(fin.commission_status, 'reversed');
  const bal = await ledgerBalances(env);
  assert.ok(bal.balanced && bal.gateway_clearing === 0 && bal.commission_accrued === 0, JSON.stringify(bal));
  const pay = await env.DB.prepare('SELECT status, refunded_minor, amount_minor FROM payments').first();
  assert.equal(pay.status, 'refunded');
});

test('seller rejecting a paid order refunds the buyer automatically and returns stock', async () => {
  const { env, a, buyer } = await world();
  const { order } = await placeAndPay(env, buyer, [{ productId: a.productId, qty: 2 }]);
  const s = await sub(env, order.subOrders[0].ref);
  assert.equal((await a.c.post(`/api/seller-orders/${s.id}/transition`, { to: 'cancelled' })).status, 422);       // reason required
  assert.equal((await a.c.post(`/api/seller-orders/${s.id}/transition`, { to: 'cancelled', note: 'Out of stock at warehouse' })).status, 200);
  const x = await sub(env, s.ref);
  assert.equal(x.status, 'cancelled');
  assert.equal(x.refunded_minor, x.total_minor);
  assert.equal((await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(a.productId).first()).stock_qty, 10);
  const bal = await ledgerBalances(env);
  assert.ok(bal.balanced && bal.gateway_clearing === 0, JSON.stringify(bal));
});

test('financial history cannot be edited or deleted, and tampering with the audit chain is detected', async () => {
  const { env, buyer, a } = await world();
  await placeAndPay(env, buyer, [{ productId: a.productId, qty: 1 }]);
  const tryRun = async (sql) => { try { await env.DB.prepare(sql).run(); return 'allowed'; } catch (e) { return String(e.message); } };
  assert.match(await tryRun('UPDATE ledger_entries SET amount_minor = 1'), /append-only/);
  assert.match(await tryRun('DELETE FROM ledger_entries'), /append-only/);
  assert.match(await tryRun('DELETE FROM order_status_history'), /append-only/);
  assert.match(await tryRun('DELETE FROM payment_events'), /append-only/);
  assert.match(await tryRun('DELETE FROM payments'), /cannot be deleted/);
  assert.match(await tryRun('DELETE FROM orders'), /cannot be deleted/);
  assert.match(await tryRun('DELETE FROM audit_log'), /append-only/);
  // An attacker who bypasses triggers (drops them) is still caught by the hash chain
  env.DB._raw.exec('DROP TRIGGER audit_no_update');
  await env.DB.prepare("UPDATE audit_log SET action = 'forged' WHERE seq = 2").run();
  const v = await verifyAuditChain(env);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAtSeq, 2);
});

test('commission settings: founding places are limited, overrides need a reason, changes apply to new orders only', async () => {
  const env = makeEnv();
  const admin = await makeAdmin(env);
  await admin.c.put('/api/admin/settings', { foundingSlots: 1 });
  const s1 = await approvedSellerWithProduct(env, admin, { email: 's1@x.ke', name: 'First' });
  const s2 = await registerSeller(env, 's2@x.ke', 'Second');
  assert.equal((await admin.c.post(`/api/admin/sellers/${s2.id}/decision`, { action: 'approve', founding: true })).status, 409);
  assert.equal((await admin.c.post(`/api/admin/sellers/${s2.id}/decision`, { action: 'approve' })).status, 200);
  assert.equal((await env.DB.prepare('SELECT founding FROM seller_profiles WHERE user_id = ?').bind(s2.id).first()).founding, 0);
  assert.equal((await admin.c.post(`/api/admin/sellers/${s1.id}/commission`, { bps: 200 })).status, 422);
  assert.equal((await admin.c.post(`/api/admin/sellers/${s1.id}/commission`, { bps: 200, reason: 'Heavy machinery agreement signed 2026-11-08' })).status, 200);
  const buyer = await registerBuyer(env);
  const { order } = await placeAndPay(env, buyer, [{ productId: s1.productId, qty: 1 }]);
  const row = await sub(env, order.subOrders[0].ref);
  assert.equal(row.commission_bps, 200);
  assert.equal(row.commission_rule, 'seller_override');
  await admin.c.put('/api/admin/settings', { defaultBps: 900 });
  assert.equal((await sub(env, row.ref)).commission_bps, 200);   // history unchanged
  // Finance staff can read but not change commission
  const fin = await makeAdmin(env, 'finance', 'fin@bonashub.test');
  assert.equal((await fin.c.get('/api/admin/settings')).status, 200);
  assert.equal((await fin.c.put('/api/admin/settings', { defaultBps: 100 })).status, 403);
  assert.equal((await fin.c.get('/api/admin/staff')).status, 403);
});

test('registration validation, consent, duplicate emails, login limits', async () => {
  const env = makeEnv();
  const c = client(env);
  const weak = await c.post('/api/auth/register', { role: 'buyer', fullName: 'A', email: 'nope', phone: '1', password: 'short', consent: false });
  assert.equal(weak.status, 422);
  assert.ok(weak.error.fields.email && weak.error.fields.password && weak.error.fields.consent);
  const ok = await registerBuyer(env, 'dup@test.ke');
  assert.equal((await client(env).post('/api/auth/register', { role: 'buyer', fullName: 'B', email: 'DUP@test.ke', phone: '0712345678', password: 'Another-pass-1', country: 'Kenya', county: 'x', town: 'y', accountType: 'individual', consent: true })).status, 409);
  // Email verification flow
  assert.equal((await ok.c.post('/api/auth/verify', { channel: 'email', code: '000000' })).status, 400);
  assert.equal((await ok.c.post('/api/auth/verify', { channel: 'email', code: ok.devCode })).status, 200);
  assert.equal((await ok.c.get('/api/auth/me')).data.user.emailVerified, true);
  // Brute force protection with a uniform message
  const attacker = client(env);
  let last;
  for (let i = 0; i < 10; i++) last = await attacker.post('/api/auth/login', { email: 'dup@test.ke', password: 'wrong-guess-' + i });
  assert.equal(last.status, 429);
  const unknown = await client(env).post('/api/auth/login', { email: 'ghost@test.ke', password: 'whatever12345' });
  assert.equal(unknown.error.message, 'Email or password is not correct.');
});

test('buyers cannot spoof cross-site requests; reports export for the admin', async () => {
  const { env, admin, a, buyer } = await world();
  await placeAndPay(env, buyer, [{ productId: a.productId, qty: 1 }]);
  const evil = await client(env).call('POST', '/api/auth/logout', {}, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const csv = await admin.c.call('GET', '/api/admin/reports/sales?group=month', undefined, { raw: true });
  assert.equal(csv.status, 200);
  const dl = await admin.c.call('GET', '/api/admin/reports/sales?group=month&format=csv', undefined, { raw: true });
  assert.match(dl.headers.get('content-type'), /text\/csv/);
  assert.match(dl.text, /^Period,Paid orders/);
  const ov = await admin.c.get('/api/admin/overview');
  assert.equal(ov.data.totals.sellersApproved, 2);
  assert.equal(ov.data.totals.transactionValueMinor, 10000000);
  assert.equal(ov.data.ledger.balanced, true);
});

test('the stock race: stock taken by someone else between the check and the write aborts the order cleanly', async () => {
  const { env, b, buyer } = await world();
  // Simulate a competing buyer taking stock after our validation but before our write.
  const realBatch = env.DB.batch.bind(env.DB);
  let raced = false;
  env.DB.batch = async (stmts) => {
    if (!raced) { raced = true; await env.DB.prepare('UPDATE products SET stock_qty = 1 WHERE id = ?').bind(b.productId).run(); }
    return realBatch(stmts);
  };
  const r = await buyer.c.post('/api/checkout', { items: [{ productId: b.productId, qty: 3 }], address, idempotencyKey: 'race1' });
  env.DB.batch = realBatch;
  assert.equal(r.status, 409);
  assert.equal(r.error.code, 'insufficient_stock');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM orders').first()).n, 0);          // nothing half-written
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM seller_orders').first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(b.productId).first()).stock_qty, 1);
});
