import { esc, money, badge, get, post, put, route, actions, forms, go, store, toast, field, selectField, textField, kv, emptyState, table, fdate, fdt, kes, modal, closeModal } from '../lib.js';
import { dash, kpi, timeline, history } from './dash.js';

const A = { roles: ['admin'] };
// Mirrors the server's staff permissions for navigation only. The server is what enforces them.
const PERM = {
  owner: ['overview', 'orders', 'payments', 'refunds', 'sellers', 'products', 'categories', 'settlements', 'settings', 'staff', 'audit', 'reports'],
  finance: ['overview', 'orders', 'payments', 'refunds', 'sellers', 'settlements', 'settings', 'reports'],
  catalogue: ['overview', 'products', 'categories', 'sellers'],
  support: ['overview', 'orders', 'refunds', 'sellers'],
};
const NAV = [['overview', '/admin', 'Overview'], ['orders', '/admin/orders', 'Orders'], ['payments', '/admin/payments', 'Payments'], ['refunds', '/admin/refunds', 'Refunds and disputes'], ['sellers', '/admin/sellers', 'Sellers'], ['products', '/admin/products', 'Products'], ['categories', '/admin/categories', 'Categories'], ['settlements', '/admin/settlements', 'Settlements'], ['reports', '/admin/reports', 'Reports'], ['settings', '/admin/settings', 'Commission settings'], ['staff', '/admin/staff', 'Staff'], ['audit', '/admin/audit', 'Audit trail']];
const page = (active, body, counts = {}) => {
  const allowed = PERM[store.user.staffRole] || ['overview'];
  const items = NAV.filter(([k]) => allowed.includes(k)).map(([k, h, l]) => [h, l, counts[k] || '']);
  return `<div class="wrap page" style="padding-bottom:0"><h1>Admin</h1><p class="muted small">Signed in as ${esc(store.user.fullName)} · ${esc(store.user.staffRole)}</p></div>${dash(items, active, body)}`;
};
const rate = (bps) => (bps == null ? '—' : `${bps / 100}%`);

