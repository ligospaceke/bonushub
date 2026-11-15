import { esc, money, badge, get, post, put, del, route, actions, forms, go, store, toast, field, selectField, textField, kv, emptyState, table, fdate, fdt, kes, fromMinor, setUser } from '../lib.js';
import { dash, kpi, timeline, history, actionButtons } from './dash.js';

const S = { roles: ['seller'] };
const nav = (n = {}) => [['/seller', 'Dashboard'], ['/seller/products', 'Products'], ['/seller/orders', 'Orders', n.orders || ''], ['/seller/quotes', 'Quotations', n.quotes || ''], ['/seller/settlements', 'Earnings'], ['/seller/profile', 'Business profile'], ['/notifications', 'Notifications']];
function banner() {
  const s = store.user.seller || {};
  if (s.status === 'approved') return s.founding ? `<div class="note">Founding Seller: reduced commission until ${fdate(s.foundingExpiresAt)}.</div>` : '';
  const msg = { pending: 'Your application is under review. You can edit your profile and upload documents now; you can list products once approved.', rejected: 'Your application was not approved.', suspended: 'Your seller account is suspended.' }[s.status] || '';
  return `<div class="note warn"><b>${esc((s.status || '').replace(/^./, (c) => c.toUpperCase()))}.</b> ${msg} ${s.statusReason ? `Reason: ${esc(s.statusReason)}` : ''}</div>`;
}
const page = (active, body, n) => `<div class="wrap page" style="padding-bottom:0"><h1>Seller hub</h1><p class="muted">${esc(store.user.seller?.businessName || '')}</p></div>${dash(nav(n), active, banner() + body)}`;
const approved = () => store.user.seller?.status === 'approved';

route('/seller', async () => {
  const d = await get('/api/seller/dashboard');
  const max = Math.max(1, ...d.monthly.map((m) => m.salesMinor));
  return { title: 'Seller dashboard', html: page('/seller', `
    <div class="kpis stagger">${kpi('Total sales', money(d.sales.totalSalesMinor), `${d.sales.paidOrders} paid orders`)}${kpi('Pending orders', d.sales.pendingOrders)}${kpi('Completed', d.sales.completedOrders)}${kpi('Products listed', d.sales.productsListed, `${d.sales.lowStock} low · ${d.sales.outOfStock} out of stock`)}</div>
    <div class="kpis stagger">${kpi('Gross sales (completed)', money(d.earnings.grossSalesMinor))}${kpi('Commission', money(d.earnings.commissionMinor))}${kpi('Net earnings', money(d.earnings.netEarningsMinor))}${kpi('Awaiting settlement', money(d.earnings.pendingSettlementsMinor))}${kpi('Settled to you', money(d.earnings.completedSettlementsMinor))}${kpi('Refunds', money(d.earnings.refundsMinor))}</div>
    <div class="card"><h3>Monthly sales</h3>${d.monthly.length ? `<div class="bars mt" role="img" aria-label="Monthly sales bar chart">${d.monthly.map((m) => `<div class="b"><span>${money(m.salesMinor)}</span><i style="height:${Math.max(4, Math.round((m.salesMinor / max) * 140))}px"></i></div>`).join('')}</div><div class="bar-labels">${d.monthly.map((m) => `<span>${esc(m.month)}</span>`).join('')}</div>` : '<p class="muted mt">Sales will chart here after your first paid order.</p>'}</div>`, { orders: d.sales.pendingOrders || '' }) };
}, S);

