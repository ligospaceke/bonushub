import { esc, money, badge, get, post, del, put, setUser, route, actions, forms, go, store, toast, field, selectField, textField, kv, emptyState, table, fdate, fdt } from '../lib.js';
import { refreshNotifications } from '../shell.js';
import { dash, kpi, timeline, history, actionButtons } from './dash.js';

const B = { roles: ['buyer'] };
const nav = (n = {}) => [['/account', 'Overview'], ['/account/orders', 'Orders', n.pay || ''], ['/account/quotes', 'Quotations', n.quotes || ''], ['/account/addresses', 'Addresses'], ['/account/profile', 'Profile'], ['/notifications', 'Notifications']];
const page = (active, body, n) => `<div class="wrap page" style="padding-bottom:0"><h1>My Account</h1></div>${dash(nav(n), active, body)}`;
const orderStatus = (o) => { const s = o.subOrders.map((x) => x.status); return s.every((x) => x === s[0]) ? badge(s[0]) : badge('seller_processing', 'Several statuses'); };
const ordersTable = (orders) => table([
  { h: 'Order', f: (o) => `<a href="#/account/orders/${o.id}"><b>${esc(o.ref)}</b></a>` }, { h: 'Date', f: (o) => fdate(o.createdAt) },
  { h: 'Status', f: orderStatus }, { h: 'Total', num: true, f: (o) => money(o.totalMinor) },
], orders, { empty: 'You have not placed any orders yet.' });

route('/account', async () => {
  const [{ orders }, { quotes }] = await Promise.all([get('/api/me/orders'), get('/api/quotes')]);
  const open = orders.filter((o) => o.subOrders.some((s) => !['completed', 'cancelled', 'refunded'].includes(s.status)));
  const due = orders.filter((o) => o.subOrders.some((s) => s.status === 'awaiting_payment'));
  const quoted = quotes.filter((q) => q.status === 'quoted');
  const u = store.user;
  return { title: 'My account', html: page('/account', `
    <div class="card"><h2>Hello, ${esc(u.fullName.split(' ')[0])}</h2><p class="muted mt">${u.emailVerified ? '' : 'Your email is not verified yet. <a href="#/verify">Verify now</a>. '}Track orders, answer quotations and manage your details here.</p></div>
    <div class="kpis stagger">${kpi('Open orders', open.length)}${kpi('Awaiting payment', due.length)}${kpi('Quotations to review', quoted.length)}${kpi('All orders', orders.length)}</div>
    <div class="card"><div class="row between"><h3>Recent orders</h3><a href="#/account/orders">View all</a></div><div class="mt">${ordersTable(orders.slice(0, 5))}</div></div>`, { pay: due.length || '', quotes: quoted.length || '' }) };
}, B);

route('/account/orders', async () => {
  const { orders } = await get('/api/me/orders');
  return { title: 'My orders', html: page('/account/orders', `<div class="card"><h2>Orders</h2><div class="mt">${ordersTable(orders)}</div></div>`) };
}, B);

