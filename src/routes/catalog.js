import { json, readJson, bad, notFound, forbidden, conflict } from '../lib/http.js';
import { fields, safeJson, isHttpUrl } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { nowIso } from '../lib/db.js';
import { audit } from '../services/audit.js';
import { notifyAdmins, notify } from '../services/notify.js';
import { shapeProduct, imagesFor, PRODUCT_SELECT } from '../services/views.js';

const SORTS = { newest: 'p.created_at DESC', price_asc: 'p.unit_price_minor ASC', price_desc: 'p.unit_price_minor DESC', name: 'p.name ASC' };
const LIVE = "p.status = 'active' AND s.status = 'approved'";

// Builds the WHERE clause for the product list. `skip` leaves one filter group out, for facet counts.
function buildWhere(q, skip = []) {
  const where = [LIVE], args = [], on = (k) => !skip.includes(k);
  if (q.get('ids')) { const ids = q.get('ids').split(',').slice(0, 4); where.push(`p.id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  if (on('category') && q.get('category')) { where.push('(c.slug = ? OR c.id = ?)'); args.push(q.get('category'), q.get('category')); }
  if (on('seller') && q.get('seller')) { where.push('(s.slug = ? OR s.user_id = ?)'); args.push(q.get('seller'), q.get('seller')); }
  if (q.get('q')) { where.push('(p.name LIKE ? OR p.brand LIKE ? OR p.description LIKE ?)'); const like = `%${q.get('q').replace(/[%_]/g, '')}%`; args.push(like, like, like); }
  if (on('priceModel') && (q.get('priceModel') === 'fixed' || q.get('priceModel') === 'quote')) { where.push('p.price_model = ?'); args.push(q.get('priceModel')); }
  if (on('inStock') && q.get('inStock') === '1') where.push('(p.stock_qty IS NULL OR p.stock_qty > 0)');
  if (on('min') && q.get('min')) { where.push('p.unit_price_minor >= ?'); args.push(Math.max(0, parseInt(q.get('min'), 10) || 0)); }
  if (on('max') && q.get('max')) { where.push('p.unit_price_minor <= ?'); args.push(Math.max(0, parseInt(q.get('max'), 10) || 0)); }
  if (on('founding') && q.get('founding') === '1') where.push('s.founding = 1');
  return { where, args };
}

export function catalogRoutes(r) {
  r.get('/api/categories', { public: true }, async ({ env }) => {
    const rows = (await env.DB.prepare(
      `SELECT c.id, c.slug, c.name, c.sort_order,
        (SELECT COUNT(*) FROM products p JOIN seller_profiles s ON s.user_id = p.seller_id WHERE p.category_id = c.id AND ${LIVE}) AS product_count
       FROM categories c WHERE c.active = 1 ORDER BY c.sort_order, c.name`).all()).results;
    return json({ categories: rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name, productCount: c.product_count })) });
  });

  r.get('/api/products', { public: true }, async ({ env, url }) => {
    const q = url.searchParams;
    const { where, args } = buildWhere(q);
    const limit = Math.min(60, Math.max(1, parseInt(q.get('limit') || '24', 10)));
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10));
    const order = SORTS[q.get('sort')] || SORTS.newest;
    const base = `FROM products p JOIN categories c ON c.id = p.category_id JOIN seller_profiles s ON s.user_id = p.seller_id WHERE ${where.join(' AND ')}`;
    const total = (await env.DB.prepare(`SELECT COUNT(*) n ${base}`).bind(...args).first()).n;
    const rows = (await env.DB.prepare(`${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit, offset).all()).results;
    const imgs = await imagesFor(env, rows.map((x) => x.id));
    return json({ total, products: rows.map((p) => shapeProduct(p, imgs.get(p.id) || [])) });
  });

  // Facet counts for the filter panel. Each group is counted with every OTHER filter applied but not its own,
  // so choosing one category still shows how many products the other categories would give (disjunctive facets).
  r.get('/api/products/facets', { public: true }, async ({ env, url }) => {
    const q = url.searchParams;
    const FROM = 'FROM products p JOIN categories c ON c.id = p.category_id JOIN seller_profiles s ON s.user_id = p.seller_id';
    const run = async (skip, sql) => { const { where, args } = buildWhere(q, skip); return (await env.DB.prepare(sql.replace('{W}', where.join(' AND '))).bind(...args).all()).results; };
    const [cats, sellers, model, avail, found, range] = await Promise.all([
      run(['category'], `SELECT c.slug AS k, c.name AS label, COUNT(*) AS n ${FROM} WHERE {W} GROUP BY c.id ORDER BY c.sort_order`),
      run(['seller'], `SELECT s.slug AS k, s.business_name AS label, COUNT(*) AS n ${FROM} WHERE {W} GROUP BY s.user_id ORDER BY n DESC, label`),
      run(['priceModel'], `SELECT p.price_model AS k, COUNT(*) AS n ${FROM} WHERE {W} GROUP BY p.price_model`),
      run(['inStock'], `SELECT COUNT(*) AS n ${FROM} WHERE {W} AND (p.stock_qty IS NULL OR p.stock_qty > 0)`),
      run(['founding'], `SELECT COUNT(*) AS n ${FROM} WHERE {W} AND s.founding = 1`),
      run(['min', 'max'], `SELECT MIN(p.unit_price_minor) AS lo, MAX(p.unit_price_minor) AS hi ${FROM} WHERE {W} AND p.price_model = 'fixed'`),
    ]);
    return json({
      categories: cats.map((x) => ({ slug: x.k, name: x.label, count: x.n })), sellers: sellers.map((x) => ({ slug: x.k, name: x.label, count: x.n })),
      priceModel: Object.fromEntries(model.map((x) => [x.k, x.n])), inStock: avail[0]?.n || 0, founding: found[0]?.n || 0, priceRange: { minMinor: range[0]?.lo ?? null, maxMinor: range[0]?.hi ?? null },
    });
  });

  r.get('/api/products/:id', { public: true }, async ({ env, params }) => {
    const p = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND ${LIVE}`).bind(params.id).first();
    if (!p) throw notFound('Product');
    const imgs = await imagesFor(env, [p.id]);
    return json({ product: shapeProduct(p, imgs.get(p.id) || []) });
  });

  r.get('/api/sellers', { public: true }, async ({ env }) => {
    const rows = (await env.DB.prepare(
      `SELECT s.slug, s.business_name, s.town, s.region, s.country, s.description, s.founding, s.category_ids, s.approved_at,
        (SELECT COUNT(*) FROM products p WHERE p.seller_id = s.user_id AND p.status = 'active') AS product_count
       FROM seller_profiles s WHERE s.status = 'approved' ORDER BY s.approved_at DESC LIMIT 200`).all()).results;
    return json({ sellers: rows.map((s) => ({ slug: s.slug, name: s.business_name, town: s.town, region: s.region, country: s.country, description: s.description, founding: !!s.founding, productCount: s.product_count })) });
  });

  r.get('/api/sellers/:slug', { public: true }, async ({ env, params }) => {
    const s = await env.DB.prepare("SELECT * FROM seller_profiles WHERE slug = ? AND status = 'approved'").bind(params.slug).first();
    if (!s) throw notFound('Seller');
    return json({ seller: { slug: s.slug, name: s.business_name, town: s.town, region: s.region, country: s.country, description: s.description, founding: !!s.founding, since: s.approved_at } });
  });
}

// ---- Seller-owned product management ----
async function requireApprovedSeller(user) {
  if (user.role !== 'seller') throw forbidden('Seller accounts only.');
  if (user.seller?.status !== 'approved') throw forbidden('Your seller account must be approved before you can list products.');
}

async function parseProduct(env, b, { partial = false } = {}) {
  const f = fields();
  const out = {};
  const need = !partial;
  if (need || 'name' in b) out.name = f.str(b, 'name', { max: 160, label: 'Product name' });
  if (need || 'categoryId' in b) {
    out.categoryId = f.str(b, 'categoryId', { max: 80, label: 'Category' });
    if (out.categoryId && !(await env.DB.prepare('SELECT 1 FROM categories WHERE id = ? AND active = 1').bind(out.categoryId).first())) f.errors.categoryId = 'Choose a valid category.';
  }
  if (need || 'priceModel' in b) out.priceModel = f.oneOf(b, 'priceModel', ['fixed', 'quote'], { label: 'Pricing model' });
  if (out.priceModel === 'fixed' || (partial && 'unitPriceMinor' in b)) out.unitPriceMinor = f.int(b, 'unitPriceMinor', { min: 1, max: 100000000000, label: 'Unit price' });
  if ('brand' in b) out.brand = f.str(b, 'brand', { max: 120, optional: true });
  if ('description' in b) out.description = f.str(b, 'description', { max: 5000, optional: true });
  if ('unit' in b) out.unit = f.str(b, 'unit', { max: 30, label: 'Unit' });
  if ('moq' in b) out.moq = f.int(b, 'moq', { min: 1, max: 1000000, label: 'Minimum order quantity' });
  if ('stockQty' in b) out.stockQty = b.stockQty === null ? null : f.int(b, 'stockQty', { min: 0, max: 100000000, label: 'Stock' });
  if ('originCountry' in b) out.originCountry = f.str(b, 'originCountry', { max: 80, optional: true });
  if ('deliveryOptions' in b) out.deliveryOptions = f.oneOf(b, 'deliveryOptions', ['delivery', 'collection', 'both'], { label: 'Delivery option' });
  if ('specs' in b) {
    if (!Array.isArray(b.specs) || b.specs.length > 40 || b.specs.some((s) => !s || typeof s.label !== 'string' || typeof s.value !== 'string')) f.errors.specs = 'Specifications must be label and value pairs.';
    else out.specs = b.specs.map((s) => ({ label: s.label.slice(0, 80), value: s.value.slice(0, 200) }));
  }
  if ('images' in b) {
    if (!Array.isArray(b.images) || b.images.length > 8 || b.images.some((u) => typeof u !== 'string' || !isHttpUrl(u))) f.errors.images = 'Images must be up to 8 web addresses.';
    else out.images = b.images;
  }
  f.done();
  return out;
}

export function sellerProductRoutes(r) {
  r.get('/api/seller/products', async ({ env, user }) => {
    await requireApprovedSeller(user).catch(() => { if (user.role !== 'seller') throw forbidden('Seller accounts only.'); });
    const rows = (await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.seller_id = ? AND p.status != 'removed' ORDER BY p.updated_at DESC`).bind(user.id).all()).results;
    const imgs = await imagesFor(env, rows.map((x) => x.id));
    return json({ products: rows.map((p) => shapeProduct(p, imgs.get(p.id) || [], { owner: true })) });
  });

  r.post('/api/seller/products', async ({ env, request, user }) => {
    await requireApprovedSeller(user);
    const b = await parseProduct(env, await readJson(request));
    const id = uuid(), ts = nowIso(env);
    const stmts = [env.DB.prepare(
      `INSERT INTO products (id, seller_id, category_id, name, brand, description, specs, unit, moq, stock_qty, price_model, unit_price_minor, currency, origin_country, delivery_options, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'KES',?,?, 'pending', ?, ?)`
    ).bind(id, user.id, b.categoryId, b.name, b.brand ?? null, b.description ?? null, JSON.stringify(b.specs ?? []), b.unit ?? 'unit', b.moq ?? 1, b.stockQty ?? null, b.priceModel,
      b.priceModel === 'fixed' ? b.unitPriceMinor : null, b.originCountry ?? null, b.deliveryOptions ?? 'both', ts, ts)];
    (b.images ?? []).forEach((u, i) => stmts.push(env.DB.prepare('INSERT INTO product_images (id, product_id, url, sort_order) VALUES (?,?,?,?)').bind(uuid(), id, u, i)));
    await env.DB.batch(stmts);
    await audit(env, { actor: user, action: 'product.created', entity: 'product', entityId: id });
    await notifyAdmins(env, { kind: 'product_pending', title: `Product awaiting approval: ${b.name}`, body: user.seller.business_name, link: '#/admin/products' });
    return json({ id, status: 'pending' }, 201);
  });

  r.put('/api/seller/products/:id', async ({ env, request, user, params }) => {
    await requireApprovedSeller(user);
    const cur = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND seller_id = ? AND status != 'removed'").bind(params.id, user.id).first();
    if (!cur) throw notFound('Product');
    const b = await parseProduct(env, await readJson(request), { partial: true });
    const ts = nowIso(env);
    const priceModel = b.priceModel ?? cur.price_model;
    if (priceModel === 'fixed' && !(b.unitPriceMinor ?? cur.unit_price_minor)) throw bad('Fixed-price products need a price.', { unitPriceMinor: 'Required.' });
    // Content that buyers rely on goes back for review; price and stock changes do not.
    const reviewed = ['name', 'categoryId', 'description', 'specs', 'brand', 'images'].some((k) => k in b);
    const status = cur.status === 'active' && reviewed ? 'pending' : cur.status === 'rejected' ? 'pending' : cur.status;
    const stmts = [env.DB.prepare(
      `UPDATE products SET name = ?, category_id = ?, brand = ?, description = ?, specs = ?, unit = ?, moq = ?, stock_qty = ?, price_model = ?, unit_price_minor = ?, origin_country = ?, delivery_options = ?, status = ?, status_reason = ?, updated_at = ? WHERE id = ?`
    ).bind(b.name ?? cur.name, b.categoryId ?? cur.category_id, 'brand' in b ? b.brand : cur.brand, 'description' in b ? b.description : cur.description, 'specs' in b ? JSON.stringify(b.specs) : cur.specs,
      b.unit ?? cur.unit, b.moq ?? cur.moq, 'stockQty' in b ? b.stockQty : cur.stock_qty, priceModel, priceModel === 'fixed' ? (b.unitPriceMinor ?? cur.unit_price_minor) : null,
      'originCountry' in b ? b.originCountry : cur.origin_country, b.deliveryOptions ?? cur.delivery_options, status, status === 'pending' ? null : cur.status_reason, ts, cur.id)];
    if ('images' in b) {
      stmts.push(env.DB.prepare('DELETE FROM product_images WHERE product_id = ?').bind(cur.id));
      b.images.forEach((u, i) => stmts.push(env.DB.prepare('INSERT INTO product_images (id, product_id, url, sort_order) VALUES (?,?,?,?)').bind(uuid(), cur.id, u, i)));
    }
    await env.DB.batch(stmts);
    await audit(env, { actor: user, action: 'product.updated', entity: 'product', entityId: cur.id, data: { fields: Object.keys(b), priceFrom: cur.unit_price_minor, priceTo: b.unitPriceMinor ?? cur.unit_price_minor } });
    if (status === 'pending' && cur.status !== 'pending') await notifyAdmins(env, { kind: 'product_pending', title: `Product re-submitted: ${b.name ?? cur.name}`, link: '#/admin/products' });
    return json({ id: cur.id, status });
  });

  // Products are retired, never deleted, so past orders keep their reference.
  r.delete('/api/seller/products/:id', async ({ env, user, params }) => {
    await requireApprovedSeller(user);
    const res = await env.DB.prepare("UPDATE products SET status = 'removed', updated_at = ? WHERE id = ? AND seller_id = ? AND status != 'removed'").bind(nowIso(env), params.id, user.id).run();
    if (!res.meta.changes) throw notFound('Product');
    await audit(env, { actor: user, action: 'product.removed', entity: 'product', entityId: params.id });
    return json({ removed: true });
  });
}