// ---------- products ----------
route('/seller/products', async () => {
  const { products } = await get('/api/seller/products');
  return { title: 'My products', html: page('/seller/products', `<div class="card"><div class="row between"><h2>Products</h2>${approved() ? '<a class="btn btn-primary" href="#/seller/products/new">Add product</a>' : ''}</div>
    <div class="mt">${table([
      { h: 'Product', f: (p) => `<a href="#/seller/products/${p.id}"><b>${esc(p.name)}</b></a><div class="tiny muted">${esc(p.category.name)}</div>` },
      { h: 'Price', num: true, f: (p) => (p.priceModel === 'quote' ? 'Quotation' : money(p.unitPriceMinor)) },
      { h: 'Stock', num: true, f: (p) => (p.stockQty == null ? '—' : p.stockQty) }, { h: 'Status', f: (p) => badge(p.status) + (p.statusReason ? `<div class="tiny muted">${esc(p.statusReason)}</div>` : '') },
      { h: '', f: (p) => `<button class="btn btn-sm btn-outline" data-act="remove-product" data-id="${esc(p.id)}">Remove</button>` },
    ], products, { empty: approved() ? 'No products yet. Add your first one.' : 'You can list products once your account is approved.' })}</div></div>`) };
}, S);
actions['remove-product'] = async (el) => { if (!confirm('Remove this product from the marketplace? Existing orders keep their record.')) return; await del('/api/seller/products/' + el.dataset.id); toast('Product removed.'); go('/seller/products'); };

