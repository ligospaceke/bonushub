import { esc, money, badge, get, post, route, actions, forms, go, cart, store, toast, field, selectField, textField, emptyState, plural, kes, ApiError } from '../lib.js';
import { artFor } from '../art.js';

// ---------------------------------------------------------------- small shared helpers
export const announce = (msg) => { const el = document.getElementById('live'); if (!el) return; el.textContent = ''; setTimeout(() => (el.textContent = msg), 30); };
const initials = (n) => String(n).replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const ico = (d, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
export const I = { arrow: ico('<path d="M5 12h14M13 6l6 6-6 6"/>', 16), left: ico('<path d="M15 6l-6 6 6 6"/>'), right: ico('<path d="M9 6l6 6-6 6"/>'), close: ico('<path d="M6 6l12 12M18 6L6 18"/>'), filter: ico('<path d="M4 6h16M7 12h10M10 18h4"/>'), plus: ico('<path d="M12 5v14M5 12h14"/>'), minus: ico('<path d="M5 12h14"/>'), expand: ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'), play: ico('<path d="M7 5l12 7-12 7z"/>'), check: ico('<path d="M5 12l5 5 9-10"/>', 16), compare: ico('<path d="M8 4v16M16 4v16M4 8h8M12 16h8"/>', 16), cart: ico('<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>') };

// ---------------------------------------------------------------- compare list (kept in this browser; the compare page also takes ?ids=)
const CMP = 'bh_compare', CMP_MAX = 4;
export const compare = {
  items() { try { const v = JSON.parse(localStorage.getItem(CMP) || '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string').slice(0, CMP_MAX) : []; } catch { return []; } },
  has(id) { return this.items().some((x) => x.id === id); },
  save(list) { try { localStorage.setItem(CMP, JSON.stringify(list)); } catch {} window.dispatchEvent(new Event('bh:compare')); },
  toggle(p) {
    const l = this.items(); const i = l.findIndex((x) => x.id === p.id);
    if (i >= 0) { l.splice(i, 1); this.save(l); announce(`${p.name} removed from comparison. ${l.length} selected.`); return true; }
    if (l.length >= CMP_MAX) { toast(`You can compare up to ${CMP_MAX} products. Remove one first.`, 'bad'); return false; }
    l.push({ id: p.id, name: p.name, cat: p.cat || '', img: p.img || '' }); this.save(l); announce(`${p.name} added to comparison. ${l.length} selected.`); return true;
  },
  remove(id) { this.save(this.items().filter((x) => x.id !== id)); },
  clear() { this.save([]); },
};
export function renderTray() {
  const el = document.getElementById('tray'); if (!el) return;
  const l = compare.items(); const onCompare = location.hash.startsWith('#/compare');
  if (!l.length || onCompare) { el.innerHTML = ''; el.classList.remove('on'); document.body.classList.remove('has-tray'); return; }
  el.classList.add('on'); document.body.classList.add('has-tray');
  el.innerHTML = `<div class="wrap tray-in" role="region" aria-label="Products selected for comparison"><div class="tray-items">${l.map((x) => `<span class="tray-chip"><span class="tray-thumb" aria-hidden="true">${x.img ? `<img src="${esc(x.img)}" alt="">` : artFor({ id: x.id, name: x.name, category: { slug: x.cat } })}</span><span class="tray-name">${esc(x.name)}</span><button class="icon-btn sm" data-act="cmp-remove" data-id="${esc(x.id)}" aria-label="Remove ${esc(x.name)} from comparison">${I.close}</button></span>`).join('')}${Array.from({ length: CMP_MAX - l.length }, () => '<span class="tray-empty" aria-hidden="true">+</span>').join('')}</div>
    <div class="tray-act"><button class="btn btn-ghost" data-act="cmp-clear">Clear</button><a class="btn btn-primary" href="#/compare?ids=${l.map((x) => x.id).join(',')}" ${l.length < 2 ? 'aria-disabled="true" tabindex="-1" data-need="2"' : ''}>Compare ${l.length}</a></div></div>`;
}
window.addEventListener('bh:compare', () => { renderTray(); document.querySelectorAll('[data-cmp]').forEach((c) => { c.checked = compare.has(c.dataset.cmp); }); document.querySelectorAll('[data-cmp-btn]').forEach(syncCmpBtn); });
window.addEventListener('hashchange', renderTray);
actions['cmp-remove'] = (el) => compare.remove(el.dataset.id);
actions['cmp-clear'] = () => { compare.clear(); announce('Comparison cleared.'); };
document.addEventListener('change', (e) => {
  const c = e.target.closest?.('[data-cmp]'); if (!c) return;
  const ok = compare.toggle({ id: c.dataset.cmp, name: c.dataset.name, cat: c.dataset.cat, img: c.dataset.img }); if (!ok) c.checked = false;
});
document.addEventListener('click', (e) => { const a = e.target.closest?.('a[aria-disabled="true"][data-need]'); if (a) { e.preventDefault(); toast('Pick at least two products to compare.'); } });
function syncCmpBtn(b) { const on = compare.has(b.dataset.id); b.setAttribute('aria-pressed', String(on)); b.querySelector('span').textContent = on ? 'In comparison' : 'Add to compare'; }
actions['cmp-btn'] = (el) => { compare.toggle({ id: el.dataset.id, name: el.dataset.name, cat: el.dataset.cat, img: el.dataset.img }); syncCmpBtn(el); };

// ---------------------------------------------------------------- product card
export const priceOf = (p) => (p.priceModel === 'quote' ? 'Quotation' : money(p.unitPriceMinor));
export const thumb = (p) => (p.images?.[0] && !/\{n\}/.test(p.images[0]) && !isVideo(p.images[0]) ? `<img src="${esc(p.images[0])}" alt="" loading="lazy" decoding="async">` : artFor(p));
const stockText = { in_stock: ['In stock', 'ok'], low_stock: ['Low stock', 'warn'], out_of_stock: ['Out of stock', 'bad'], made_to_order: ['Made to order', 'info'] };
export const productCard = (p, { cls = '', i = null, extra = '' } = {}) => {
  const st = stockText[p.stockStatus] || [String(p.stockStatus || '').replace(/_/g, ' '), ''];
  return `<article class="pcard ${cls}" ${i == null && !extra ? '' : `style="${i == null ? '' : `--i:${i};`}${extra}"`}>
  <a class="pcard-media" href="#/product/${esc(p.id)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a>
  <div class="pcard-flags">${p.priceModel === 'quote' ? '<span class="tag">Quotation</span>' : ''}${p.seller?.founding ? '<span class="tag accent">Founding Seller</span>' : ''}</div>
  <div class="pcard-body"><span class="tiny muted">${esc(p.category?.name)}</span><h3><a class="pcard-link" href="#/product/${esc(p.id)}">${esc(p.name)}</a></h3>
    <span class="small muted">${esc(p.seller?.name)}${p.seller?.town ? ' · ' + esc(p.seller.town) : ''}</span>
    <div class="pcard-foot"><div><div class="price">${priceOf(p)}</div><div class="tiny muted">${p.priceModel === 'fixed' ? `per ${esc(p.unit)} · MOQ ${p.moq}` : 'Delivery negotiated'}</div></div><span class="stock ${st[1]}">${st[0]}</span></div></div>
  <label class="cmp"><input type="checkbox" data-cmp="${esc(p.id)}" data-name="${esc(p.name)}" data-cat="${esc(p.category?.slug || '')}" data-img="${esc(p.images?.[0] && !/\{n\}/.test(p.images[0]) && !isVideo(p.images[0]) ? p.images[0] : '')}" ${compare.has(p.id) ? 'checked' : ''}><span>Compare<span class="sr"> ${esc(p.name)}</span></span></label></article>`;
};

// ---------------------------------------------------------------- listing with faceted navigation
// The address is the source of truth: /products?category=...&seller=...&min=500&max=5000&sort=... can be shared, bookmarked and reloaded.
const KEYS = ['q', 'category', 'seller', 'priceModel', 'inStock', 'founding', 'min', 'max', 'sort'];
const SORT = [['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['name', 'Name']];
const hashQuery = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
const clean = (q) => { const o = {}; for (const k of KEYS) if (q[k]) o[k] = String(q[k]); return o; };
const apiQS = (q, extra = {}) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(clean(q))) p.set(k, k === 'min' || k === 'max' ? String(Math.round(Number(v) * 100) || 0) : v); for (const [k, v] of Object.entries(extra)) p.set(k, v); return p.toString(); };
const kesShort = (m) => (m == null ? '' : 'KSh ' + Math.round(m / 100).toLocaleString('en-KE'));
const opt = (name, value, label, n, checked, type = 'radio') => `<label class="opt ${n === 0 && !checked ? 'zero' : ''}"><input type="${type}" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''} ${n === 0 && !checked ? 'disabled' : ''}><span class="opt-l">${esc(label)}</span>${n == null ? '' : `<span class="n" data-n="${name}:${esc(value)}">${n}</span>`}</label>`;
const group = (title, body, open = true) => `<details class="fg" ${open ? 'open' : ''}><summary>${title}</summary><div class="fg-b">${body}</div></details>`;

function facetsHTML(f, q) {
  const cats = f.categories.map((c) => opt('category', c.slug, c.name, c.count, q.category === c.slug)).join('');
  const sellers = f.sellers.map((s, i) => `<span class="${i > 5 ? 'extra' : ''}">${opt('seller', s.slug, s.name.replace(/\s*\(demo\)/, ''), s.count, q.seller === s.slug)}</span>`).join('');
  return `${group('Category', opt('category', '', 'All categories', null, !q.category) + cats)}
  ${group('Supplier', opt('seller', '', 'All suppliers', null, !q.seller) + sellers + (f.sellers.length > 6 ? '<button type="button" class="linkbtn" data-act="facet-more" aria-expanded="false">Show all suppliers</button>' : ''))}
  ${group('Buying option', opt('priceModel', '', 'Fixed price and quotation', null, !q.priceModel) + opt('priceModel', 'fixed', 'Fixed price', f.priceModel.fixed || 0, q.priceModel === 'fixed') + opt('priceModel', 'quote', 'Quotation only', f.priceModel.quote || 0, q.priceModel === 'quote'))}
  ${group('Price (KSh)', `<div class="range"><label><span class="sr">Minimum price in shillings</span><input class="input" name="min" inputmode="numeric" placeholder="Min" value="${esc(q.min || '')}" aria-describedby="price-hint"></label><span aria-hidden="true">to</span><label><span class="sr">Maximum price in shillings</span><input class="input" name="max" inputmode="numeric" placeholder="Max" value="${esc(q.max || '')}" aria-describedby="price-hint"></label></div><p class="tiny muted" id="price-hint">${f.priceRange.minMinor != null ? `Fixed prices here run from ${kesShort(f.priceRange.minMinor)} to ${kesShort(f.priceRange.maxMinor)}.` : 'No fixed prices in this selection.'}</p>`)}
  ${group('Availability', opt('inStock', '1', 'In stock', f.inStock, q.inStock === '1', 'checkbox') + opt('founding', '1', 'Founding Sellers', f.founding, q.founding === '1', 'checkbox'))}`;
}

function chipsHTML(q, f) {
  const out = [], nm = (k, v) => (k === 'category' ? f.categories.find((c) => c.slug === v)?.name : k === 'seller' ? f.sellers.find((c) => c.slug === v)?.name?.replace(/\s*\(demo\)/, '') : null) || v;
  const add = (k, label) => out.push(`<button type="button" class="chip" data-act="chip-x" data-k="${k}">${esc(label)} <span class="x">${I.close}</span><span class="sr">Remove filter</span></button>`);
  if (q.q) add('q', `“${q.q}”`); if (q.category) add('category', nm('category', q.category)); if (q.seller) add('seller', nm('seller', q.seller));
  if (q.priceModel) add('priceModel', q.priceModel === 'fixed' ? 'Fixed price' : 'Quotation only'); if (q.inStock) add('inStock', 'In stock'); if (q.founding) add('founding', 'Founding Sellers');
  if (q.min || q.max) add('price', `KSh ${q.min || '0'} to ${q.max || 'any'}`);
  return out.length ? out.join('') + '<button type="button" class="linkbtn" data-act="clear-filters">Clear all</button>' : '';
}
const activeCount = (q) => ['category', 'seller', 'priceModel', 'inStock', 'founding'].filter((k) => q[k]).length + (q.min || q.max ? 1 : 0);

route('/products', async ({ query }) => {
  const q = clean(query);
  const [res, fac] = await Promise.all([get('/api/products?' + apiQS(q, { limit: 24 })), get('/api/products/facets?' + apiQS(q))]);
  const cur = fac.categories.find((c) => c.slug === q.category);
  return { title: cur?.name || 'Products', html: `<div class="wrap page plp-page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a> / <span aria-current="page">Products</span></nav>
    <div class="plp-head"><div><h1>${esc(cur?.name || 'All products')}</h1><p class="muted" id="plp-count" role="status" aria-live="polite"></p></div>
      <div class="plp-tools"><button type="button" class="btn btn-outline plp-fbtn" data-act="open-filters" aria-haspopup="dialog" aria-controls="fdlg">${I.filter} Filters <span class="badge-n" id="fcount" hidden></span></button>
        <label class="sortsel"><span class="muted small">Sort by</span><select class="input" id="sort">${SORT.map(([v, t]) => `<option value="${v}" ${(q.sort || 'newest') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div></div>
    <div class="chips" id="chips" aria-label="Active filters"></div>
    <div class="plp"><dialog id="fdlg" class="facets" aria-label="Filters"><div class="facets-top"><h2>Filters</h2><button type="button" class="icon-btn" data-act="close-filters" aria-label="Close filters">${I.close}</button></div>
        <form id="ff" novalidate><label class="field"><span>Search</span><input class="input" type="search" name="q" value="${esc(q.q || '')}" placeholder="Name or brand"></label><div id="facet-body">${facetsHTML(fac, q)}</div></form>
        <div class="facets-foot"><button type="button" class="btn btn-ghost" data-act="clear-filters">Clear all</button><button type="button" class="btn btn-primary" data-act="close-filters" id="show-n">Show results</button></div></dialog>
      <section class="plp-main" aria-label="Products"><div class="pgrid" id="grid"></div><div id="more" class="more"></div></section></div></div>`,
    after() { listing(q, res, fac); } };
});

function listing(q0, first, fac0) {
  let q = { ...q0 }, offset = 0, total = first.total, token = 0, timer = 0;
  const $ = (s) => document.querySelector(s), grid = $('#grid'), form = $('#ff'), dlg = $('#fdlg');
  const paint = (products, append) => { const h = products.map((p) => productCard(p)).join(''); if (append) grid.insertAdjacentHTML('beforeend', h); else grid.innerHTML = h || emptyState('No products match these filters', 'Try removing a filter or widening the price range.', '<button class="btn btn-primary" data-act="clear-filters">Clear all filters</button>'); };
  const summary = (f) => {
    $('#plp-count').textContent = `${plural(total, 'listing', 'listings')} from approved sellers`;
    $('#chips').innerHTML = chipsHTML(q, f); const n = activeCount(q), fc = $('#fcount'); fc.hidden = !n; fc.textContent = n;
    $('#show-n').textContent = `Show ${plural(total, 'result', 'results')}`;
    const m = $('#more'); m.innerHTML = offset + 24 < total ? `<button class="btn btn-outline" data-act="load-more">Show more (${total - offset - 24} left)</button>` : '';
  };
  paint(first.products); summary(fac0);
  // keep the facet panel in sync without re-creating it, so the keyboard focus stays where it was
  const syncFacets = (f) => {
    const body = $('#facet-body'); const keep = document.activeElement; const key = keep?.name ? `${keep.name}|${keep.value}` : null;
    const open = [...body.querySelectorAll('details')].map((d) => d.open); body.innerHTML = facetsHTML(f, q); body.querySelectorAll('details').forEach((d, i) => (d.open = open[i] ?? true));
    if (key) { const [n, v] = key.split('|'); [...body.querySelectorAll('input')].find((i) => i.name === n && i.value === v)?.focus({ preventScroll: true }); }
    document.querySelector('h1').textContent = f.categories.find((c) => c.slug === q.category)?.name || 'All products';
  };
  const refresh = async () => {
    const t = ++token; grid.setAttribute('aria-busy', 'true'); grid.classList.add('busy'); offset = 0;
    try {
      const [res, fac] = await Promise.all([get('/api/products?' + apiQS(q, { limit: 24 })), get('/api/products/facets?' + apiQS(q))]); if (t !== token) return;
      total = res.total; paint(res.products); syncFacets(fac); summary(fac); announce(`${plural(total, 'result', 'results')}.`);
    } catch (e) { toast(e.message || 'Could not update the results.', 'bad'); } finally { if (t === token) { grid.removeAttribute('aria-busy'); grid.classList.remove('busy'); } }
  };
  const push = () => { q = clean(q); const s = new URLSearchParams(q).toString(); history.pushState(null, '', '#/products' + (s ? '?' + s : '')); refresh(); };
  const read = () => { const d = new FormData(form); const n = { sort: q.sort }; for (const k of ['q', 'category', 'seller', 'priceModel', 'inStock', 'founding']) { const v = String(d.get(k) || '').trim(); if (v) n[k] = v; } for (const k of ['min', 'max']) { const v = String(d.get(k) || '').replace(/[^\d]/g, ''); if (v) n[k] = v; } q = n; };
  form.addEventListener('input', (e) => { if (e.target.type === 'search' || e.target.name === 'min' || e.target.name === 'max') { clearTimeout(timer); timer = setTimeout(() => { read(); push(); }, 450); } });
  form.addEventListener('change', (e) => { if (e.target.type === 'search' || e.target.name === 'min' || e.target.name === 'max') return; read(); push(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); read(); push(); });
  $('#sort').addEventListener('change', (e) => { q.sort = e.target.value === 'newest' ? '' : e.target.value; push(); });
  listing.api = {
    clear() { q = { sort: q.sort }; form.reset(); push(); },
    drop(k) { if (k === 'price') { delete q.min; delete q.max; } else delete q[k]; push(); },
    async more() { offset += 24; const res = await get('/api/products?' + apiQS(q, { limit: 24, offset })); paint(res.products, true); const m = $('#more'); m.innerHTML = offset + 24 < total ? `<button class="btn btn-outline" data-act="load-more">Show more (${total - offset - 24} left)</button>` : ''; announce(`${res.products.length} more products loaded.`); },
  };
  // On wide screens the filters sit beside the results. On phones the same panel is a modal bottom sheet (focus is trapped, Escape closes it).
  const mq = matchMedia('(min-width: 961px)'); const place = () => { if (mq.matches) { if (!dlg.open) dlg.show(); else if (dlg.matches(':modal')) { dlg.close(); dlg.show(); } } else if (dlg.open && !dlg.matches(':modal')) dlg.close(); };
  const keepFocus = document.activeElement; place(); if (document.activeElement !== keepFocus) { document.activeElement?.blur?.(); keepFocus?.focus?.({ preventScroll: true }); } mq.addEventListener('change', place);
}
actions['open-filters'] = () => { const d = document.getElementById('fdlg'); if (d && !d.open) d.showModal(); document.body.classList.add('lock'); d?.addEventListener('close', () => document.body.classList.remove('lock'), { once: true }); };
actions['close-filters'] = () => { const d = document.getElementById('fdlg'); if (d?.matches(':modal')) d.close(); };
actions['clear-filters'] = () => listing.api?.clear();
actions['chip-x'] = (el) => listing.api?.drop(el.dataset.k);
actions['load-more'] = () => listing.api?.more();
actions['facet-more'] = (el) => { const b = el.closest('.fg-b'); const on = b.classList.toggle('all'); el.setAttribute('aria-expanded', String(on)); el.textContent = on ? 'Show fewer suppliers' : 'Show all suppliers'; };
document.addEventListener('click', (e) => { const d = e.target; if (d instanceof HTMLDialogElement && d.matches(':modal')) d.close(); });

// ---------------------------------------------------------------- media gallery: zoom, lightbox, video and 360 spin
const isVideo = (u) => /\.(mp4|webm)(\?|#|$)/i.test(u);
function mediaFor(p) {
  const out = [];
  for (const u of p.images || []) {
    if (/\{n\}/.test(u)) { const fr = parseInt((u.split('#frames=')[1] || '24'), 10) || 24; out.push({ kind: 'spin', tpl: u.split('#')[0], n: Math.min(72, Math.max(8, fr)) }); }
    else if (isVideo(u)) out.push({ kind: 'video', src: u });
    else out.push({ kind: 'img', src: u });
  }
  if (!out.length) out.push({ kind: 'art' });
  return out;
}
let G = { media: [], i: 0, p: null };
const frameUrl = (m, k) => m.tpl.replace('{n}', String(k).padStart(2, '0'));
function stageHTML(m, p, { big = false } = {}) {
  const alt = `${p.name}, view ${G.i + 1} of ${G.media.length}`;
  if (m.kind === 'img') return `<div class="zoom-inner"><img src="${esc(m.src)}" alt="${esc(alt)}" ${big ? '' : 'fetchpriority="high"'} decoding="async"></div>`;
  if (m.kind === 'art') return `<div class="zoom-inner">${artFor(p)}</div>`;
  if (m.kind === 'video') return `<video class="gal-video" controls playsinline muted preload="metadata" aria-label="${esc(p.name)} video"><source src="${esc(m.src)}"></video>`;
  return `<div class="spin" tabindex="0" role="group" aria-roledescription="360 degree viewer" aria-label="${esc(p.name)} 360 degree view. Drag, or use the left and right arrow keys, to rotate."><img src="${esc(frameUrl(m, 1))}" alt="${esc(p.name)}, rotating view" draggable="false"><span class="spin-hint" aria-hidden="true">Drag to rotate</span><span class="spin-load" aria-hidden="true">Loading 0%</span></div>`;
}
function thumbHTML(m, p, i) {
  const inner = m.kind === 'img' ? `<img src="${esc(m.src)}" alt="" loading="lazy">` : m.kind === 'art' ? artFor(p) : m.kind === 'video' ? `<span class="tbadge">${I.play}</span>` : `<span class="tbadge">360°</span>`;
  return `<li><button type="button" class="gthumb" data-act="gal-thumb" data-i="${i}" aria-label="${m.kind === 'video' ? 'Play video' : m.kind === 'spin' ? '360 degree view' : `Show image ${i + 1} of ${G.media.length}`}" aria-current="${i === G.i}">${inner}</button></li>`;
}
function initSpin(root, m) {
  const img = root.querySelector('img'), load = root.querySelector('.spin-load'); const frames = []; let k = 0, done = 0;
  for (let n = 1; n <= m.n; n++) { const im = new Image(); im.onload = im.onerror = () => { done++; load.textContent = `Loading ${Math.round((done / m.n) * 100)}%`; if (done === m.n) load.remove(); }; im.src = frameUrl(m, n); frames.push(im.src); }
  const show = (n) => { k = ((n % m.n) + m.n) % m.n; img.src = frames[k]; }; let x0 = null, acc = 0, raf = 0;
  root.addEventListener('pointerdown', (e) => { x0 = e.clientX; root.setPointerCapture(e.pointerId); root.classList.add('drag'); });
  root.addEventListener('pointermove', (e) => { if (x0 == null) return; acc += e.clientX - x0; x0 = e.clientX; if (!raf) raf = requestAnimationFrame(() => { raf = 0; const st = Math.trunc(acc / 9); if (st) { show(k - st); acc -= st * 9; } }); });
  const end = () => { x0 = null; root.classList.remove('drag'); }; root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
  root.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { show(k - 1); e.preventDefault(); } if (e.key === 'ArrowRight') { show(k + 1); e.preventDefault(); } });
}
function mountStage(host, big) { const m = G.media[G.i]; host.innerHTML = stageHTML(m, G.p, { big }); const s = host.querySelector('.spin'); if (s) initSpin(s, m); host.dataset.kind = m.kind; }
function setImage(i, focus) {
  G.i = (i + G.media.length) % G.media.length; const st = document.getElementById('gstage'); if (st) mountStage(st.querySelector('.gal-view'), false);
  document.querySelectorAll('.gthumb').forEach((b) => b.setAttribute('aria-current', String(+b.dataset.i === G.i)));
  const lb = document.getElementById('lbox'); if (lb) { mountStage(lb.querySelector('.lb-view'), true); lb.querySelector('.lb-count').textContent = `${G.i + 1} / ${G.media.length}`; }
  announce(`Image ${G.i + 1} of ${G.media.length}`);
}
actions['gal-thumb'] = (el) => setImage(+el.dataset.i);
actions['gal-open'] = () => {
  if (G.media[G.i].kind === 'video') return; const lb = document.createElement('dialog'); lb.id = 'lbox'; lb.className = 'lbox'; lb.setAttribute('aria-label', `${G.p.name} images`);
  lb.innerHTML = `<div class="lb-top"><span class="lb-count" aria-live="polite"></span><button type="button" class="icon-btn" data-act="lb-close" aria-label="Close enlarged view">${I.close}</button></div><div class="lb-view zoomable" data-lb></div>
    ${G.media.length > 1 ? `<button type="button" class="lb-nav prev icon-btn" data-act="lb-prev" aria-label="Previous image">${I.left}</button><button type="button" class="lb-nav next icon-btn" data-act="lb-next" aria-label="Next image">${I.right}</button>` : ''}<p class="lb-hint">Click the image to zoom. Use the arrow keys to move between images.</p>`;
  document.body.appendChild(lb); lb.showModal(); document.body.classList.add('lock'); mountStage(lb.querySelector('.lb-view'), true); lb.querySelector('.lb-count').textContent = `${G.i + 1} / ${G.media.length}`;
  lb.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') setImage(G.i - 1); if (e.key === 'ArrowRight') setImage(G.i + 1); });
  lb.addEventListener('close', () => { lb.remove(); document.body.classList.remove('lock'); }); lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
};
actions['lb-close'] = () => document.getElementById('lbox')?.close(); actions['lb-prev'] = () => setImage(G.i - 1); actions['lb-next'] = () => setImage(G.i + 1);
// hover zoom (mouse only) and click-to-zoom inside the lightbox
document.addEventListener('pointermove', (e) => {
  const st = e.target.closest?.('#gstage .gal-view'); if (!st || e.pointerType !== 'mouse' || !['img', 'art'].includes(st.dataset.kind)) return;
  const r = st.getBoundingClientRect(); st.style.setProperty('--zx', ((e.clientX - r.left) / r.width) * 100 + '%'); st.style.setProperty('--zy', ((e.clientY - r.top) / r.height) * 100 + '%'); st.classList.add('zoom');
});
document.addEventListener('pointerout', (e) => { const st = e.target.closest?.('#gstage .gal-view'); if (st && !st.contains(e.relatedTarget)) st.classList.remove('zoom'); });
document.addEventListener('click', (e) => { const v = e.target.closest?.('[data-lb]'); if (!v || !['img', 'art'].includes(v.dataset.kind)) return; const r = v.getBoundingClientRect(); v.style.setProperty('--zx', ((e.clientX - r.left) / r.width) * 100 + '%'); v.style.setProperty('--zy', ((e.clientY - r.top) / r.height) * 100 + '%'); v.classList.toggle('zoom'); });

// ---------------------------------------------------------------- product page
const DELIVERY = { delivery: 'Delivery only', collection: 'Collection only', both: 'Delivery or collection' };
route('/product/:id', async ({ params }) => {
  const { product: p } = await get('/api/products/' + params.id);
  const rel = (await get('/api/products?' + new URLSearchParams({ category: p.category.slug, limit: '5' }))).products.filter((x) => x.id !== p.id).slice(0, 4);
  G = { media: mediaFor(p), i: 0, p };
  const out = p.stockStatus === 'out_of_stock', fixed = p.priceModel === 'fixed', st = stockText[p.stockStatus] || ['', ''];
  const img0 = G.media[0].kind === 'img' ? G.media[0].src : '';
  const specs = [['Unit of measure', esc(p.unit)], ['Minimum order', String(p.moq)], ['Availability', `<span class="stock ${st[1]}">${st[0]}</span>`], ['Fulfilment', DELIVERY[p.deliveryOptions] || ''], ['Country of origin', esc(p.originCountry || '')], ['Condition', 'New'], ...(p.specs || []).filter((s) => !/^(condition|unit|origin)/i.test(s.label)).map((s) => [esc(s.label), esc(s.value)])].filter((r) => r[1]);
  const buy = fixed ? `<div class="buy"><div class="buy-price"><span class="price xl">${money(p.unitPriceMinor)}</span><span class="muted">per ${esc(p.unit)}</span></div><p class="small muted">Minimum order ${p.moq} ${esc(p.unit)}${p.moq > 1 ? 's' : ''}${p.stockQty != null ? ` · ${p.stockQty} available` : ''}</p>
      <div class="qty-row"><div class="qty"><button type="button" class="qb" data-act="qty-dec" aria-label="Decrease quantity" ${out ? 'disabled' : ''}>${I.minus}</button><label class="sr" for="qty">Quantity</label><input class="qin" id="qty" type="number" inputmode="numeric" min="${p.moq}" step="1" value="${p.moq}" ${out ? 'disabled' : ''} data-unit="${p.unitPriceMinor}" data-moq="${p.moq}"><button type="button" class="qb" data-act="qty-inc" aria-label="Increase quantity" ${out ? 'disabled' : ''}>${I.plus}</button></div>
        <div class="line-total"><span class="tiny muted">Line total</span><b id="line-total">${money(p.unitPriceMinor * p.moq)}</b></div></div>
      <button class="btn btn-accent btn-lg block" id="add-main" data-act="add-to-cart" data-id="${esc(p.id)}" data-moq="${p.moq}" data-name="${esc(p.name)}" ${out ? 'disabled' : ''}>${out ? 'Out of stock' : `${I.cart} Add to cart`}</button>
      <p class="tiny muted">Delivery is priced in your cart. ${p.deliveryOptions === 'delivery' ? 'Collection is not offered.' : 'Collection from the supplier is available.'}</p></div>`
    : `<form class="buy" data-form="quote" data-product="${esc(p.id)}" id="quote-form" novalidate><div class="buy-price"><span class="price xl">Quotation</span></div><p class="small muted">Send your quantity and site details. The supplier replies with a price you can accept as an official order.</p>
      <div class="grid2">${field('Quantity', 'quantity', { type: 'number', value: p.moq, req: true, attrs: `min="${p.moq}" step="1"` })}${field('Needed by', 'neededBy', { type: 'date' })}</div>${selectField('Delivery or collection', 'deliveryMethod', [['delivery', 'Delivery to my site'], ['collection', 'Collect from supplier']], 'delivery')}${field('Delivery location', 'deliveryLocation', { ph: 'County and town' })}${textField('Notes for the supplier', 'notes', { rows: 3, ph: 'Site access, hours, financing' })}
      <p class="err" data-form-error role="alert"></p><button class="btn btn-primary btn-lg block" id="add-main" type="submit">Request quotation</button><p class="tiny muted">You need a buyer account to send a request.</p></form>`;
  return { title: p.name, html: `<div class="wrap page pdp">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a> / <a href="#/products?category=${esc(p.category.slug)}">${esc(p.category.name)}</a> / <span aria-current="page">${esc(p.name)}</span></nav>
    <div class="pdp-grid"><div class="gal"><div class="gal-stage" id="gstage"><div class="gal-view zoomable" data-kind="${G.media[0].kind}">${stageHTML(G.media[0], p)}</div>${['img', 'art', 'spin'].includes(G.media[0].kind) ? `<button type="button" class="gal-open icon-btn" data-act="gal-open" aria-label="Open larger view of ${esc(p.name)}">${I.expand}</button>` : ''}<span class="gal-tip" aria-hidden="true">Hover to zoom</span></div>
        ${G.media.length > 1 ? `<ul class="gal-thumbs" role="list">${G.media.map((m, i) => thumbHTML(m, p, i)).join('')}</ul>` : ''}</div>
      <div class="pdp-info"><div class="row"><span class="tag">${esc(p.category.name)}</span>${p.seller.founding ? '<span class="tag accent">Founding Seller</span>' : ''}<span class="tag ok">${I.check} Verified supplier</span></div>
        <h1>${esc(p.name)}</h1>${p.brand ? `<p class="muted">Brand: ${esc(p.brand)}</p>` : ''}
        <a class="supplier" href="#/supplier/${esc(p.seller.slug)}"><span class="mono-tile sm" aria-hidden="true">${esc(initials(p.seller.name))}</span><span><b>${esc(p.seller.name)}</b><span class="small muted">${esc(p.seller.town || p.seller.region || 'Kenya')}</span></span><span class="go"><span class="go-t">View supplier</span> ${I.arrow}</span></a>
        ${buy}
        <button type="button" class="btn btn-outline block" data-act="cmp-btn" data-cmp-btn data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-cat="${esc(p.category.slug)}" data-img="${esc(img0)}" aria-pressed="${compare.has(p.id)}">${I.compare} <span>${compare.has(p.id) ? 'In comparison' : 'Add to compare'}</span></button>
        <ul class="trust-list"><li>${I.check} Pay with M-Pesa or card inside BonasHub</li><li>${I.check} An order is marked paid only when the payment is verified</li><li>${I.check} Track dispatch and delivery from your account</li></ul></div></div>
    <div class="pdp-more"><div><details class="acc" open><summary>Specifications</summary><div class="acc-b">${specs.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('')}</div></details>
        ${p.description ? `<details class="acc" open><summary>Description</summary><div class="acc-b"><p style="white-space:pre-wrap">${esc(p.description)}</p></div></details>` : ''}
        <details class="acc"><summary>Delivery, payment and returns</summary><div class="acc-b"><p>Delivery cost is calculated per supplier in your cart. Pay by M-Pesa or card; the order moves forward only after the provider confirms the payment. If an order arrives wrong or damaged, report it from your order page within the dispute window and BonasHub will review it.</p></div></details></div></div>
    ${rel.length ? `<section class="pdp-rel" aria-labelledby="rel-h"><h2 id="rel-h">More in ${esc(p.category.name)}</h2><div class="pgrid four">${rel.map((x) => productCard(x)).join('')}</div></section>` : ''}
    ${fixed ? `<div class="buybar" id="buybar" aria-hidden="true"><div class="wrap bb-in"><div class="bb-t"><b>${esc(p.name)}</b><span class="price">${money(p.unitPriceMinor)}</span></div><button class="btn btn-accent" data-act="add-to-cart" data-id="${esc(p.id)}" data-moq="${p.moq}" data-name="${esc(p.name)}" tabindex="-1" ${out ? 'disabled' : ''}>${out ? 'Out of stock' : 'Add to cart'}</button></div></div>` : `<div class="buybar" id="buybar" aria-hidden="true"><div class="wrap bb-in"><div class="bb-t"><b>${esc(p.name)}</b><span class="muted small">Quotation</span></div><a class="btn btn-primary" href="#quote-form" data-act="to-quote" tabindex="-1">Request quotation</a></div></div>`}
  </div>`,
  after() {
    const main = document.getElementById('add-main'), bar = document.getElementById('buybar');
    if (main && bar && 'IntersectionObserver' in window) { const io = new IntersectionObserver(([e]) => { const on = !e.isIntersecting && e.boundingClientRect.top < 0; bar.classList.toggle('on', on); bar.setAttribute('aria-hidden', String(!on)); bar.querySelectorAll('a,button').forEach((x) => (x.tabIndex = on ? 0 : -1)); }); io.observe(main); }
    const s = document.querySelector('#gstage .spin'); if (s) initSpin(s, G.media[0]);
    const q = document.getElementById('qty'); q?.addEventListener('input', totalUpdate);
  } };
});
function totalUpdate() { const q = document.getElementById('qty'); if (!q) return; const n = Math.max(0, parseInt(q.value, 10) || 0); document.getElementById('line-total').textContent = money(n * Number(q.dataset.unit)); }
actions['qty-inc'] = () => { const q = document.getElementById('qty'); q.value = (parseInt(q.value, 10) || 0) + 1; totalUpdate(); };
actions['qty-dec'] = () => { const q = document.getElementById('qty'), m = parseInt(q.dataset.moq, 10); q.value = Math.max(m, (parseInt(q.value, 10) || m) - 1); totalUpdate(); };
actions['to-quote'] = (el, e) => { e?.preventDefault?.(); const f = document.getElementById('quote-form'); f?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); f?.querySelector('input')?.focus({ preventScroll: true }); };
actions['add-to-cart'] = (el) => {
  const q = document.getElementById('qty'); const qty = parseInt(q?.value, 10), moq = parseInt(el.dataset.moq, 10);
  if (!Number.isInteger(qty) || qty < moq) { toast(`Minimum order is ${moq}.`, 'bad'); q?.focus(); return; }
  cart.add(el.dataset.id, qty); toast('Added to your cart.', 'ok'); announce(`${qty} of ${el.dataset.name || 'item'} added to your cart. ${cart.count()} items in the cart.`);
};
forms.quote = async (v, form) => {
  if (!store.user) { go('/login?next=' + encodeURIComponent(location.hash.slice(1))); toast('Sign in as a buyer to request a quotation.'); return; }
  if (store.user.role !== 'buyer') throw new ApiError(403, 'forbidden', 'Only buyer accounts can request quotations.');
  await post('/api/quotes', { productId: form.dataset.product, quantity: parseInt(v.quantity, 10), deliveryMethod: v.deliveryMethod, deliveryLocation: v.deliveryLocation || undefined, neededBy: v.neededBy || undefined, notes: v.notes || undefined });
  toast('Quotation request sent. You will be notified when the supplier replies.', 'ok'); go('/account/quotes');
};

// ---------------------------------------------------------------- compare page
route('/compare', async ({ query }) => {
  const ids = (query.ids ? query.ids.split(',') : compare.items().map((x) => x.id)).filter(Boolean).slice(0, CMP_MAX);
  if (ids.length < 2) return { title: 'Compare', html: `<div class="wrap page"><h1>Compare products</h1>${emptyState('Pick at least two products', 'Tick “Compare” on any product card, then open the comparison.', '<a class="btn btn-primary" href="#/products">Browse products</a>')}</div>` };
  const { products } = await get('/api/products?' + new URLSearchParams({ ids: ids.join(','), limit: String(CMP_MAX) }));
  const order = ids.map((id) => products.find((p) => p.id === id)).filter(Boolean);
  const specKeys = [...new Set(order.flatMap((p) => (p.specs || []).map((s) => s.label)))];
  const rows = [
    ['Overview', [['Price', (p) => (p.priceModel === 'quote' ? 'Quotation' : `${money(p.unitPriceMinor)} per ${p.unit}`)], ['Minimum order', (p) => `${p.moq} ${p.unit}`], ['Availability', (p) => (stockText[p.stockStatus] || [''])[0]], ['Fulfilment', (p) => DELIVERY[p.deliveryOptions] || ''], ['Origin', (p) => p.originCountry || '—'], ['Brand', (p) => p.brand || '—']]],
    ['Supplier', [['Supplier', (p) => p.seller.name], ['Location', (p) => p.seller.town || p.seller.region || 'Kenya'], ['Founding Seller', (p) => (p.seller.founding ? 'Yes' : 'No')]]],
    ...(specKeys.length ? [['Specifications', specKeys.map((k) => [k, (p) => (p.specs || []).find((s) => s.label === k)?.value || '—'])]] : []),
  ];
  const diffRow = (f) => new Set(order.map((p) => f(p))).size > 1;
  return { title: 'Compare products', html: `<div class="wrap page cmp-page"><div class="row between"><div><h1>Compare products</h1><p class="muted">${order.length} products side by side</p></div><label class="switch"><input type="checkbox" id="diff-only"> <span>Show differences only</span></label></div>
    <div class="cmp-scroll" tabindex="0" role="region" aria-label="Comparison table, scrolls sideways on small screens"><table class="cmp-table"><caption class="sr">Side-by-side comparison of ${order.map((p) => esc(p.name)).join(', ')}</caption>
      <thead><tr><th scope="col"><span class="sr">Attribute</span></th>${order.map((p) => `<th scope="col"><div class="cmp-head"><div class="cmp-art">${thumb(p)}</div><a href="#/product/${esc(p.id)}"><b>${esc(p.name)}</b></a><span class="price">${priceOf(p)}</span><div class="cmp-act">${p.priceModel === 'fixed' ? `<button class="btn btn-accent btn-sm" data-act="cmp-add" data-id="${esc(p.id)}" data-moq="${p.moq}" data-name="${esc(p.name)}">Add to cart</button>` : `<a class="btn btn-primary btn-sm" href="#/product/${esc(p.id)}">Request quote</a>`}<button class="btn btn-ghost btn-sm" data-act="cmp-drop" data-id="${esc(p.id)}">Remove</button></div></div></th>`).join('')}</tr></thead>
      ${rows.map(([g, rs]) => `<tbody><tr class="grp"><th scope="rowgroup" colspan="${order.length + 1}">${esc(g)}</th></tr>${rs.map(([k, f]) => `<tr class="${diffRow(f) ? 'diff' : 'same'}"><th scope="row">${esc(k)}</th>${order.map((p) => `<td>${esc(f(p))}</td>`).join('')}</tr>`).join('')}</tbody>`).join('')}</table></div></div>`,
    after() { const t = document.querySelector('.cmp-table'); document.getElementById('diff-only').addEventListener('change', (e) => { t.classList.toggle('only-diff', e.target.checked); announce(e.target.checked ? 'Showing differences only.' : 'Showing all rows.'); }); } };
});
actions['cmp-add'] = (el) => { cart.add(el.dataset.id, parseInt(el.dataset.moq, 10)); toast('Added to your cart.', 'ok'); announce(`${el.dataset.name} added to your cart.`); };
actions['cmp-drop'] = (el) => { compare.remove(el.dataset.id); const ids = compare.items().map((x) => x.id); go('/compare' + (ids.length ? '?ids=' + ids.join(',') : '')); };

// ---------------------------------------------------------------- featured deck: a pile of cards. The top card flies off, the next one comes forward.
const deckCard = (p, i) => {
  const st = stockText[p.stockStatus] || [String(p.stockStatus || '').replace(/_/g, ' '), ''];
  const img = p.images?.[0] && !/\{n\}/.test(p.images[0]) && !isVideo(p.images[0]) ? p.images[0] : '';
  return `<article class="dcard" data-i="${i}" role="group" aria-roledescription="slide"><a class="dcard-media" href="#/product/${esc(p.id)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a>
    <div class="dcard-body"><span class="tiny muted">${esc(p.category?.name)}</span><h3><a href="#/product/${esc(p.id)}" class="dlink">${esc(p.name)}</a></h3>
      <span class="small muted">${esc(p.seller?.name)}${p.seller?.town ? ' · ' + esc(p.seller.town) : ''}</span>
      <div class="dprice"><span class="price xl">${priceOf(p)}</span><span class="tiny muted">${p.priceModel === 'fixed' ? `per ${esc(p.unit)} · MOQ ${p.moq}` : 'Delivery negotiated'}</span></div>
      <div class="row">${p.seller?.founding ? '<span class="tag accent">Founding Seller</span>' : ''}<span class="stock ${st[1]}">${st[0]}</span></div>
      <div class="dact"><a class="btn btn-primary dlink" href="#/product/${esc(p.id)}">${p.priceModel === 'quote' ? 'Request quotation' : 'View product'} ${I.arrow}</a>
        <label class="cmp"><input type="checkbox" class="dlink" data-cmp="${esc(p.id)}" data-name="${esc(p.name)}" data-cat="${esc(p.category?.slug || '')}" data-img="${esc(img)}" ${compare.has(p.id) ? 'checked' : ''}><span>Compare<span class="sr"> ${esc(p.name)}</span></span></label></div></div></article>`;
};
export const featuredDeck = (list) => `<div class="deck" id="deck" role="region" aria-roledescription="carousel" aria-label="Featured products" tabindex="0"><div class="deck-stage">${list.map(deckCard).join('')}</div>
  <div class="deck-ctl"><button type="button" class="icon-btn" data-act="deck-prev" aria-label="Previous product">${I.left}</button><span class="deck-count" id="deck-count" aria-live="polite"></span><button type="button" class="icon-btn" data-act="deck-next" aria-label="Next product">${I.right}</button></div></div>`;
const D = { cur: 0, busy: false };
const deckEls = () => [...document.querySelectorAll('#deck .dcard')];
function deckRender() {
  const els = deckEls(), n = els.length;
  els.forEach((el, i) => { const pos = (i - D.cur + n) % n; el.dataset.pos = pos > 3 ? 3 : pos; el.setAttribute('aria-hidden', String(pos !== 0)); el.setAttribute('aria-label', `${i + 1} of ${n}`); el.querySelectorAll('.dlink').forEach((x) => (x.tabIndex = pos === 0 ? 0 : -1)); el.style.zIndex = String(n - pos); });
  const c = document.getElementById('deck-count'); if (c) c.textContent = `${D.cur + 1} of ${n}`;
}
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function deckTo(delta) {
  const els = deckEls(), n = els.length; if (n < 2 || D.busy) return; D.busy = true;
  if (delta > 0) {
    const top = els[D.cur]; top.classList.add('fly'); D.cur = (D.cur + delta) % n; deckRender(); top.dataset.pos = 3;
    setTimeout(() => { top.classList.add('snap'); top.classList.remove('fly'); void top.offsetWidth; top.classList.remove('snap'); D.busy = false; }, REDUCED() ? 0 : 480);
  } else {
    const back = els[(D.cur - 1 + n) % n]; back.classList.add('snap', 'fly'); void back.offsetWidth; back.classList.remove('snap'); D.cur = (D.cur - 1 + n) % n; deckRender(); back.classList.remove('fly');
    setTimeout(() => (D.busy = false), REDUCED() ? 0 : 480);
  }
  announce(`Product ${D.cur + 1} of ${n}`);
}
actions['deck-next'] = () => deckTo(1); actions['deck-prev'] = () => deckTo(-1);
export function initDeck() {
  const deck = document.getElementById('deck'); if (!deck) return; D.cur = 0; D.busy = false; deckRender();
  deck.addEventListener('keydown', (e) => { if (e.target !== deck) return; if (e.key === 'ArrowRight') { deckTo(1); e.preventDefault(); } if (e.key === 'ArrowLeft') { deckTo(-1); e.preventDefault(); } });
  // tap a card in the pile to bring it forward; swipe the top card to send it away
  let x0 = null, moved = false;
  deck.addEventListener('pointerdown', (e) => { x0 = e.clientX; moved = false; });
  deck.addEventListener('pointermove', (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 8) moved = true; });
  deck.addEventListener('pointerup', (e) => { if (x0 == null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 50) deckTo(dx < 0 ? 1 : -1); });
  deck.addEventListener('click', (e) => {
    if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; return; }
    const c = e.target.closest('.dcard'); if (!c || c.dataset.pos === '0') return; e.preventDefault();
    const n = deckEls().length, pos = (+c.dataset.i - D.cur + n) % n; if (pos === 1) deckTo(1); else if (pos === n - 1) deckTo(-1); else { D.cur = (+c.dataset.i - 1 + n) % n; deckTo(1); }
  }, true);
}