route('/account/orders/:id', async ({ params }) => {
  const { order: o } = await get('/api/me/orders/' + params.id);
  const d = o.delivery || {};
  return { title: o.ref, html: page('/account/orders', `
    <div class="row between"><div><a href="#/account/orders" class="small">← All orders</a><h2 class="mt">Order ${esc(o.ref)}</h2><p class="muted small">Placed ${fdt(o.createdAt)} · ${o.method === 'collection' ? 'Collection' : 'Delivery'}</p></div>
      <div class="row">${o.amountDueMinor ? `<button class="btn btn-accent" data-act="pay-now" data-id="${esc(o.id)}" data-amount="${o.amountDueMinor}">Pay ${money(o.amountDueMinor)}</button>` : ''}<button class="btn btn-outline" onclick="window.print()">Print</button></div></div>
    ${o.subOrders.map((s) => `<section class="card"><div class="row between"><div><h3>${esc(s.ref)}</h3><p class="small muted">Sold by <a href="#/supplier/${esc(s.seller.slug)}">${esc(s.seller.name)}</a></p></div>${badge(s.status)}</div>
      <div class="mt2">${timeline(s.status)}</div>
      ${s.trackingRef ? `<p class="mt small"><b>Tracking:</b> ${esc(s.carrier || 'Carrier')} · ${esc(s.trackingRef)}</p>` : ''}
      ${s.cancelReason ? `<p class="mt small muted">Reason: ${esc(s.cancelReason)}</p>` : ''}
      ${s.disputeOpen ? `<p class="mt"><span class="badge warn">Dispute open</span> Our team is reviewing this order.</p>` : ''}
      <div class="mt">${table([{ h: 'Item', f: (i) => esc(i.name) }, { h: 'Qty', num: true, f: (i) => `${i.qty} ${esc(i.unit || '')}` }, { h: 'Price', num: true, f: (i) => money(i.unitPriceMinor) }, { h: 'Total', num: true, f: (i) => money(i.lineSubtotalMinor) }], s.items)}</div>
      <div class="mt">${kv('Products', money(s.productSubtotalMinor))}${kv('Delivery', money(s.deliveryMinor))}${s.taxMinor ? kv('VAT', money(s.taxMinor)) : ''}${kv('<b>Total</b>', `<b>${money(s.totalMinor)}</b>`)}${s.refundedMinor ? kv('Refunded', money(s.refundedMinor)) : ''}</div>
      <div class="row mt">${actionButtons(s)}${s.canRequestRefund ? `<button class="btn btn-outline" data-act="open-refund" data-id="${esc(s.id)}">Request refund</button>` : ''}${s.canDispute ? `<button class="btn btn-outline" data-act="open-dispute" data-id="${esc(s.id)}">Report a problem</button>` : ''}</div>
      <details class="mt"><summary>Status history</summary><div class="mt">${history(s.history)}</div></details></section>`).join('')}
    <div class="grid2"><section class="card"><h3>Payments</h3><div class="mt">${table([{ h: 'Ref', f: (p) => `<a href="#/pay/${esc(p.ref)}">${esc(p.ref)}</a>` }, { h: 'Method', f: (p) => esc(p.method) }, { h: 'Status', f: (p) => badge(p.status) }, { h: 'Amount', num: true, f: (p) => money(p.amountMinor) }], o.payments, { empty: 'No payment started yet.' })}</div></section>
    <section class="card"><h3>${o.method === 'collection' ? 'Collection' : 'Delivery details'}</h3><div class="mt">${d.name ? `${kv('Name', esc(d.name))}${kv('Phone', esc(d.phone))}${kv('Location', esc([d.address, d.town, d.county].filter(Boolean).join(', ')))}${d.notes ? kv('Notes', esc(d.notes)) : ''}` : '<p class="muted small">Collect from the seller.</p>'}</div></section></div>
    ${o.refunds.length ? `<section class="card"><h3>Refunds</h3><div class="mt">${table([{ h: 'Ref', f: (r) => esc(r.ref) }, { h: 'Order', f: (r) => esc(r.subRef) }, { h: 'Status', f: (r) => badge(r.status) }, { h: 'Amount', num: true, f: (r) => money(r.amountMinor) }], o.refunds)}</div></section>` : ''}`) };
}, B);

actions['pay-now'] = async (el) => {
  const method = prompt('Pay with: type "mpesa" or "card"', 'mpesa'); if (!method) return;
  const m = method.trim().toLowerCase(); if (!['mpesa', 'card'].includes(m)) { toast('Choose mpesa or card.', 'bad'); return; }
  let phone; if (m === 'mpesa') { phone = prompt('M-Pesa phone number', store.user.phone || ''); if (!phone) return; }
  const p = await post(`/api/orders/${el.dataset.id}/pay`, { method: m, phone });
  go('/pay/' + p.payment.ref);
};

// ---------- quotations ----------
route('/account/quotes', async () => {
  const { quotes } = await get('/api/quotes');
  return { title: 'Quotations', html: page('/account/quotes', `<div class="card"><h2>Quotation requests</h2><p class="muted mt small">Sellers reply with a price. Accepting a quote creates an order at exactly that price.</p></div>
    ${quotes.length ? quotes.map((q) => `<section class="card"><div class="row between"><div><h3>${esc(q.ref)} · ${esc(q.productName)}</h3><p class="small muted">${esc(q.sellerName)} · ${q.quantity} ${esc(q.unit || '')} · requested ${fdate(q.createdAt)}</p></div>${badge(q.status)}</div>
      ${q.notes ? `<p class="mt small">${esc(q.notes)}</p>` : ''}
      ${q.status === 'quoted' ? `<div class="mt">${kv('Unit price', money(q.quotedUnitPriceMinor))}${kv('Delivery', money(q.quotedDeliveryMinor || 0))}${kv('<b>Total</b>', `<b>${money(q.quotedTotalMinor)}</b>`)}${kv('Valid until', fdate(q.validUntil))}${q.sellerNotes ? kv('Seller note', esc(q.sellerNotes)) : ''}</div>
        <form class="row mt" data-form="quote-accept"><input type="hidden" name="id" value="${esc(q.id)}"><input type="hidden" name="method" value="${esc(q.deliveryMethod)}"><button class="btn btn-primary" type="submit">Accept and order</button><button class="btn btn-outline" type="button" data-act="quote-decline" data-id="${esc(q.id)}">Decline</button></form>` : ''}
      ${q.status === 'converted' && q.orderId ? `<p class="mt"><a class="btn btn-outline" href="#/account/orders/${esc(q.orderId)}">View order</a></p>` : ''}</section>`).join('') : emptyState('No quotations yet', 'Open a product marked “Quotation” to request a price.', '<a class="btn btn-primary" href="#/products?priceModel=quote">Browse quotation products</a>')}`) };
}, B);
forms['quote-accept'] = async (v) => {
  const { addresses } = await get('/api/me/addresses'); const a = addresses[0], u = store.user;
  const address = v.method === 'collection' ? undefined : { name: a?.name || u.fullName, phone: a?.phone || u.phone, county: a?.county || u.county || 'Nairobi', town: a?.town || u.town || 'Nairobi', address: a?.address || '', notes: a?.notes || '' };
  const r = await post(`/api/quotes/${v.id}/accept`, { address, idempotencyKey: 'quote-' + v.id });
  toast('Order created. Complete your payment.', 'ok'); go('/account/orders/' + r.orderId);
};
actions['quote-decline'] = async (el) => { if (!confirm('Decline this quotation?')) return; await post(`/api/quotes/${el.dataset.id}/decline`); toast('Quotation declined.'); go('/account/quotes'); };

