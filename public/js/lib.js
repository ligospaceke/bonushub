// Shared helpers: escaping, formatting, API client, cart, toasts, modal, action registry, router.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (m) => 'KSh ' + ((m || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: (m || 0) % 100 ? 2 : 0, maximumFractionDigits: 2 });
export const kes = (kesAmount) => Math.round(Number(kesAmount) * 100);          // KSh typed by a person -> minor units
export const fromMinor = (m) => (m == null ? '' : m / 100);
export const fdate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fdt = (iso) => (iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

export const STATUS = {
  awaiting_payment: ['Awaiting payment', 'warn'], payment_confirmed: ['Payment confirmed', 'info'], seller_processing: ['Seller processing', 'info'],
  ready_for_dispatch: ['Ready for dispatch', 'info'], dispatched: ['Dispatched', 'info'], delivered: ['Delivered', 'ok'], completed: ['Completed', 'ok'],
  cancelled: ['Cancelled', 'bad'], refund_requested: ['Refund requested', 'warn'], refunded: ['Refunded', 'bad'],
  pending: ['Pending', 'warn'], successful: ['Successful', 'ok'], failed: ['Failed', 'bad'], partially_refunded: ['Partly refunded', 'warn'],
  approved: ['Approved', 'ok'], rejected: ['Rejected', 'bad'], suspended: ['Suspended', 'bad'], active: ['Active', 'ok'], removed: ['Removed', 'bad'],
  requested: ['Requested', 'warn'], quoted: ['Quote received', 'info'], accepted: ['Accepted', 'ok'], declined: ['Declined', 'bad'], expired: ['Expired', 'bad'], converted: ['Ordered', 'ok'],
  processed: ['Processed', 'ok'], in_stock: ['In stock', 'ok'], low_stock: ['Low stock', 'warn'], out_of_stock: ['Out of stock', 'bad'], on_request: ['On request', 'info'],
  unsettled: ['Not settled', 'warn'], in_settlement: ['In settlement', 'info'], settled: ['Settled', 'ok'], accrued: ['Accrued', 'warn'], earned: ['Earned', 'ok'], reversed: ['Reversed', 'bad'],
};
export const badge = (s, label) => { const [t, k] = STATUS[s] || [String(s).replace(/_/g, ' '), '']; return `<span class="badge ${k}">${esc(label || t)}</span>`; };

// ---------- API ----------
export class ApiError extends Error { constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields || {}; } }
export async function api(method, path, body) {
  let res;
  try { res = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError(0, 'network', 'You appear to be offline. Check your connection and try again.'); }
  const text = await res.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { throw new ApiError(res.status, 'bad_response', 'Unexpected response from the server.'); }
  if (!j.ok) throw new ApiError(res.status, j.error?.code, j.error?.message || 'Something went wrong.', j.error?.fields);
  return j.data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

// ---------- state ----------
export const store = { user: null, notifications: 0, listeners: new Set() };
export const setUser = (u) => { store.user = u; store.listeners.forEach((f) => f()); };
export const onState = (f) => store.listeners.add(f);
export const isAdmin = () => store.user?.role === 'admin';

const CART_KEY = 'bh_cart';
export const cart = {
  items() { try { const v = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(v) ? v.filter((i) => i && typeof i.productId === 'string' && Number.isInteger(i.qty) && i.qty > 0) : []; } catch { return []; } },
  save(items) { try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch {} store.listeners.forEach((f) => f()); },
  add(productId, qty) { const it = this.items(); const x = it.find((i) => i.productId === productId); if (x) x.qty += qty; else it.push({ productId, qty }); this.save(it); },
  set(productId, qty) { this.save(this.items().map((i) => (i.productId === productId ? { ...i, qty } : i))); },
  remove(productId) { this.save(this.items().filter((i) => i.productId !== productId)); },
  clear() { this.save([]); },
  count() { return this.items().reduce((a, i) => a + i.qty, 0); },
};

// ---------- toasts & modal ----------
export function toast(msg, kind = '') {
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg; el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  document.getElementById('toasts').appendChild(el); setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 6000 : 3500);
}
export function modal(html, { onClose } = {}) {
  const root = document.getElementById('modal-root'); const prev = document.activeElement;
  root.innerHTML = `<div class="modal-back" data-act="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" tabindex="-1">${html}</div></div>`;
  const dlg = root.querySelector('.modal'); dlg.focus();
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); prev?.focus?.(); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey); root._close = close; return close;
}
export const closeModal = () => document.getElementById('modal-root')._close?.();

