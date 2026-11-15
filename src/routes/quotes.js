import { json, readJson, bad, notFound, conflict } from '../lib/http.js';
import { fields } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { nowIso, addDays, guardStmt, clearGuardStmt, isGuardError } from '../lib/db.js';
import { requireRole } from '../lib/permissions.js';
import { createOrder, nextRef } from '../services/orders.js';
import { notify } from '../services/notify.js';
import { audit } from '../services/audit.js';

const shape = (q) => ({
  id: q.id, ref: q.ref, status: q.status, productId: q.product_id, productName: q.product_name, sellerName: q.seller_name, buyerName: q.buyer_name, quantity: q.quantity, unit: q.unit,
  deliveryLocation: q.delivery_location, deliveryMethod: q.delivery_method, neededBy: q.needed_by, notes: q.notes, quotedUnitPriceMinor: q.quoted_unit_price_minor,
  quotedDeliveryMinor: q.quoted_delivery_minor, quotedTotalMinor: q.quoted_unit_price_minor ? q.quoted_unit_price_minor * q.quantity + (q.quoted_delivery_minor ?? 0) : null,
  validUntil: q.valid_until, sellerNotes: q.seller_notes, orderId: q.order_id, createdAt: q.created_at,
});
const SEL = `SELECT q.*, p.name AS product_name, p.unit, s.business_name AS seller_name, u.full_name AS buyer_name FROM quotations q
  JOIN products p ON p.id = q.product_id JOIN seller_profiles s ON s.user_id = q.seller_id JOIN users u ON u.id = q.buyer_id`;

async function mine(env, user, id) {
  const q = await env.DB.prepare(`${SEL} WHERE q.id = ?`).bind(id).first();
  if (!q || (user.role === 'buyer' && q.buyer_id !== user.id) || (user.role === 'seller' && q.seller_id !== user.id)) throw notFound('Quotation');
  return q;
}

