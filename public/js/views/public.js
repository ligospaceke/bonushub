import { esc, money, badge, get, post, route, actions, forms, go, cart, store, toast, field, selectField, textField, kv, emptyState, plural, kes, fromMinor, ApiError } from '../lib.js';

import { artFor, heroScene, crateOutline } from '../art.js';
import { productCard, thumb, priceOf, I } from './shop.js';
export { thumb, priceOf, productCard };
const skel = (n) => Array.from({ length: n }, () => '<div class="card"><div class="skeleton" style="height:120px"></div></div>').join('');

// Scroll-linked depth for the hero scene. Moves each layer a little slower than the page. Stops when the home page is left.
function sceneParallax() {
  const layers = [...document.querySelectorAll('.scene .L')]; if (!layers.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const k = [0.06, 0.14, 0.24, 0.34]; let raf = 0;
  const tick = () => { raf = 0; if (!document.querySelector('.scene')) { removeEventListener('scroll', onScroll); return; } const y = Math.min(scrollY, 700); layers.forEach((l, i) => (l.style.transform = `translate3d(0, ${(y * k[i]).toFixed(1)}px, 0)`)); };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(tick); };
  addEventListener('scroll', onScroll, { passive: true });
}
// Fade and rise each block once as it enters the screen. Anything missed is shown after a short wait, so nothing stays hidden.
function revealOnScroll() {
  const els = [...document.querySelectorAll(".rv, .route-steps > .rv-line")]; if (!els.length) return;
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  els.forEach((e) => io.observe(e)); setTimeout(() => els.forEach((e) => e.classList.add('in')), 6000);
}
const initials = (n) => String(n).replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function initSlider() {
  const t = document.getElementById('hs-track'); if (!t) return; const dots = [...document.querySelectorAll('.hs-dots button')];
  const cur = () => Math.round(t.scrollLeft / t.clientWidth);
  t.addEventListener('scroll', () => { const c = cur(); dots.forEach((d, i) => d.setAttribute('aria-current', String(i === c))); }, { passive: true });
  t.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { go2(cur() + 1); e.preventDefault(); } if (e.key === 'ArrowLeft') { go2(cur() - 1); e.preventDefault(); } });
}
const go2 = (i) => { const t = document.getElementById('hs-track'); if (!t) return; const n = t.children.length; i = (i + n) % n; t.scrollTo({ left: i * t.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
actions['hs-prev'] = () => go2(Math.round(document.getElementById('hs-track').scrollLeft / document.getElementById('hs-track').clientWidth) - 1);
actions['hs-next'] = () => go2(Math.round(document.getElementById('hs-track').scrollLeft / document.getElementById('hs-track').clientWidth) + 1);
actions['hs-go'] = (el) => go2(+el.dataset.i);
// ---------------- Home ----------------
route('/', async () => {
  const [cats, prods, sellers] = await Promise.all([get('/api/categories'), get('/api/products?limit=8'), get('/api/sellers')]);
  const list = prods.products;
  return { title: '', html: `
  <section class="hero">${heroScene()}<div class="wrap hero-grid"><div style="min-width:0">
    <span class="badge accent in-up" style="--d:60">Founding Seller Programme: first 50 sellers</span>
    <h1 style="margin-top:18px"><span class="ln"><span style="--d:200">Machinery, materials</span></span><span class="ln"><span style="--d:320">and wholesale stock.</span></span><span class="ln"><span style="--d:440">Bought and sold on one record</span></span></h1>
    <p class="lead in-up" style="--d:620">Find verified suppliers, request quotations, pay with M-Pesa or card, and track every order from your own account.</p>
    <form class="searchbar in-up" style="--d:760" data-form="search" role="search"><label class="sr" for="hs">Search products</label><input id="hs" class="input" name="q" placeholder="Search excavators, cement, tillers, solar boards">
      <select class="input" name="category" aria-label="Category" style="flex:0 1 220px;border:0;background:var(--surface-2)"><option value="">All categories</option>${cats.categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select>
      <button class="btn btn-accent" type="submit">Search</button></form>
  </div>
  <div class="hslider" role="region" aria-roledescription="carousel" aria-label="How a BonasHub order works"><div class="hs-track" id="hs-track" tabindex="0">
    <article class="wb hs-slide" role="group" aria-roledescription="slide" aria-label="1 of 3: order tracking"><div class="wb-head"><div><div class="wb-ref">Order BH-2026-000184</div><b>Portland cement 42.5N</b></div><span class="badge info">Dispatched</span></div>
      <div class="hero-route"><span class="track"></span><span class="fill"></span><span class="n" style="left:0"></span><span class="n" style="left:31%"></span><span class="n end" style="left:100%"></span><span class="dot"></span></div>
      <div class="hero-route-labels"><span>Kajiado</span><span>Kitengela</span><span>Nairobi</span></div>
      <div class="line"><span>Quantity</span><span>200 bags</span></div><div class="line"><span>Payment</span><span>M-Pesa, verified</span></div><div class="line"><span>Order total</span><span class="total">KSh 148,000</span></div></article>
    <article class="wb hs-slide" role="group" aria-roledescription="slide" aria-label="2 of 3: quotation"><div class="wb-head"><div><div class="wb-ref">Quotation QT-2026-000051</div><b>Compact tractor, 45 hp</b></div><span class="badge ok">Quoted</span></div><div class="line" style="margin-top:12px"><span>Valid for</span><span>14 days</span></div><div class="line"><span>Delivery</span><span>Nakuru to Eldoret</span></div><div class="line"><span>Quoted total</span><span class="total">KSh 1,850,000</span></div></article>
    <article class="wb hs-slide" role="group" aria-roledescription="slide" aria-label="3 of 3: payment"><div class="wb-head"><div><div class="wb-ref">Payment PAY-2026-000212</div><b>Order BH-2026-000184</b></div><span class="badge ok">Verified</span></div><div class="line" style="margin-top:12px"><span>Method</span><span>M-Pesa</span></div><div class="line"><span>Held until</span><span>Delivery confirmed</span></div><div class="line"><span>Seller receives</span><span class="total">KSh 140,600</span></div></article></div>
    <div class="hs-ctl"><button type="button" class="icon-btn" data-act="hs-prev" aria-label="Previous slide">${I.left}</button><div class="hs-dots" role="group" aria-label="Choose slide">${[0,1,2].map((n) => `<button type="button" data-act="hs-go" data-i="${n}" aria-label="Slide ${n + 1}" aria-current="${n === 0}"></button>`).join('')}</div><button type="button" class="icon-btn" data-act="hs-next" aria-label="Next slide">${I.right}</button></div></div>
  </div></section>
  <div class="wrap"><div class="trust">
    ${[['Approved sellers only', 'Every seller is checked before listing.'], ['Pay inside BonasHub', 'M-Pesa and cards. Marked paid only when verified.'], ['Every order recorded', 'Receipts, status history and invoices.'], ['Track without chasing', 'Dispatch, delivery and disputes in one place.']].map(([b, t], i) => `<div class="rv" style="--i:${i}"><span class="rv-line"></span><b>${b}</b><p class="small muted">${t}</p></div>`).join('')}</div>
  <section class="section" style="padding-top:36px"><div class="section-head rv"><h2>Shop by category</h2><a href="#/categories">All categories</a></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${cats.categories.map((c, i) => `<a class="card lift cat-card rv" style="--i:${i % 5}" href="#/products?category=${esc(c.slug)}"><div class="art-wrap">${artFor({ slug: c.slug, name: c.name })}</div><div class="cc-body"><span class="n">${String(i + 1).padStart(2, '0')}</span><b>${esc(c.name)}</b><span class="small muted">${plural(c.productCount, 'product', 'products')}</span></div></a>`).join('')}</div></section>
  <section class="section has-grid"><div class="section-head rv"><h2>Featured products</h2><a href="#/products">View all products</a></div>
    ${list.length ? `<div class="feat">${list.map((p, i) => { const below = list.length - 5, wide = i >= 5 && below > 0 && 4 % below === 0 ? `grid-column:span ${4 / below}` : ''; return productCard(p, { cls: `rv${i === 0 ? ' spot' : ''}`, i: i % 4, extra: wide }); }).join('')}</div>` : emptyState('No products yet', 'Approved sellers will list products here.', '<a class="btn btn-accent" href="#/register?role=seller">Become a seller</a>')}</section>
  <section class="section"><div class="section-head rv"><h2>Verified suppliers</h2><a href="#/suppliers">Browse suppliers</a></div>
    ${sellers.sellers.length ? `<div class="grid">${sellers.sellers.slice(0, 6).map((s, i) => `<a class="card lift rv" style="--i:${i % 3};color:var(--text)" href="#/supplier/${esc(s.slug)}"><div class="row"><div class="mono-tile" aria-hidden="true">${esc(initials(s.name))}</div><div class="grow"><b>${esc(s.name)}</b><div class="small muted">${esc(s.town || s.region || 'Kenya')}</div></div></div><div class="row mt"><span class="badge ok">Verified</span>${s.founding ? '<span class="badge accent">Founding Seller</span>' : ''}<span class="badge">${plural(s.productCount, 'product', 'products')}</span></div></a>`).join('')}</div>` : emptyState('Suppliers will appear here once approved.')}</section>
  <section class="section"><h2 class="mb rv">How it works</h2><div class="route-steps"><span class="rv-line"></span>
    ${[['Register', 'Create a buyer or seller account. Sellers are approved before they list.'], ['Find or quote', 'Add fixed-price items to your cart, or request a quotation for machinery and bulk orders.'], ['Pay securely', 'Pay with M-Pesa or card. Your order is confirmed only after the payment is verified.'], ['Track and receive', 'Follow dispatch and delivery, confirm receipt and keep your records.']].map(([h, t], i) => `<div class="card rv" style="--i:${i + 1}"><div class="step-n">${i + 1}</div><h3>${h}</h3><p class="small muted mt">${t}</p></div>`).join('')}</div></section>
  <section class="section"><div class="cta-band rv">${crateOutline()}<div style="flex:1 1 420px"><h2>Sell on BonasHub. No sale, no commission.</h2><p class="mt">Free registration, free listings, no subscription. The first 50 approved sellers get a 3% introductory commission for six months, then the standard 5%.</p></div><a class="btn btn-primary btn-lg" href="#/register?role=seller">Become a seller</a></div></section></div>`,
  after() { sceneParallax(); revealOnScroll(); initSlider(); } };
}, { skeleton: false });

forms.search = (v) => { const q = new URLSearchParams(); if (v.q?.trim()) q.set('q', v.q.trim()); if (v.category) q.set('category', v.category); go('/products' + (q.toString() ? '?' + q : '')); };

// ---------------- Products ----------------
route('/categories', async () => {
  const { categories } = await get('/api/categories');
  return { title: 'Categories', html: `<div class="wrap page"><h1>Categories</h1><p class="muted mt">Everything on BonasHub is physical merchandise from approved sellers.</p><div class="grid stagger mt2">${categories.map((c, i) => `<a class="card lift cat-card" href="#/products?category=${esc(c.slug)}"><span class="n">${String(i + 1).padStart(2, '0')}</span><b>${esc(c.name)}</b><span class="small muted">${plural(c.productCount, 'product', 'products')}</span></a>`).join('')}</div></div>` };
});

// ---------------- Suppliers ----------------
route('/suppliers', async () => {
  const { sellers } = await get('/api/sellers');
  return { title: 'Suppliers', html: `<div class="wrap page"><h1>Verified suppliers</h1><p class="muted mt">Every supplier is reviewed and approved by BonasHub before listing products.</p>${sellers.length ? `<div class="grid stagger mt2">${sellers.map((s) => `<a class="card lift" href="#/supplier/${esc(s.slug)}" style="color:var(--text)"><b>${esc(s.name)}</b><div class="small muted">${esc([s.town, s.region].filter(Boolean).join(', ') || 'Kenya')}</div><p class="small mt" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(s.description || '')}</p><div class="row mt"><span class="badge ok">Verified</span>${s.founding ? '<span class="badge accent">Founding Seller</span>' : ''}<span class="badge">${plural(s.productCount, 'product', 'products')}</span></div></a>`).join('')}</div>` : `<div class="mt2">${emptyState('No suppliers yet')}</div>`}</div>` };
});
route('/supplier/:slug', async ({ params }) => {
  const [{ seller: s }, { products }] = await Promise.all([get('/api/sellers/' + params.slug), get('/api/products?limit=48&seller=' + encodeURIComponent(params.slug))]);
  return { title: s.name, html: `<div class="wrap page"><div class="crumbs"><a href="#/suppliers">Suppliers</a> / ${esc(s.name)}</div><div class="row between"><div><h1>${esc(s.name)}</h1><p class="muted mt">${esc([s.town, s.region, s.country].filter(Boolean).join(', '))}</p></div><div class="row"><span class="badge ok">Verified supplier</span>${s.founding ? '<span class="badge accent">Founding Seller</span>' : ''}</div></div>${s.description ? `<p class="mt" style="max-width:720px">${esc(s.description)}</p>` : ''}<h2 class="mt2 mb">Products</h2>${products.length ? `<div class="pgrid">${products.map((x) => productCard(x)).join('')}</div>` : emptyState('No products listed yet')}</div>` };
});

// ---------------- Static ----------------
route('/how-it-works', () => ({ title: 'How it works', html: `<div class="wrap page" style="max-width:860px"><h1>How BonasHub works</h1>
  <h2 class="mt2 mb">For buyers</h2><div class="col"><div class="card"><b>1. Browse freely.</b> You do not need an account to look. Register to buy, request quotations or track orders.</div><div class="card"><b>2. Buy or request a quote.</b> Fixed-price items go in your cart. Machinery, bulk and custom orders use a quotation that you can accept, which becomes an order at that price.</div><div class="card"><b>3. Pay inside BonasHub.</b> M-Pesa or card. Your order is confirmed only when the payment is verified with the payment provider, never because a button was clicked.</div><div class="card"><b>4. Track and confirm.</b> Follow each seller's order from processing to delivery, confirm receipt, and ask for a refund or raise a dispute if something is wrong.</div></div>
  <h2 class="mt2 mb">For sellers</h2><div class="col"><div class="card"><b>Free to join.</b> Registration, listings and monthly use are free. There is no subscription. No sale, no commission.</div><div class="card"><b>Commission only on completed sales.</b> The standard rate is 5% of the product value (delivery and tax are not included). Wholesale and machinery can be negotiated lower. The first 50 approved sellers pay 3% for six months.</div><div class="card"><b>You are approved first.</b> BonasHub reviews each seller. Only approved sellers can list products and receive orders.</div><div class="card"><b>Settlements.</b> Once an order is completed and the dispute window has passed, BonasHub records your settlement and pays out.</div></div>
  <div class="row mt2"><a class="btn btn-primary" href="#/register">Create a buyer account</a><a class="btn btn-accent" href="#/register?role=seller">Become a seller</a></div></div>` }));
route('/privacy', () => ({ title: 'Privacy and data protection', html: `<div class="wrap page" style="max-width:820px"><h1>Privacy and data protection</h1><div class="form-error mt" style="background:var(--warn-bg);color:var(--warn);border-color:var(--warn)">Draft notice. It must be reviewed by your legal adviser against Kenya's Data Protection Act, 2019 before launch.</div>
  <div class="col mt2"><div class="card"><h3>What we collect</h3><p class="mt">The details you give when you register (name, email, phone, location, business details), the orders and quotations you make, delivery details, and the documents sellers submit for verification.</p></div><div class="card"><h3>Why we use it</h3><p class="mt">To run your account, process orders and payments, let buyers and sellers fulfil orders, prevent fraud, and keep the financial records the law requires.</p></div><div class="card"><h3>Who can see it</h3><p class="mt">A seller sees a buyer's contact and delivery details only after payment is confirmed, and only for that seller's own orders. Buyers never see other buyers' information. Sellers never see other sellers' financial information.</p></div><div class="card"><h3>Your choices</h3><p class="mt">You consented to this notice when you registered. You can ask to see, correct or delete your information by contacting support. Financial records must be kept and cannot be deleted while the law requires them.</p></div></div></div>` }));

// ---------------- Cart ----------------
async function priceCart(method = 'delivery') { const items = cart.items(); return items.length ? post('/api/cart/price', { items, method }) : null; }
const cartLines = (c, editable) => c.sellers.map((g) => `<section class="card"><div class="row between"><h3>${esc(g.sellerName)}</h3><span class="badge ok">Verified seller</span></div>
  ${c.lines.filter((l) => l.sellerId === g.sellerId).map((l) => `<div class="row mt" style="flex-wrap:wrap;align-items:center;gap:14px"><div class="grow" style="min-width:180px"><b>${esc(l.name)}</b><div class="small muted">${money(l.unitPriceMinor)} per ${esc(l.unit || 'unit')} · MOQ ${l.moq ?? 1}</div>${l.problems.map((p) => `<div class="err" style="display:block">${esc(p)}</div>`).join('')}</div>
    ${editable ? `<div class="row" style="gap:6px"><button class="icon-btn" data-act="cart-dec" data-id="${l.productId}" aria-label="Decrease quantity">−</button><input class="input" style="width:72px;text-align:center" type="number" min="1" value="${l.qty}" data-act="noop" data-id="${l.productId}" data-qty-input aria-label="Quantity for ${esc(l.name)}"><button class="icon-btn" data-act="cart-inc" data-id="${l.productId}" aria-label="Increase quantity">+</button></div>` : `<span>× ${l.qty}</span>`}
    <div class="price" style="min-width:110px;text-align:right">${money(l.lineSubtotalMinor)}</div>${editable ? `<button class="btn btn-sm btn-outline" data-act="cart-remove" data-id="${l.productId}">Remove</button>` : ''}</div>`).join('')}
  <div class="kv mt"><span>Estimated delivery</span><span>${g.deliveryMinor ? money(g.deliveryMinor) : 'To be arranged with seller'}</span></div></section>`).join('');

route('/cart', async () => {
  const c = await priceCart();
  if (!c) return { title: 'Cart', html: `<div class="wrap page"><h1>Your cart</h1><div class="mt">${emptyState('Your cart is empty', 'Add fixed-price products to start an order. Machinery and bulk items are bought by quotation.', '<a class="btn btn-primary" href="#/products">Browse products</a>')}</div></div>` };
  return { title: 'Cart', html: `<div class="wrap page"><h1>Your cart</h1><p class="muted mt">One order, one payment. If you buy from several sellers, each seller fulfils their own part and you can track each one.</p>
  <div class="layout mt2"><div class="main-col col">${cartLines(c, true)}</div><aside class="side card col" style="flex-basis:340px">
    <h2>Order summary</h2>${kv('Product subtotal', money(c.productSubtotalMinor))}${kv('Delivery (estimated)', c.deliveryMinor ? money(c.deliveryMinor) : 'Arranged by seller')}${kv('Taxes', '<span class="muted small">On each seller\'s invoice</span>')}
    <div class="kv" style="font-weight:700;font-size:17px"><span style="color:var(--text)">Total</span><span class="price">${money(c.totalMinor)}</span></div>
    <button class="btn btn-accent btn-lg" data-act="to-checkout" ${c.ok ? '' : 'disabled'}>Proceed to checkout</button>${c.ok ? '' : '<p class="err" style="display:block">Fix the items marked above to continue.</p>'}</aside></div></div>` };
});
const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
actions['cart-inc'] = (el) => { const i = cart.items().find((x) => x.productId === el.dataset.id); cart.set(el.dataset.id, (i?.qty || 0) + 1); rerender(); };
actions['cart-dec'] = (el) => { const i = cart.items().find((x) => x.productId === el.dataset.id); if (i && i.qty > 1) cart.set(el.dataset.id, i.qty - 1); rerender(); };
actions['cart-remove'] = (el) => { cart.remove(el.dataset.id); rerender(); toast('Removed from your cart.'); };
document.addEventListener('change', (e) => { const el = e.target.closest('[data-qty-input]'); if (!el) return; const q = parseInt(el.value, 10); if (Number.isInteger(q) && q > 0) { cart.set(el.dataset.id, q); rerender(); } });
actions.noop = () => {};
actions['to-checkout'] = () => { if (!store.user) { go('/login?next=%2Fcheckout'); toast('Sign in or register to check out.'); } else if (store.user.role !== 'buyer') toast('Only buyer accounts can check out.', 'bad'); else go('/checkout'); };

// ---------------- Checkout ----------------
let idemKey = null;
route('/checkout', async () => {
  const c = await priceCart();
  if (!c) return { title: 'Checkout', html: `<div class="wrap page"><h1>Checkout</h1><div class="mt">${emptyState('Your cart is empty', '', '<a class="btn btn-primary" href="#/products">Browse products</a>')}</div></div>` };
  idemKey ||= crypto.randomUUID();
  const { addresses } = await get('/api/me/addresses'); const u = store.user;
  return { title: 'Checkout', html: `<div class="wrap page"><h1>Checkout</h1>
  <form data-form="checkout" class="layout mt2"><div class="main-col col">
    <section class="card col"><h2>Delivery</h2><div class="row"><label class="check"><input type="radio" name="method" value="delivery" checked> Deliver to me</label><label class="check"><input type="radio" name="method" value="collection"> I will collect from the seller</label></div>
    ${addresses.length ? selectField('Saved address', 'saved', [['', 'Enter a new address'], ...addresses.map((a) => [a.id, `${a.label || a.town}: ${a.name}, ${a.town}`])], '', { req: false }) : ''}
    <div class="grid2">${field('Receiver name', 'name', { value: u.fullName, req: true })}${field('Receiver phone', 'phone', { value: u.phone || '', req: true })}${field('County', 'county', { value: u.county || '', req: true })}${field('Town', 'town', { value: u.town || '', req: true })}</div>
    ${field('Address or landmark', 'address')}${field('Delivery notes', 'notes')}
    <label class="check"><input type="checkbox" name="saveAddress"> Save this address for next time</label></section>
    <section class="card col"><h2>Payment</h2><label class="check card" style="padding:14px"><input type="radio" name="pay" value="mpesa" checked><span><b>M-Pesa</b><br><span class="small muted">You receive a prompt on your phone and enter your PIN.</span></span></label>
      ${field('M-Pesa phone number', 'mpesaPhone', { value: u.phone || '', req: true, ph: '0712 345 678' })}
      <label class="check card" style="padding:14px"><input type="radio" name="pay" value="card"><span><b>Card or bank</b><br><span class="small muted">You are sent to the payment provider's secure page. BonasHub never sees your card details.</span></span></label></section>
    ${cartLines(c, false)}</div>
  <aside class="side card col" style="flex-basis:340px"><h2>Order summary</h2>${kv('Product subtotal', money(c.productSubtotalMinor))}${kv('Delivery (estimated)', c.deliveryMinor ? money(c.deliveryMinor) : 'Arranged by seller')}
    <div class="kv" style="font-weight:700"><span style="color:var(--text)">Total</span><span class="price">${money(c.totalMinor)}</span></div>
    <div class="form-error" data-form-error role="alert"></div><button class="btn btn-accent btn-lg" type="submit" ${c.ok ? '' : 'disabled'}>Place order and pay</button>
    <p class="tiny muted">Your order is confirmed only after the payment is verified. If you do not pay within 30 minutes the order is cancelled and stock is released.</p></aside></form></div>`,
  after() {
    const sel = document.querySelector('[name=saved]'); if (!sel) return;
    sel.addEventListener('change', () => { const a = addresses.find((x) => x.id === sel.value); if (!a) return; const f = sel.form; f.name.value = a.name; f.phone.value = a.phone; f.county.value = a.county; f.town.value = a.town; f.address.value = a.address || ''; f.notes.value = a.notes || ''; });
  } };
});
forms.checkout = async (v) => {
  const address = { name: v.name, phone: v.phone, county: v.county, town: v.town, address: v.address, notes: v.notes };
  const order = await post('/api/checkout', { items: cart.items(), method: v.method, address, idempotencyKey: idemKey });
  idemKey = null; cart.clear();
  if (v.saveAddress && v.method === 'delivery') { try { await post('/api/me/addresses', address); } catch { /* not critical */ } }
  const orderId = order.orderId;
  try {
    const p = await post(`/api/orders/${orderId}/pay`, { method: v.pay, phone: v.pay === 'mpesa' ? v.mpesaPhone : undefined });
    go('/pay/' + p.payment.ref);
  } catch (e) { toast(e.message || 'We could not start the payment. You can pay from your order page.', 'bad'); go('/account/orders/' + orderId); }
};

// ---------------- Payment page ----------------
function poll(fn, ms = 2500) { const start = location.hash; const t = setInterval(async () => { if (location.hash !== start) return clearInterval(t); try { if (await fn() === true) clearInterval(t); } catch { /* keep trying */ } }, ms); }
route('/pay/:ref', async ({ params }) => {
  const p = await get('/api/payments/' + params.ref);
  const done = p.status === 'successful', failed = p.status === 'failed';
  return { title: 'Payment', html: `<div class="wrap page" style="max-width:560px"><div class="card col center" id="pay-card" data-ref="${esc(p.ref)}">
    ${done ? `<div class="step-n">✓</div><h1 style="font-size:28px">Payment confirmed</h1><p class="muted">Thank you. The sellers have been notified and your order is being prepared.</p><a class="btn btn-primary btn-lg" href="#/account/orders/${p.orderId}">View my order</a>`
    : failed ? `<h1 style="font-size:28px">Payment did not go through</h1><p class="muted">No money was taken. You can try again from your order page.</p><a class="btn btn-primary btn-lg" href="#/account/orders/${p.orderId}">Back to my order</a>`
    : `<div class="bl-mark pulse" style="margin:0 auto"><span class="bl-ring"></span><span class="bl-b">B</span></div><h1 style="font-size:28px">${p.method === 'mpesa' ? 'Check your phone' : 'Complete your card payment'}</h1><p class="muted">Amount: <b style="color:var(--text)">${money(p.amountMinor)}</b></p><p class="muted">We are waiting for the payment provider to confirm. This page updates by itself.</p>
    ${p.provider === 'sandbox' ? `<div class="card flat col" style="background:var(--surface-2);text-align:left"><span class="badge warn" style="align-self:flex-start">Test payments</span><p class="small">This is the practice payment gateway. In production, the real M-Pesa prompt or card page replaces this box.</p><div class="row"><button class="btn btn-primary" data-act="sandbox-pay" data-ref="${esc(p.ref)}" data-outcome="approve">Approve payment</button><button class="btn btn-outline" data-act="sandbox-pay" data-ref="${esc(p.ref)}" data-outcome="decline">Decline</button></div></div>` : ''}`}
  </div></div>`,
  after() { if (!done && !failed) poll(async () => { const s = await get('/api/payments/' + params.ref); if (s.status !== 'pending') { window.dispatchEvent(new HashChangeEvent('hashchange')); return true; } }); } };
});
actions['sandbox-pay'] = async (el) => { await post(`/api/sandbox/pay/${el.dataset.ref}`, { outcome: el.dataset.outcome }); window.dispatchEvent(new HashChangeEvent('hashchange')); };