// ---------- actions & forms (event delegation, survives re-render) ----------
export const actions = {}; export const forms = {};
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const name = el.dataset.act;
  if (name === 'modal-backdrop') { if (e.target === el) closeModal(); return; }
  const fn = actions[name]; if (!fn) return;
  if (el.tagName === 'A' && !el.hasAttribute('href')) e.preventDefault();
  if (el.disabled || el.dataset.busy) return;
  el.dataset.busy = '1';
  try { await fn(el, e); } catch (err) { handleError(err); } finally { delete el.dataset.busy; }
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]'); if (!form) return;
  e.preventDefault(); const fn = forms[form.dataset.form]; if (!fn) return;
  const btn = form.querySelector('[type=submit]'); if (btn?.disabled) return;
  clearErrors(form); if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Please wait…'; }
  try { await fn(readForm(form), form); }
  catch (err) { showFormError(form, err); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; } }
});
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { if (el.name.endsWith('[]')) { const k = el.name.slice(0, -2); (out[k] ||= []); if (el.checked) out[k].push(el.value); } else out[el.name] = el.checked; }
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}
export function clearErrors(form) { form.querySelectorAll('[data-err]').forEach((e) => (e.textContent = '')); const fe = form.querySelector('[data-form-error]'); if (fe) fe.textContent = ''; }
export function showFormError(form, err) {
  if (!(err instanceof ApiError)) { console.error(err); toast('Something went wrong. Please try again.', 'bad'); return; }
  let shown = 0;
  for (const [k, msg] of Object.entries(err.fields || {})) { const el = form.querySelector(`[data-err="${CSS.escape(k)}"]`); if (el) { el.textContent = msg; shown++; } }
  const fe = form.querySelector('[data-form-error]');
  if (fe && (!shown || !Object.keys(err.fields || {}).length)) fe.textContent = err.message; else if (!shown) toast(err.message, 'bad');
  else form.querySelector('[data-err]:not(:empty)')?.closest('.field')?.querySelector('input,select,textarea')?.focus();
}
export function handleError(err) {
  if (err instanceof ApiError) {
    if (err.status === 401) { setUser(null); go('/login?next=' + encodeURIComponent(location.hash.slice(1) || '/')); toast('Please sign in to continue.'); return; }
    toast(err.message, 'bad');
  } else { console.error(err); toast('Something went wrong. Please try again.', 'bad'); }
}
// A form field: label, control, and a slot for the server's message.
export const field = (label, name, { type = 'text', value = '', req = false, hint = '', ph = '', attrs = '', autocomplete = '' } = {}) =>
  `<label class="field">${esc(label)}${req ? '' : ' <span class="hint">(optional)</span>'}<input class="input" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" ${req ? 'required' : ''} ${autocomplete ? `autocomplete="${autocomplete}"` : ''} ${attrs}>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}<span class="err" data-err="${name}"></span></label>`;
export const selectField = (label, name, options, value = '', { req = true } = {}) =>
  `<label class="field">${esc(label)}<select class="input" name="${name}" ${req ? 'required' : ''}>${options.map(([v, t]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><span class="err" data-err="${name}"></span></label>`;
export const textField = (label, name, { value = '', rows = 4, req = false, ph = '' } = {}) =>
  `<label class="field">${esc(label)}<textarea class="input" name="${name}" rows="${rows}" ${req ? 'required' : ''} placeholder="${esc(ph)}">${esc(value)}</textarea><span class="err" data-err="${name}"></span></label>`;

// ---------- router ----------
export const go = (path) => { if (location.hash === '#' + path) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = path; };
const routes = [];
export function route(pattern, handler, opts = {}) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/?]+)'; }) + '/?$');
  routes.push({ re, keys, handler, opts });
}
export function resolve(hashPath) {
  const [path, qs] = hashPath.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { const m = r.re.exec(path); if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), query, path }; }
  return null;
}
export const skeleton = (n = 3) => `<div class="wrap page"><div class="skeleton" style="height:34px;width:40%;margin-bottom:20px"></div>${Array.from({ length: n }, () => '<div class="skeleton" style="height:84px;margin-bottom:14px"></div>').join('')}</div>`;
export const emptyState = (title, body = '', cta = '') => `<div class="empty card"><h3 style="color:var(--text)">${esc(title)}</h3>${body ? `<p class="mt">${body}</p>` : ''}${cta ? `<p class="mt">${cta}</p>` : ''}</div>`;
export const table = (cols, rows, { empty = 'Nothing here yet.' } = {}) => rows.length
  ? `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : emptyState(empty);
export const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${v}</span></div>`;
