import { createD1, migrate } from '../scripts/d1-shim.js';
import { handleApi } from '../src/index.js';
import { hashPassword, uuid } from '../src/lib/crypto.js';

export function makeEnv(extra = {}) {
  const DB = createD1();
  migrate(DB);
  const clock = { t: new Date('2026-11-10T09:00:00Z').getTime() };
  return { DB, DEV_MODE: true, NOW: () => new Date(clock.t), clock, ...extra };
}
export const advance = (env, ms) => { env.clock.t += ms; };
export const DAY = 86400000, MIN = 60000;

/** In-process API client with its own cookie jar. */
export function client(env) {
  let cookie = '';
  async function call(method, path, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await handleApi(new Request('http://localhost' + path, { method, headers: h, body: payload }), env);
    const set = res.headers.get('set-cookie');
    if (set) { const c = set.split(';')[0]; cookie = c.endsWith('=') ? '' : c; }
    const text = await res.text();
    if (raw) return { status: res.status, text, headers: res.headers };
    const j = text ? JSON.parse(text) : {};
    return { status: res.status, ok: j.ok, data: j.data, error: j.error };
  }
  return { call, get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b = {}) => call('PUT', p, b), del: (p) => call('DELETE', p), clear: () => { cookie = ''; } };
}

export async function makeAdmin(env, staffRole = 'owner', email = 'owner@bonashub.test') {
  const id = uuid();
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, role, staff_role, full_name, email_verified_at, created_at) VALUES (?,?,?,'admin',?,?,?,?)")
    .bind(id, email, await hashPassword('Admin-pass-123'), staffRole, 'Test ' + staffRole, new Date(env.clock.t).toISOString(), new Date(env.clock.t).toISOString()).run();
  const c = client(env);
  const r = await c.post('/api/auth/login', { email, password: 'Admin-pass-123' });
  if (r.status !== 200) throw new Error('admin login failed ' + JSON.stringify(r));
  return { c, id };
}

const addr = { name: 'Test Buyer', phone: '0712345678', county: 'Kajiado', town: 'Kimana', address: 'Site office' };
export const address = addr;

export async function registerBuyer(env, email = 'buyer@test.ke') {
  const c = client(env);
  const r = await c.post('/api/auth/register', { role: 'buyer', fullName: 'Test Buyer', email, phone: '0712345678', password: 'Buyer-pass-123', country: 'Kenya', county: 'Kajiado', town: 'Kimana', accountType: 'individual', consent: true });
  if (r.status !== 201) throw new Error('buyer register failed ' + JSON.stringify(r));
  return { c, id: r.data.user.id, devCode: r.data.devVerificationCode };
}

export async function registerSeller(env, email = 'seller@test.ke', name = 'Savanna Agro Supplies') {
  const c = client(env);
  const r = await c.post('/api/auth/register', { role: 'seller', fullName: 'Seller Contact', email, phone: '0722000111', password: 'Seller-pass-123', country: 'Kenya', county: 'Kajiado', town: 'Kajiado', businessName: name, regNo: 'PVT-123', location: 'Kajiado town', description: 'Agro supplier', categoryIds: ['cat_agri_machinery'], consent: true });
  if (r.status !== 201) throw new Error('seller register failed ' + JSON.stringify(r));
  return { c, id: r.data.user.id };
}

/** An approved seller with one active fixed-price product. */
export async function approvedSellerWithProduct(env, admin, { email, name, price = 10000000, stock = 10, moq = 1, categoryId = 'cat_agri_machinery', founding } = {}) {
  const s = await registerSeller(env, email, name);
  const dec = await admin.c.post(`/api/admin/sellers/${s.id}/decision`, { action: 'approve', founding });
  if (dec.status !== 200) throw new Error('approve failed ' + JSON.stringify(dec));
  const p = await s.c.post('/api/seller/products', { name: 'Walk-behind power tiller', categoryId, priceModel: 'fixed', unitPriceMinor: price, unit: 'unit', moq, stockQty: stock, deliveryOptions: 'both' });
  if (p.status !== 201) throw new Error('product create failed ' + JSON.stringify(p));
  const a = await admin.c.post(`/api/admin/products/${p.data.id}/decision`, { action: 'approve' });
  if (a.status !== 200) throw new Error('product approve failed ' + JSON.stringify(a));
  return { ...s, productId: p.data.id };
}

export async function placeAndPay(env, buyer, items, { method = 'delivery', outcome = 'approve', key = uuid() } = {}) {
  const o = await buyer.c.post('/api/checkout', { items, address: addr, method, idempotencyKey: key });
  if (o.status !== 201) throw new Error('checkout failed ' + JSON.stringify(o));
  const pay = await buyer.c.post(`/api/orders/${o.data.orderId}/pay`, { method: 'mpesa', phone: '0712345678' });
  if (pay.status !== 200) throw new Error('pay failed ' + JSON.stringify(pay));
  const sim = await buyer.c.post(`/api/sandbox/pay/${pay.data.payment.ref}`, { outcome });
  return { order: o.data, payRef: pay.data.payment.ref, sim };
}