// ---------- addresses ----------
route('/account/addresses', async () => {
  const { addresses } = await get('/api/me/addresses');
  return { title: 'Addresses', html: page('/account/addresses', `<div class="card"><h2>Saved addresses</h2>
    ${addresses.length ? `<div class="grid2 mt">${addresses.map((a) => `<div class="card flat"><b>${esc(a.label || 'Address')}</b><p class="small mt">${esc(a.name)} · ${esc(a.phone)}<br>${esc([a.address, a.town, a.county].filter(Boolean).join(', '))}</p><button class="btn btn-sm btn-outline mt" data-act="del-address" data-id="${esc(a.id)}">Remove</button></div>`).join('')}</div>` : '<p class="muted mt">No saved addresses yet.</p>'}</div>
    <div class="card"><h3>Add an address</h3><form data-form="address" class="stack mt" novalidate>${field('Label', 'label', { ph: 'Home, Shop, Site' })}<div class="grid2">${field('Contact name', 'name', { req: true })}${field('Phone', 'phone', { type: 'tel', req: true })}</div><div class="grid2">${field('County', 'county', { req: true })}${field('Town', 'town', { req: true })}</div>${field('Address or landmark', 'address')}${field('Delivery notes', 'notes')}<p class="err" data-form-error role="alert"></p><button class="btn btn-primary" type="submit">Save address</button></form></div>`) };
}, B);
forms.address = async (v) => { await post('/api/me/addresses', v); toast('Address saved.', 'ok'); go('/account/addresses'); };
actions['del-address'] = async (el) => { await del('/api/me/addresses/' + el.dataset.id); toast('Address removed.'); go('/account/addresses'); };

// ---------- profile ----------
route('/account/profile', async () => {
  const u = store.user;
  return { title: 'Profile', html: page('/account/profile', `<div class="card"><h2>Profile</h2><form data-form="profile" class="stack mt" novalidate>
    ${field('Full name', 'fullName', { req: true, value: u.fullName })}<div class="grid2">${field('Email', 'email', { value: u.email, attrs: 'disabled' })}${field('Phone', 'phone', { type: 'tel', req: true, value: u.phone })}</div>
    <div class="grid2">${field('County', 'county', { value: u.county || '' })}${field('Town', 'town', { value: u.town || '' })}</div>
    ${u.accountType === 'business' ? `<div class="grid2">${field('Business name', 'businessName', { value: u.businessName || '' })}${field('Business type', 'businessType', { value: u.businessType || '' })}</div>` : ''}
    <p class="err" data-form-error role="alert"></p><button class="btn btn-primary" type="submit">Save changes</button></form></div>`) };
}, B);
forms.profile = async (v) => {
  await put('/api/me/profile', { fullName: v.fullName, phone: v.phone, county: v.county, town: v.town, businessName: v.businessName, businessType: v.businessType });
  setUser((await get('/api/auth/me')).user); toast('Profile updated.', 'ok');
};

// ---------- notifications (all signed-in roles) ----------
route('/notifications', async () => {
  const r = await get('/api/me/notifications');
  if (r.unread) { post('/api/me/notifications/read').then(refreshNotifications); }
  return { title: 'Notifications', html: `<div class="wrap page"><h1>Notifications</h1><div class="stack mt2">${r.notifications.length ? r.notifications.map((n) => `<div class="card flat ${n.read ? '' : 'unread'}"><div class="row between"><b>${esc(n.title)}</b><span class="tiny muted">${fdt(n.createdAt)}</span></div>${n.body ? `<p class="small mt">${esc(n.body)}</p>` : ''}${n.link ? `<p class="mt small"><a href="${esc(n.link)}">Open</a></p>` : ''}</div>`).join('') : emptyState('You are all caught up', 'Order, payment and quotation updates appear here.')}</div></div>` };
}, { roles: ['buyer', 'seller', 'admin'] });