export function quoteRoutes(r) {
  r.post('/api/quotes', async ({ env, request, user }) => {
    requireRole(user, 'buyer');
    const b = await readJson(request);
    const f = fields();
    const productId = f.str(b, 'productId', { max: 80 });
    const quantity = f.int(b, 'quantity', { min: 1, max: 1000000, label: 'Quantity' });
    const deliveryMethod = b.deliveryMethod === 'collection' ? 'collection' : 'delivery';
    const deliveryLocation = f.str(b, 'deliveryLocation', { max: 200, optional: true });
    const neededBy = f.str(b, 'neededBy', { max: 30, optional: true });
    const notes = f.str(b, 'notes', { max: 2000, optional: true });
    f.done();
    const p = await env.DB.prepare("SELECT p.*, s.status AS sstatus FROM products p JOIN seller_profiles s ON s.user_id = p.seller_id WHERE p.id = ?").bind(productId).first();
    if (!p || p.status !== 'active' || p.sstatus !== 'approved') throw notFound('Product');
    if (quantity < p.moq) throw bad(`Minimum order is ${p.moq}.`, { quantity: `Minimum ${p.moq}.` });
    const id = uuid(), ts = nowIso(env);
    for (let i = 0; i < 4; i++) {
      const ref = await nextRef(env, 'quote', 'QT');
      try {
        await env.DB.batch([...ref.bump(), env.DB.prepare('INSERT INTO quotations (id, ref, buyer_id, seller_id, product_id, quantity, delivery_location, delivery_method, needed_by, notes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, ref.ref, user.id, p.seller_id, productId, quantity, deliveryLocation, deliveryMethod, neededBy, notes, 'requested', ts, ts), clearGuardStmt(env.DB)]);
        await notify(env, { userId: p.seller_id, kind: 'quote_received', title: `Quotation request ${ref.ref}`, body: `${quantity} × ${p.name}`, link: '#/seller/quotes' });
        await audit(env, { actor: user, action: 'quote.requested', entity: 'quotation', entityId: id, data: { ref: ref.ref } });
        return json({ id, ref: ref.ref }, 201);
      } catch (e) { if (isGuardError(e) || /UNIQUE/i.test(String(e?.message))) continue; throw e; }
    }
    throw conflict('busy', 'Please try again.');
  });

  r.get('/api/quotes', async ({ env, user }) => {
    requireRole(user, 'buyer', 'seller');
    const col = user.role === 'buyer' ? 'q.buyer_id' : 'q.seller_id';
    const rows = (await env.DB.prepare(`${SEL} WHERE ${col} = ? ORDER BY q.created_at DESC LIMIT 200`).bind(user.id).all()).results;
    return json({ quotes: rows.map(shape) });
  });

  r.post('/api/quotes/:id/respond', async ({ env, request, user, params }) => {
    requireRole(user, 'seller');
    const q = await mine(env, user, params.id);
    if (!['requested', 'quoted'].includes(q.status)) throw conflict('closed', 'This quotation is closed.');
    const b = await readJson(request);
    const ts = nowIso(env);
    if (b.action === 'decline') {
      await env.DB.prepare("UPDATE quotations SET status = 'declined', seller_notes = ?, updated_at = ? WHERE id = ? AND status IN ('requested','quoted')").bind(String(b.notes ?? '').slice(0, 1000), ts, q.id).run();
      await notify(env, { userId: q.buyer_id, kind: 'quote_declined', title: `Quotation ${q.ref} declined`, body: String(b.notes ?? '').slice(0, 200), link: '#/account/quotes' });
      return json({ declined: true });
    }
    const f = fields();
    const unit = f.int(b, 'unitPriceMinor', { min: 1, max: 100000000000, label: 'Unit price' });
    const delivery = f.int(b, 'deliveryMinor', { min: 0, max: 100000000000, optional: true, label: 'Delivery charge' }) ?? 0;
    const days = f.int(b, 'validDays', { min: 1, max: 90, optional: true, label: 'Validity' }) ?? 14;
    f.done();
    await env.DB.prepare("UPDATE quotations SET status = 'quoted', quoted_unit_price_minor = ?, quoted_delivery_minor = ?, valid_until = ?, seller_notes = ?, updated_at = ? WHERE id = ? AND status IN ('requested','quoted')")
      .bind(unit, delivery, addDays(ts, days), String(b.notes ?? '').slice(0, 1000), ts, q.id).run();
    await notify(env, { userId: q.buyer_id, email: (await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(q.buyer_id).first()).email, kind: 'quote_received', title: `Quotation ${q.ref} received`, body: `${q.seller_name} replied with a price.`, link: '#/account/quotes' });
    await audit(env, { actor: user, action: 'quote.quoted', entity: 'quotation', entityId: q.id, data: { unitPriceMinor: unit, deliveryMinor: delivery } });
    return json({ quoted: true });
  });

  // Accepting a quotation turns it into an official order at exactly the quoted price. The status flip is atomic, so it converts once.
  r.post('/api/quotes/:id/accept', async ({ env, request, user, params }) => {
    requireRole(user, 'buyer');
    const q = await mine(env, user, params.id);
    const b = await readJson(request);
    const ts = nowIso(env);
    const flip = await env.DB.prepare("UPDATE quotations SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'quoted' AND valid_until > ?").bind(ts, q.id, ts).run();
    if (!flip.meta.changes) throw conflict('not_acceptable', q.status === 'quoted' ? 'This quotation has expired. Ask the seller for a new one.' : 'This quotation can no longer be accepted.');
    try {
      const raw = await env.DB.prepare('SELECT * FROM quotations WHERE id = ?').bind(q.id).first();
      const res = await createOrder(env, user, { items: [{ productId: q.product_id, qty: q.quantity }], address: b.address, method: q.delivery_method, idempotencyKey: b.idempotencyKey || `quote-${q.id}`, quote: raw });
      await env.DB.prepare("UPDATE quotations SET status = 'converted', order_id = ?, updated_at = ? WHERE id = ?").bind(res.orderId, nowIso(env), q.id).run();
      await audit(env, { actor: user, action: 'quote.converted', entity: 'quotation', entityId: q.id, data: { orderId: res.orderId } });
      return json(res, 201);
    } catch (e) {
      await env.DB.prepare("UPDATE quotations SET status = 'quoted', updated_at = ? WHERE id = ? AND status = 'accepted'").bind(nowIso(env), q.id).run();
      throw e;
    }
  });

  r.post('/api/quotes/:id/decline', async ({ env, user, params }) => {
    requireRole(user, 'buyer');
    const q = await mine(env, user, params.id);
    await env.DB.prepare("UPDATE quotations SET status = 'declined', updated_at = ? WHERE id = ? AND status IN ('requested','quoted')").bind(nowIso(env), q.id).run();
    return json({ declined: true });
  });
}