route('/admin', async () => {
  const d = await get('/api/admin/overview'), t = d.totals, a = d.attention;
  const max = Math.max(1, ...d.monthly.map((m) => m.product_value));
  const att = [['Failed payments', a.failedPayments, '/admin/payments?status=failed'], ['Refund requests', a.refundRequests, '/admin/refunds'], ['Open disputes', a.openDisputes, '/admin/orders'], ['Products to approve', a.pendingProducts, '/admin/products?status=pending'], ['Out of stock', a.outOfStock, '/admin/products']];
  return { title: 'Admin overview', html: page('/admin', `
    <div class="kpis stagger">${kpi('Transaction value', money(t.transactionValueMinor), `${t.paidSubOrders} paid sub-orders`)}${kpi('Completed sales', money(t.completedSalesMinor))}${kpi('Commission earned', money(t.commissionEarnedMinor), 'on completed orders')}${kpi('Commission accrued', money(t.commissionAccruedMinor), 'on orders in progress')}</div>
    <div class="kpis stagger">${kpi('Sellers approved', t.sellersApproved, `${t.sellersPending} pending · ${t.sellersSuspended} suspended`)}${kpi('Founding sellers', `${t.foundingUsed} / ${t.foundingSlots}`)}${kpi('Buyers', t.buyers)}${kpi('Active products', t.activeProducts)}${kpi('Settlements due', money(a.settlementsDueMinor))}</div>
    <div class="card"><h3>Needs attention</h3><div class="grid mt" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">${att.map(([l, n, h]) => `<a class="card flat lift" href="#${h}" style="color:var(--text)"><div class="tiny muted">${l}</div><div class="v" style="font:700 24px var(--font-display)">${n}</div></a>`).join('')}</div></div>
    <div class="card"><h3>Monthly sales value</h3>${d.monthly.length ? `<div class="bars mt" role="img" aria-label="Monthly sales chart">${d.monthly.map((m) => `<div class="b"><span>${money(m.product_value)}</span><i style="height:${Math.max(4, Math.round((m.product_value / max) * 140))}px"></i></div>`).join('')}</div><div class="bar-labels">${d.monthly.map((m) => `<span>${esc(m.period)}</span>`).join('')}</div>` : '<p class="muted mt">No paid orders in this period.</p>'}</div>
    <div class="grid2"><div class="card"><h3>Top sellers</h3><div class="mt">${table([{ h: 'Seller', f: (s) => esc(s.name || s.seller || '') }, { h: 'Sales', num: true, f: (s) => money(s.sales ?? 0) }], d.topSellers || [], { empty: 'No data yet.' })}</div></div>
    <div class="card"><h3>Top products</h3><div class="mt">${table([{ h: 'Product', f: (s) => esc(s.name || '') }, { h: 'Sales', num: true, f: (s) => money(s.sales ?? 0) }], d.topProducts || [], { empty: 'No data yet.' })}</div></div></div>
    ${d.ledger ? `<div class="card"><div class="row between"><h3>Ledger</h3>${d.ledger.balanced ? '<span class="badge ok">Balanced</span>' : '<span class="badge bad">Out of balance</span>'}</div><p class="muted small mt">Money held for sellers and BonasHub's commission, from the double-entry ledger.</p><div class="mt">${kv('Held with gateway', money(d.ledger.gateway_clearing))}${kv('Owed to sellers', money(d.ledger.seller_payable))}${kv('Commission accrued', money(d.ledger.commission_accrued))}${kv('Commission earned', money(d.ledger.commission_earned))}</div></div>` : ''}
    <div class="row"><button class="btn btn-outline" data-act="run-jobs">Run background jobs now</button></div>`, { refunds: a.refundRequests || '', products: a.pendingProducts || '' }) };
}, A);
actions['run-jobs'] = async () => { const r = await post('/api/admin/jobs/run'); toast('Jobs ran: ' + Object.entries(r).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ').slice(0, 140), 'ok'); };

// ---------- orders ----------
route('/admin/orders', async ({ query }) => {
  const q = new URLSearchParams(); if (query.status) q.set('status', query.status); if (query.q) q.set('q', query.q);
  const { orders } = await get('/api/admin/orders?' + q);
  return { title: 'Orders', html: page('/admin/orders', `<div class="card"><h2>Orders</h2><form class="row mt" data-form="admin-filter" data-base="/admin/orders">${field('Search', 'q', { value: query.q || '', ph: 'Reference, seller or buyer' })}${selectField('Status', 'status', [['', 'All'], ...['awaiting_payment', 'payment_confirmed', 'seller_processing', 'ready_for_dispatch', 'dispatched', 'delivered', 'completed', 'cancelled', 'refund_requested', 'refunded'].map((s) => [s, s.replace(/_/g, ' ')])], query.status || '', { req: false })}<button class="btn btn-primary" type="submit">Filter</button></form>
    <div class="mt">${table([{ h: 'Order', f: (o) => `<a href="#/admin/orders/${o.id}"><b>${esc(o.ref)}</b></a>${o.disputeOpen ? ' <span class="badge warn">Dispute</span>' : ''}` }, { h: 'Seller', f: (o) => esc(o.seller) }, { h: 'Buyer', f: (o) => esc(o.buyer) }, { h: 'Status', f: (o) => badge(o.status) }, { h: 'Payment', f: (o) => (o.paymentStatus ? badge(o.paymentStatus) : '—') }, { h: 'Total', num: true, f: (o) => money(o.totalMinor) }, { h: 'Commission', num: true, f: (o) => money(o.commissionMinor) }], orders, { empty: 'No orders match.' })}</div></div>`) };
}, A);
forms['admin-filter'] = (v, form) => { const q = new URLSearchParams(); for (const [k, x] of Object.entries(v)) if (x) q.set(k, x); go(form.dataset.base + (q.toString() ? '?' + q : '')); };

route('/admin/orders/:id', async ({ params }) => {
  const { order: o, buyer, ledger } = await get('/api/admin/orders/' + params.id);
  return { title: o.ref, html: page('/admin/orders', `<div class="row between"><div><a href="#/admin/orders" class="small">← Orders</a><h2 class="mt">${esc(o.ref)} <span class="muted small">of ${esc(o.orderRef)}</span></h2></div>${badge(o.status)}</div>
    <section class="card">${timeline(o.status)}${o.disputeOpen ? `<div class="mt"><span class="badge warn">Dispute open</span><div class="row mt"><button class="btn btn-outline" data-act="resolve-dispute" data-id="${esc(o.id)}" data-res="buyer">Resolve for buyer</button><button class="btn btn-outline" data-act="resolve-dispute" data-id="${esc(o.id)}" data-res="seller">Resolve for seller</button></div></div>` : ''}</section>
    <div class="grid2"><section class="card"><h3>Money</h3><div class="mt">${kv('Products', money(o.productSubtotalMinor))}${kv('Delivery', money(o.deliveryMinor))}${kv('<b>Total</b>', `<b>${money(o.totalMinor)}</b>`)}${kv('Commission', `${rate(o.commissionBps)} = ${money(o.commissionMinor)} ${badge(o.commissionStatus)}`)}${kv('Seller receives', money(o.sellerProceedsMinor))}${kv('Refunded', money(o.refundedMinor))}${kv('Settlement', badge(o.settlementStatus))}</div></section>
    <section class="card"><h3>Buyer</h3><div class="mt">${kv('Name', esc(buyer.name))}${kv('Email', esc(buyer.email))}${kv('Phone', esc(buyer.phone))}</div></section></div>
    <section class="card"><h3>Items</h3><div class="mt">${table([{ h: 'Item', f: (i) => esc(i.name) }, { h: 'Qty', num: true, f: (i) => i.qty }, { h: 'Total', num: true, f: (i) => money(i.lineSubtotalMinor) }], o.items)}</div></section>
    <details class="card"><summary>Ledger entries (${ledger.length})</summary><div class="mt">${table([{ h: 'Time', f: (l) => fdt(l.ts) }, { h: 'Account', f: (l) => esc(l.account) }, { h: 'Kind', f: (l) => esc(l.kind) }, { h: 'Amount', num: true, f: (l) => money(l.amount_minor) }, { h: 'Ref', f: (l) => esc(l.ref || '') }], ledger)}</div></details>
    <details class="card"><summary>Status history</summary><div class="mt">${history(o.history)}</div></details>`) };
}, A);
actions['resolve-dispute'] = async (el) => { const note = prompt(`Record how this was resolved in favour of the ${el.dataset.res} (at least 5 characters)`, ''); if (note === null) return; if (note.trim().length < 5) { toast('Describe the resolution.', 'bad'); return; } await post(`/api/admin/disputes/${el.dataset.id}/resolve`, { resolution: `In favour of ${el.dataset.res}: ${note.trim()}` }); toast('Dispute resolved.', 'ok'); go(location.hash.slice(1)); };

// ---------- payments ----------
route('/admin/payments', async ({ query }) => {
  const { payments } = await get('/api/admin/payments' + (query.status ? '?status=' + query.status : ''));
  const tabs = [['', 'All'], ['pending', 'Pending'], ['successful', 'Successful'], ['failed', 'Failed']];
  return { title: 'Payments', html: page('/admin/payments', `<div class="card"><h2>Payments</h2><p class="muted small mt">A payment is marked successful only after the provider confirms it. Nothing here is set by a button click.</p><div class="row mt">${tabs.map(([k, l]) => `<a class="btn btn-sm ${(query.status || '') === k ? 'btn-primary' : 'btn-outline'}" href="#/admin/payments${k ? '?status=' + k : ''}">${l}</a>`).join('')}</div>
    <div class="mt">${table([{ h: 'Ref', f: (p) => esc(p.ref) }, { h: 'Order', f: (p) => esc(p.orderRef) }, { h: 'Method', f: (p) => esc(p.method) }, { h: 'Provider ref', f: (p) => esc(p.providerRef || '—') }, { h: 'Status', f: (p) => badge(p.status) + (p.failureReason ? `<div class="tiny muted">${esc(p.failureReason)}</div>` : '') }, { h: 'Created', f: (p) => fdt(p.createdAt) }, { h: 'Amount', num: true, f: (p) => money(p.amountMinor) }], payments, { empty: 'No payments.' })}</div></div>`) };
}, A);

// ---------- refunds ----------
route('/admin/refunds', async () => {
  const { refunds } = await get('/api/admin/refunds');
  return { title: 'Refunds', html: page('/admin/refunds', `<div class="card"><h2>Refund requests</h2><p class="muted small mt">Approving a refund reverses the commission in proportion and returns money through the original payment method.</p></div>
    ${refunds.length ? refunds.map((r) => `<section class="card"><div class="row between"><div><h3>${esc(r.ref)} · ${esc(r.subRef)}</h3><p class="small muted">${esc(r.seller)} · requested ${fdt(r.createdAt)}</p></div>${badge(r.status)}</div><p class="mt small">${esc(r.reason || '')}</p>
      <div class="mt">${kv('Refund amount', money(r.amountMinor))}${kv('Order total', money(r.orderTotalMinor))}${r.commissionReversalMinor ? kv('Commission reversed', money(r.commissionReversalMinor)) : ''}</div>
      ${r.status === 'requested' ? `<div class="row mt"><button class="btn btn-primary" data-act="refund-decide" data-id="${esc(r.id)}" data-approve="1" data-amount="${r.amountMinor}">Approve and refund</button><button class="btn btn-outline" data-act="refund-decide" data-id="${esc(r.id)}">Decline</button></div>` : ''}</section>`).join('') : emptyState('No refund requests')}`) };
}, A);
actions['refund-decide'] = async (el) => {
  const approve = el.dataset.approve === '1', note = prompt(approve ? 'Note for the record (optional)' : 'Reason for declining (shown to the buyer)', ''); if (note === null) return;
  if (!approve && !note.trim()) { toast('Give a reason for declining.', 'bad'); return; }
  await post(`/api/admin/refunds/${el.dataset.id}/decide`, { approve, amountMinor: approve ? Number(el.dataset.amount) : undefined, note }); toast(approve ? 'Refund processed.' : 'Refund declined.', 'ok'); go('/admin/refunds');
};

// ---------- sellers ----------
route('/admin/sellers', async ({ query }) => {
  const { sellers } = await get('/api/admin/sellers' + (query.status ? '?status=' + query.status : ''));
  const tabs = [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['suspended', 'Suspended']];
  return { title: 'Sellers', html: page('/admin/sellers', `<div class="card"><h2>Sellers</h2><div class="row mt">${tabs.map(([k, l]) => `<a class="btn btn-sm ${(query.status || '') === k ? 'btn-primary' : 'btn-outline'}" href="#/admin/sellers${k ? '?status=' + k : ''}">${l}</a>`).join('')}</div>
    <div class="mt">${table([{ h: 'Business', f: (s) => `<a href="#/admin/sellers/${s.id}"><b>${esc(s.businessName)}</b></a>${s.founding ? ' <span class="badge accent">Founding</span>' : ''}<div class="tiny muted">${esc(s.town || '')}</div>` }, { h: 'Contact', f: (s) => `${esc(s.contactName)}<div class="tiny muted">${esc(s.email)}</div>` }, { h: 'Status', f: (s) => badge(s.status) }, { h: 'Rate', f: (s) => rate(s.commissionOverrideBps) }, { h: 'Products', num: true, f: (s) => s.products }, { h: 'Sales', num: true, f: (s) => money(s.completedSalesMinor) }], sellers, { empty: 'No sellers.' })}</div></div>`) };
}, A);
route('/admin/sellers/:id', async ({ params }) => {
  const { seller: s, documents, stats, history: h } = await get('/api/admin/sellers/' + params.id);
  const canManage = ['owner'].includes(store.user.staffRole) || store.user.staffRole === 'finance' && false;
  return { title: s.business_name, html: page('/admin/sellers', `<div class="row between"><div><a href="#/admin/sellers" class="small">← Sellers</a><h2 class="mt">${esc(s.business_name)}</h2></div>${badge(s.status)}</div>
    <div class="grid2"><section class="card"><h3>Application</h3><div class="mt">${kv('Contact', esc(s.contact_name))}${kv('Email', esc(s.email))}${kv('Phone', esc(s.phone))}${kv('Registration no.', esc(s.reg_no || '—'))}${kv('Location', esc(s.location))}${kv('Applied', fdate(s.created_at))}${s.status_reason ? kv('Reason on file', esc(s.status_reason)) : ''}</div><p class="small mt">${esc(s.description)}</p></section>
    <section class="card"><h3>Performance</h3><div class="mt">${kv('Gross sales', money(stats.earnings.grossSalesMinor))}${kv('Commission', money(stats.earnings.commissionMinor))}${kv('Pending settlement', money(stats.earnings.pendingSettlementsMinor))}${kv('Products', stats.sales.productsListed)}${kv('Completed orders', stats.sales.completedOrders)}${kv('Commission rate', s.commission_override_bps != null ? rate(s.commission_override_bps) + ' (override)' : s.founding ? 'Founding rate' : 'Standard')}</div></section></div>
    <section class="card"><h3>Documents</h3><div class="mt">${table([{ h: 'Type', f: (d) => esc(d.kind.replace(/_/g, ' ')) }, { h: 'File', f: (d) => esc(d.filename) }, { h: 'Note', f: (d) => esc(d.note || '') }, { h: 'Added', f: (d) => fdate(d.created_at) }], documents, { empty: 'No documents recorded.' })}</div></section>
    <section class="card"><h3>Decision</h3><div class="row mt">
      ${s.status !== 'approved' ? `<button class="btn btn-primary" data-act="seller-decide" data-id="${esc(s.user_id)}" data-do="approve">Approve</button>` : ''}
      ${s.status === 'pending' ? `<button class="btn btn-outline" data-act="seller-decide" data-id="${esc(s.user_id)}" data-do="reject">Reject</button>` : ''}
      ${s.status === 'approved' ? `<button class="btn btn-danger" data-act="seller-decide" data-id="${esc(s.user_id)}" data-do="suspend">Suspend</button>` : ''}
      <button class="btn btn-outline" data-act="seller-commission" data-id="${esc(s.user_id)}" data-bps="${s.commission_override_bps ?? ''}">Set agreed commission</button></div></section>
    <details class="card"><summary>History</summary><div class="mt">${table([{ h: 'When', f: (x) => fdt(x.ts) }, { h: 'Action', f: (x) => esc(x.action) }, { h: 'By', f: (x) => esc(x.actor_role || '') }, { h: 'Detail', f: (x) => `<span class="tiny muted">${esc(x.data || '')}</span>` }], h, { empty: 'No history yet.' })}</div></details>`) };
}, A);
actions['seller-decide'] = async (el) => {
  const act = el.dataset.do; let reason = '';
  if (act !== 'approve') { reason = prompt(`Reason for ${act === 'reject' ? 'rejecting' : 'suspending'} (the seller will see this)`, ''); if (reason === null) return; if (!reason.trim()) { toast('A reason is required.', 'bad'); return; } }
  await post(`/api/admin/sellers/${el.dataset.id}/decision`, { action: act, reason }); toast('Seller updated.', 'ok'); go(location.hash.slice(1));
};
actions['seller-commission'] = async (el) => {
  const cur = el.dataset.bps === '' ? '' : String(Number(el.dataset.bps) / 100);
  const v = prompt('Agreed commission % for this seller (0 to 50). Leave empty to remove the override.', cur); if (v === null) return;
  if (v.trim() === '') { await post(`/api/admin/sellers/${el.dataset.id}/commission`, { bps: null }); }
  else { const reason = prompt('Why was this rate agreed?', ''); if (!reason) return; await post(`/api/admin/sellers/${el.dataset.id}/commission`, { bps: Math.round(parseFloat(v) * 100), reason }); }
  toast('Commission updated.', 'ok'); go(location.hash.slice(1));
};

// ---------- products ----------
route('/admin/products', async ({ query }) => {
  const { products } = await get('/api/admin/products' + (query.status ? '?status=' + query.status : ''));
  const tabs = [['', 'All'], ['pending', 'To approve'], ['active', 'Active'], ['rejected', 'Rejected']];
  return { title: 'Products', html: page('/admin/products', `<div class="card"><h2>Products</h2><div class="row mt">${tabs.map(([k, l]) => `<a class="btn btn-sm ${(query.status || '') === k ? 'btn-primary' : 'btn-outline'}" href="#/admin/products${k ? '?status=' + k : ''}">${l}</a>`).join('')}</div>
    <div class="mt">${table([{ h: 'Product', f: (p) => `<a href="#/product/${esc(p.id)}"><b>${esc(p.name)}</b></a><div class="tiny muted">${esc(p.seller.name)} · ${esc(p.category.name || '')}</div>` }, { h: 'Price', num: true, f: (p) => (p.priceModel === 'quote' ? 'Quotation' : money(p.unitPriceMinor)) }, { h: 'Stock', num: true, f: (p) => (p.stockQty ?? '—') }, { h: 'Status', f: (p) => badge(p.status) }, { h: '', f: (p) => `<div class="row">${p.status !== 'active' ? `<button class="btn btn-sm btn-primary" data-act="product-decide" data-id="${esc(p.id)}" data-do="approve">Approve</button>` : ''}${p.status === 'pending' ? `<button class="btn btn-sm btn-outline" data-act="product-decide" data-id="${esc(p.id)}" data-do="reject">Reject</button>` : ''}${p.status === 'active' ? `<button class="btn btn-sm btn-outline" data-act="product-decide" data-id="${esc(p.id)}" data-do="remove">Remove</button>` : ''}</div>` }], products, { empty: 'No products.' })}</div></div>`) };
}, A);
actions['product-decide'] = async (el) => {
  const act = el.dataset.do; let reason = '';
  if (act !== 'approve') { reason = prompt('Reason (the seller will see this)', ''); if (reason === null) return; if (!reason.trim()) { toast('A reason is required.', 'bad'); return; } }
  await post(`/api/admin/products/${el.dataset.id}/decision`, { action: act, reason }); toast('Product updated.', 'ok'); go(location.hash.slice(1));
};

// ---------- categories ----------
route('/admin/categories', async () => {
  const { categories } = await get('/api/admin/categories');
  return { title: 'Categories', html: page('/admin/categories', `<div class="card"><h2>Categories</h2><p class="muted small mt">An optional category commission replaces the standard rate for products in that category. A seller's agreed rate still wins.</p><div class="mt">${table([{ h: 'Name', f: (c) => esc(c.name) }, { h: 'Products', num: true, f: (c) => c.products }, { h: 'Commission', f: (c) => rate(c.commissionBps) }, { h: 'Status', f: (c) => badge(c.active ? 'active' : 'removed', c.active ? 'Visible' : 'Hidden') }, { h: '', f: (c) => `<div class="row"><button class="btn btn-sm btn-outline" data-act="cat-rename" data-id="${esc(c.id)}" data-name="${esc(c.name)}">Rename</button><button class="btn btn-sm btn-outline" data-act="cat-toggle" data-id="${esc(c.id)}" data-active="${c.active ? 1 : 0}">${c.active ? 'Hide' : 'Show'}</button></div>` }], categories)}</div></div>
    <div class="card"><h3>Add a category</h3><form data-form="category" class="row mt" novalidate>${field('Name', 'name', { req: true })}<button class="btn btn-primary" type="submit">Add</button></form></div>`) };
}, A);
forms.category = async (v) => { await post('/api/admin/categories', { name: v.name }); toast('Category added.', 'ok'); go('/admin/categories'); };
actions['cat-rename'] = async (el) => { const n = prompt('New name', el.dataset.name); if (!n) return; await put('/api/admin/categories/' + el.dataset.id, { name: n }); go('/admin/categories'); };
actions['cat-toggle'] = async (el) => { await put('/api/admin/categories/' + el.dataset.id, { active: el.dataset.active !== '1' }); go('/admin/categories'); };

// ---------- settlements ----------
route('/admin/settlements', async () => {
  const { candidates, settlements } = await get('/api/admin/settlements');
  return { title: 'Settlements', html: page('/admin/settlements', `<div class="card"><h2>Ready to settle</h2><p class="muted small mt">Completed orders past the dispute window, net of commission and refunds. Recording a settlement does not move money by itself: pay the seller through your payment provider, then mark it processed with the reference.</p>
    <div class="mt">${table([{ h: 'Seller', f: (c) => esc(c.seller || c.businessName || c.sellerId) }, { h: 'Orders', num: true, f: (c) => c.orders ?? c.count ?? '' }, { h: 'Amount', num: true, f: (c) => money(c.amountMinor) }, { h: '', f: (c) => `<button class="btn btn-sm btn-primary" data-act="settle-create" data-id="${esc(c.sellerId)}">Create settlement</button>` }], candidates, { empty: 'Nothing is due right now.' })}</div></div>
    <div class="card"><h2>Settlements</h2><div class="mt">${table([{ h: 'Ref', f: (s) => esc(s.ref) }, { h: 'Seller', f: (s) => esc(s.seller) }, { h: 'Created', f: (s) => fdate(s.createdAt) }, { h: 'Status', f: (s) => badge(s.status) }, { h: 'Reference', f: (s) => esc(s.reference || '—') }, { h: 'Amount', num: true, f: (s) => money(s.amountMinor) }, { h: '', f: (s) => (s.status === 'pending' ? `<div class="row"><button class="btn btn-sm btn-primary" data-act="settle-process" data-id="${esc(s.id)}">Mark paid</button><button class="btn btn-sm btn-outline" data-act="settle-cancel" data-id="${esc(s.id)}">Cancel</button></div>` : '') }], settlements, { empty: 'No settlements yet.' })}</div></div>`) };
}, A);
actions['settle-create'] = async (el) => { await post('/api/admin/settlements', { sellerId: el.dataset.id }); toast('Settlement created.', 'ok'); go('/admin/settlements'); };
actions['settle-process'] = async (el) => { const method = prompt('How was the seller paid? (e.g. bank transfer, M-Pesa)', 'bank transfer'); if (!method) return; const reference = prompt('Payment reference', ''); if (!reference) return; await post(`/api/admin/settlements/${el.dataset.id}/process`, { method, reference }); toast('Settlement recorded as paid.', 'ok'); go('/admin/settlements'); };
actions['settle-cancel'] = async (el) => { if (!confirm('Cancel this settlement? The orders become available to settle again.')) return; await post(`/api/admin/settlements/${el.dataset.id}/cancel`); go('/admin/settlements'); };

// ---------- settings ----------
const SET = [['defaultBps', 'Standard commission (%)', 'bps'], ['foundingBps', 'Founding Seller commission (%)', 'bps'], ['foundingSlots', 'Founding Seller places', 'n'], ['foundingMonths', 'Founding period (months)', 'n'], ['vatBps', 'VAT on delivery and goods (%)', 'bps'], ['disputeWindowDays', 'Dispute window after delivery (days)', 'n'], ['autoCompleteDays', 'Auto-complete after delivery (days)', 'n'], ['paymentExpiryMinutes', 'Payment expires after (minutes)', 'n']];
route('/admin/settings', async () => {
  const { settings: s } = await get('/api/admin/settings');
  const ro = store.user.staffRole !== 'owner';
  return { title: 'Commission settings', html: page('/admin/settings', `<div class="card"><h2>Commission and policy settings</h2><p class="muted small mt">Changes apply to new orders only. Each order keeps the rate it was created with. Every change is written to the audit trail.${ro ? ' You can view these but not change them.' : ''}</p>
    <form data-form="settings" class="stack mt" novalidate><div class="grid2">${SET.map(([k, l, t]) => field(l, k, { type: 'number', req: true, value: t === 'bps' ? s[k] / 100 : s[k], attrs: `step="${t === 'bps' ? '0.01' : '1'}" min="0" ${ro ? 'disabled' : ''}` })).join('')}</div>${ro ? '' : '<p class="err" data-form-error role="alert"></p><button class="btn btn-primary" type="submit">Save settings</button>'}</form></div>`) };
}, A);
forms.settings = async (v) => { const b = {}; for (const [k, , t] of SET) b[k] = t === 'bps' ? Math.round(parseFloat(v[k]) * 100) : parseInt(v[k], 10); await put('/api/admin/settings', b); toast('Settings saved.', 'ok'); };

// ---------- staff ----------
route('/admin/staff', async () => {
  const { staff, roles } = await get('/api/admin/staff');
  return { title: 'Staff', html: page('/admin/staff', `<div class="card"><h2>Staff</h2><div class="mt">${table([{ h: 'Name', f: (s) => esc(s.full_name) }, { h: 'Email', f: (s) => esc(s.email) }, { h: 'Role', f: (s) => esc(s.staff_role) }, { h: 'Status', f: (s) => badge(s.status) }, { h: '', f: (s) => (s.id === store.user.id ? '<span class="tiny muted">You</span>' : `<button class="btn btn-sm btn-outline" data-act="staff-toggle" data-id="${esc(s.id)}" data-status="${esc(s.status)}">${s.status === 'active' ? 'Suspend' : 'Reactivate'}</button>`) }], staff)}</div></div>
    <div class="card"><h3>Add a staff member</h3><form data-form="staff" class="stack mt" novalidate><div class="grid2">${field('Full name', 'fullName', { req: true })}${field('Email', 'email', { type: 'email', req: true })}</div><div class="grid2">${field('Temporary password', 'password', { type: 'password', req: true, hint: 'At least 10 characters. Ask them to change it.' })}${selectField('Role', 'staffRole', roles.map((r) => [r, r]), 'support')}</div><p class="err" data-form-error role="alert"></p><button class="btn btn-primary" type="submit">Add staff member</button></form></div>`) };
}, A);
forms.staff = async (v) => { await post('/api/admin/staff', v); toast('Staff member added.', 'ok'); go('/admin/staff'); };
actions['staff-toggle'] = async (el) => { await put('/api/admin/staff/' + el.dataset.id, { status: el.dataset.status === 'active' ? 'suspended' : 'active' }); go('/admin/staff'); };

// ---------- audit ----------
route('/admin/audit', async () => {
  const [{ entries }, v] = await Promise.all([get('/api/admin/audit?limit=100'), get('/api/admin/audit/verify')]);
  return { title: 'Audit trail', html: page('/admin/audit', `<div class="card"><div class="row between"><h2>Audit trail</h2>${v.ok ? '<span class="badge ok">Chain intact</span>' : '<span class="badge bad">Chain broken</span>'}</div><p class="muted small mt">Every sensitive action is recorded and chained so tampering is detectable. ${v.ok ? '' : esc(JSON.stringify(v))}</p>
    <div class="mt">${table([{ h: '#', num: true, f: (e) => e.seq }, { h: 'When', f: (e) => fdt(e.ts) }, { h: 'Role', f: (e) => esc(e.actor_role || 'system') }, { h: 'Action', f: (e) => `<b>${esc(e.action)}</b>` }, { h: 'Entity', f: (e) => `${esc(e.entity || '')} <span class="tiny muted">${esc((e.entity_id || '').slice(0, 8))}</span>` }, { h: 'Detail', f: (e) => `<span class="tiny muted">${esc((e.data || '').slice(0, 120))}</span>` }], entries)}</div></div>`) };
}, A);

// ---------- reports ----------
route('/admin/reports', async ({ query }) => {
  const group = query.group || 'month';
  const q = new URLSearchParams({ group }); if (query.from) q.set('from', query.from); if (query.to) q.set('to', query.to);
  const r = await get('/api/admin/reports/sales?' + q);
  return { title: 'Reports', html: page('/admin/reports', `<div class="card"><h2>Sales report</h2><form class="row mt" data-form="admin-filter" data-base="/admin/reports">${selectField('Group by', 'group', [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']], group)}${field('From', 'from', { type: 'date', value: query.from || '' })}${field('To', 'to', { type: 'date', value: query.to || '' })}<button class="btn btn-primary" type="submit">Run</button><a class="btn btn-outline" href="/api/admin/reports/sales?${q}&format=csv" download>Download CSV</a><button class="btn btn-outline" type="button" onclick="window.print()">Print</button></form>
    <div class="mt">${table([{ h: 'Period', f: (p) => esc(p.period) }, { h: 'Paid orders', num: true, f: (p) => p.orders }, { h: 'Product value', num: true, f: (p) => money(p.product_value) }, { h: 'Total value', num: true, f: (p) => money(p.total_value) }, { h: 'Commission earned', num: true, f: (p) => money(p.commission_earned) }, { h: 'Commission accrued', num: true, f: (p) => money(p.commission_accrued) }, { h: 'Refunds', num: true, f: (p) => money(p.refunds) }], r.periods, { empty: 'No sales in this range.' })}</div></div>`) };
}, A);