const UNITS = ['unit', 'piece', 'bag', 'kg', 'tonne', 'litre', 'metre', 'box', 'set', 'pair'].map((u) => [u, u]);
async function productForm(p) {
  const cats = (await get('/api/categories')).categories;
  const specs = (p?.specs || []).map((s) => `${s.label}: ${s.value}`).join('\n');
  return `<div class="card"><h2>${p ? 'Edit product' : 'Add a product'}</h2>
  ${p && p.status === 'active' ? '<p class="note mt small">Changing the name, category, description, photos or specifications sends the product back for review. Price and stock changes apply immediately.</p>' : '<p class="note mt small">New products are reviewed before they appear in the marketplace.</p>'}
  <form data-form="product" class="stack mt2" novalidate><input type="hidden" name="id" value="${esc(p?.id || '')}">
    ${field('Product name', 'name', { req: true, value: p?.name || '' })}
    <div class="grid2">${selectField('Category', 'categoryId', [['', 'Choose…'], ...cats.map((c) => [c.id, c.name])], p?.category.id || '')}${field('Brand', 'brand', { value: p?.brand || '' })}</div>
    <div class="grid2">${selectField('Pricing', 'priceModel', [['fixed', 'Fixed price (buyers can add to cart)'], ['quote', 'Quotation only']], p?.priceModel || 'fixed')}${field('Unit price (KSh)', 'price', { type: 'number', value: p?.unitPriceMinor ? fromMinor(p.unitPriceMinor) : '', attrs: 'min="1" step="0.01"', hint: 'Leave blank for quotation products.' })}</div>
    <div class="grid2">${selectField('Sold per', 'unit', UNITS, p?.unit || 'unit')}${field('Minimum order quantity', 'moq', { type: 'number', req: true, value: p?.moq || 1, attrs: 'min="1"' })}</div>
    <div class="grid2">${field('Stock quantity', 'stockQty', { type: 'number', value: p?.stockQty ?? '', attrs: 'min="0"', hint: 'Leave blank if made to order.' })}${selectField('Fulfilment', 'deliveryOptions', [['both', 'Delivery and collection'], ['delivery', 'Delivery only'], ['collection', 'Collection only']], p?.deliveryOptions || 'both')}</div>
    ${field('Country of origin', 'originCountry', { value: p?.originCountry || '' })}
    ${textField('Description', 'description', { rows: 5, value: p?.description || '' })}
    ${textField('Specifications', 'specs', { rows: 5, value: specs, ph: 'One per line, like  Engine power: 45 kW' })}
    ${textField('Photo web addresses', 'images', { rows: 3, value: (p?.images || []).join('\n'), ph: 'One image URL per line (up to 8)' })}<span class="hint">Direct file upload needs object storage; see the README. For now, paste image links.</span>
    <p class="err" data-form-error role="alert"></p><div class="row"><button class="btn btn-primary" type="submit">${p ? 'Save changes' : 'Submit for review'}</button><a class="btn btn-outline" href="#/seller/products">Cancel</a></div></form></div>`;
}
route('/seller/products/new', async () => ({ title: 'Add product', html: page('/seller/products', await productForm(null)) }), S);
route('/seller/products/:id', async ({ params }) => {
  const p = (await get('/api/seller/products')).products.find((x) => x.id === params.id);
  if (!p) return { title: 'Not found', html: page('/seller/products', emptyState('Product not found')) };
  return { title: 'Edit ' + p.name, html: page('/seller/products', await productForm(p)) };
}, S);
forms.product = async (v) => {
  const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const body = {
    name: v.name, categoryId: v.categoryId, brand: v.brand || null, priceModel: v.priceModel, unit: v.unit, moq: parseInt(v.moq, 10) || 1, deliveryOptions: v.deliveryOptions,
    stockQty: v.stockQty === '' ? null : parseInt(v.stockQty, 10), originCountry: v.originCountry || null, description: v.description || null,
    specs: lines(v.specs).map((l) => { const i = l.indexOf(':'); return i > 0 ? { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : { label: 'Detail', value: l }; }),
    images: lines(v.images),
  };
  if (v.priceModel === 'fixed') body.unitPriceMinor = kes(v.price || 0) || undefined;
  if (v.id) await put('/api/seller/products/' + v.id, body); else await post('/api/seller/products', body);
  toast(v.id ? 'Product saved.' : 'Product submitted for review.', 'ok'); go('/seller/products');
};

// ---------- orders ----------
route('/seller/orders', async ({ query }) => {
  const { orders } = await get('/api/seller/orders' + (query.status ? '?status=' + encodeURIComponent(query.status) : ''));
  const tabs = [['', 'All'], ['payment_confirmed', 'New'], ['seller_processing', 'Processing'], ['ready_for_dispatch', 'Ready'], ['dispatched', 'Dispatched'], ['completed', 'Completed']];
  return { title: 'Orders', html: page('/seller/orders', `<div class="card"><h2>Orders</h2><div class="row mt">${tabs.map(([k, l]) => `<a class="btn btn-sm ${(query.status || '') === k ? 'btn-primary' : 'btn-outline'}" href="#/seller/orders${k ? '?status=' + k : ''}">${l}</a>`).join('')}</div>
    <div class="mt">${table([{ h: 'Order', f: (o) => `<a href="#/seller/orders/${o.id}"><b>${esc(o.ref)}</b></a>` }, { h: 'Date', f: (o) => fdate(o.createdAt) }, { h: 'Items', f: (o) => esc(o.items || '') }, { h: 'Buyer', f: (o) => esc(o.buyerName || '—') }, { h: 'Status', f: (o) => badge(o.status) }, { h: 'Total', num: true, f: (o) => money(o.totalMinor) }], orders, { empty: 'No orders here yet.' })}</div></div>`) };
}, S);
route('/seller/orders/:id', async ({ params }) => {
  const { order: o } = await get('/api/seller/orders/' + params.id);
  const b = o.buyer;
  return { title: o.ref, html: page('/seller/orders', `<div class="row between"><div><a href="#/seller/orders" class="small">← All orders</a><h2 class="mt">${esc(o.ref)}</h2><p class="muted small">Placed ${fdt(o.createdAt)}</p></div>${badge(o.status)}</div>
    <section class="card">${timeline(o.status)}${o.disputeOpen ? '<p class="mt"><span class="badge warn">Dispute open</span> Our team will contact you.</p>' : ''}<div class="row mt">${actionButtons(o)}</div></section>
    <div class="grid2"><section class="card"><h3>Items</h3><div class="mt">${table([{ h: 'Item', f: (i) => esc(i.name) }, { h: 'Qty', num: true, f: (i) => i.qty }, { h: 'Total', num: true, f: (i) => money(i.lineSubtotalMinor) }], o.items)}</div>
      <div class="mt">${kv('Products', money(o.productSubtotalMinor))}${kv('Delivery', money(o.deliveryMinor))}${kv('<b>Order total</b>', `<b>${money(o.totalMinor)}</b>`)}</div></section>
    <section class="card"><h3>Your earnings</h3><div class="mt">${kv('Commission rate', `${o.commissionBps / 100}% <span class="tiny muted">(${esc(String(o.commissionRule).replace(/_/g, ' '))})</span>`)}${kv('Commission', `${money(o.commissionMinor - o.commissionReversedMinor)} ${badge(o.commissionStatus)}`)}${kv('<b>You receive</b>', `<b>${money(o.sellerProceedsMinor)}</b>`)}${kv('Settlement', badge(o.settlementStatus))}</div></section></div>
    <section class="card"><h3>Buyer and delivery</h3>${b ? `<div class="mt">${kv('Name', esc(b.name))}${b.businessName ? kv('Business', esc(b.businessName)) : ''}${kv('Phone', esc(b.phone))}${kv('Email', esc(b.email))}${b.delivery?.town ? kv('Deliver to', esc([b.delivery.address, b.delivery.town, b.delivery.county].filter(Boolean).join(', '))) : kv('Fulfilment', 'Collection')}</div>` : '<p class="muted mt small">Buyer contact details are shown once payment is confirmed.</p>'}${o.trackingRef ? `<p class="small mt"><b>Tracking:</b> ${esc(o.carrier || '')} ${esc(o.trackingRef)}</p>` : ''}</section>
    <details class="card"><summary>Status history</summary><div class="mt">${history(o.history)}</div></details>`) };
}, S);

// ---------- quotes ----------
route('/seller/quotes', async () => {
  const { quotes } = await get('/api/quotes');
  const open = quotes.filter((q) => q.status === 'requested').length;
  return { title: 'Quotations', html: page('/seller/quotes', `<div class="card"><h2>Quotation requests</h2></div>${quotes.length ? quotes.map((q) => `<section class="card"><div class="row between"><div><h3>${esc(q.ref)} · ${esc(q.productName)}</h3><p class="small muted">${esc(q.buyerName)} · ${q.quantity} ${esc(q.unit || '')} · ${q.deliveryMethod === 'collection' ? 'Collection' : esc(q.deliveryLocation || 'Delivery')}${q.neededBy ? ' · needed by ' + esc(q.neededBy) : ''}</p></div>${badge(q.status)}</div>
    ${q.notes ? `<p class="mt small">${esc(q.notes)}</p>` : ''}
    ${['requested', 'quoted'].includes(q.status) ? `<form class="stack mt" data-form="quote-respond"><input type="hidden" name="id" value="${esc(q.id)}"><div class="grid2">${field('Unit price (KSh)', 'price', { type: 'number', req: true, value: q.quotedUnitPriceMinor ? fromMinor(q.quotedUnitPriceMinor) : '', attrs: 'min="1" step="0.01"' })}${field('Delivery charge (KSh)', 'delivery', { type: 'number', value: q.quotedDeliveryMinor ? fromMinor(q.quotedDeliveryMinor) : '0', attrs: 'min="0" step="0.01"' })}</div>
      <div class="grid2">${field('Valid for (days)', 'validDays', { type: 'number', value: 14, attrs: 'min="1" max="90"' })}${field('Note to buyer', 'notes', { value: q.sellerNotes || '' })}</div><p class="err" data-form-error role="alert"></p>
      <div class="row"><button class="btn btn-primary" type="submit">${q.status === 'quoted' ? 'Update quotation' : 'Send quotation'}</button><button class="btn btn-outline" type="button" data-act="quote-reject" data-id="${esc(q.id)}">Decline request</button></div></form>` : q.quotedUnitPriceMinor ? `<div class="mt">${kv('Quoted total', money(q.quotedTotalMinor))}</div>` : ''}</section>`).join('') : emptyState('No quotation requests yet', 'Requests appear here when buyers ask for a price on your quotation products.')}`, { quotes: open || '' }) };
}, S);
forms['quote-respond'] = async (v) => { await post(`/api/quotes/${v.id}/respond`, { unitPriceMinor: kes(v.price), deliveryMinor: kes(v.delivery || 0), validDays: parseInt(v.validDays, 10) || 14, notes: v.notes }); toast('Quotation sent.', 'ok'); go('/seller/quotes'); };
actions['quote-reject'] = async (el) => { const notes = prompt('Reason for declining (shown to the buyer)', ''); if (notes === null) return; await post(`/api/quotes/${el.dataset.id}/respond`, { action: 'decline', notes }); toast('Request declined.'); go('/seller/quotes'); };

// ---------- settlements ----------
route('/seller/settlements', async () => {
  const [{ settlements }, d] = await Promise.all([get('/api/seller/settlements'), get('/api/seller/dashboard')]);
  const e = d.earnings;
  return { title: 'Earnings', html: page('/seller/settlements', `<div class="kpis">${kpi('Net earnings', money(e.netEarningsMinor))}${kpi('Awaiting settlement', money(e.pendingSettlementsMinor))}${kpi('Settled to you', money(e.completedSettlementsMinor))}${kpi('Commission paid', money(e.commissionMinor))}</div>
    <div class="card"><h2>Settlements</h2><p class="muted small mt">Money is released after an order completes and the dispute window closes. Commission is taken only on completed sales.</p><div class="mt">${table([{ h: 'Ref', f: (s) => esc(s.ref) }, { h: 'Created', f: (s) => fdate(s.createdAt) }, { h: 'Status', f: (s) => badge(s.status) }, { h: 'Method', f: (s) => esc(s.method || '—') }, { h: 'Reference', f: (s) => esc(s.reference || '—') }, { h: 'Amount', num: true, f: (s) => money(s.amountMinor) }], settlements, { empty: 'No settlements yet.' })}</div></div>`) };
}, S);

// ---------- profile and documents ----------
const DOC = [['business_registration', 'Business registration'], ['tax_certificate', 'Tax certificate (KRA PIN)'], ['national_id', 'Director national ID'], ['trade_licence', 'Trade licence'], ['other', 'Other']];
route('/seller/profile', async () => {
  const { profile: p, documents } = await get('/api/seller/profile');
  return { title: 'Business profile', html: page('/seller/profile', `<div class="card"><h2>Business profile</h2><form data-form="seller-profile" class="stack mt" novalidate>
    ${field('Business name', 'businessName', { value: p.businessName, attrs: 'disabled', hint: 'Contact support to change your registered name.' })}
    <div class="grid2">${field('Phone', 'phone', { type: 'tel', req: true, value: p.phone })}${field('Flat delivery charge (KSh)', 'deliveryFlat', { type: 'number', value: p.deliveryFlatMinor != null ? fromMinor(p.deliveryFlatMinor) : '', attrs: 'min="0" step="0.01"', hint: 'Applied to delivery orders. Blank means delivery is arranged separately.' })}</div>
    ${field('Location', 'location', { req: true, value: p.location })}${textField('Description', 'description', { req: true, rows: 4, value: p.description })}
    <p class="err" data-form-error role="alert"></p><button class="btn btn-primary" type="submit">Save profile</button></form></div>
    <div class="card"><h3>Verification documents</h3><p class="muted small mt">Record which documents you have supplied. Our team will contact you for the files securely.</p><div class="mt">${table([{ h: 'Document', f: (d) => esc(DOC.find((x) => x[0] === d.kind)?.[1] || d.kind) }, { h: 'File', f: (d) => esc(d.filename) }, { h: 'Added', f: (d) => fdate(d.created_at || d.createdAt) }], documents, { empty: 'No documents recorded yet.' })}</div>
    <form data-form="seller-doc" class="stack mt" novalidate><div class="grid2">${selectField('Document type', 'kind', DOC)}${field('File name', 'filename', { req: true })}</div>${field('Note', 'note')}<p class="err" data-form-error role="alert"></p><button class="btn btn-outline" type="submit">Add document</button></form></div>`) };
}, S);
forms['seller-profile'] = async (v) => { await put('/api/seller/profile', { phone: v.phone, location: v.location, description: v.description, deliveryFlatMinor: v.deliveryFlat === '' ? null : kes(v.deliveryFlat) }); toast('Profile saved.', 'ok'); };
forms['seller-doc'] = async (v) => { await post('/api/seller/documents', v); toast('Document recorded.', 'ok'); go('/seller/profile'); };
