import { esc, store, cart, actions, go, post, setUser, toast, get } from './lib.js';

const ICON = {
  sun: '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  cart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
};

export const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'light';
export function applyTheme(t, { save = true, animate = true } = {}) {
  const root = document.documentElement;
  if (animate) { root.classList.add('theme-fade'); setTimeout(() => root.classList.remove('theme-fade'), 400); }
  root.setAttribute('data-theme', t);
  if (save) { try { localStorage.setItem('bh_theme', t); } catch {} }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0C1117' : '#12315C');
  const b = document.getElementById('theme-btn');
  if (b) { b.setAttribute('aria-pressed', String(t === 'dark')); b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); b.title = b.getAttribute('aria-label'); }
}
// Follow the system theme only until the person chooses one themselves.
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { if (!localStorage.getItem('bh_theme')) applyTheme(e.matches ? 'dark' : 'light', { save: false }); }); } catch {}

actions['toggle-theme'] = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
actions['toggle-menu'] = (el) => { const open = document.querySelector('nav.main').classList.toggle('open'); el.setAttribute('aria-expanded', String(open)); };
actions['logout'] = async () => { await post('/api/auth/logout'); setUser(null); store.notifications = 0; toast('Signed out.'); go('/'); };

export function dashboardPath() { const r = store.user?.role; return r === 'admin' ? '/admin' : r === 'seller' ? '/seller' : '/account'; }

export function renderHeader(path = '/') {
  const u = store.user, role = u?.role;
  const link = (href, label, match) => `<a href="#${href}" ${match(path) ? 'aria-current="page"' : ''}>${label}</a>`;
  const showCart = !role || role === 'buyer';
  const html = `
  <div class="topbar"><div class="wrap"><span>Connecting businesses. Enabling trade. Tracking transactions.</span><span class="hide-sm">Kenya · KSh · <a href="#/how-it-works">Need help?</a></span></div></div>
  <header class="site"><div class="wrap">
    <a class="logo" href="#/" aria-label="BonasHub home"><span class="mark" aria-hidden="true">B</span><span>Bonas<b>Hub</b></span></a>
    <nav class="main" aria-label="Main">
      ${link('/', 'Home', (p) => p === '/')}${link('/products', 'Products', (p) => p.startsWith('/products') || p.startsWith('/product/'))}${link('/categories', 'Categories', (p) => p === '/categories')}${link('/suppliers', 'Suppliers', (p) => p.startsWith('/supplier'))}${link('/how-it-works', 'How It Works', (p) => p === '/how-it-works')}
      ${role === 'seller' || role === 'admin' ? '' : link('/register?role=seller', 'Become a Seller', (p) => false)}
    </nav>
    <div class="hdr-actions">
      <button class="icon-btn" id="theme-btn" data-act="toggle-theme" aria-pressed="${currentTheme() === 'dark'}" aria-label="${currentTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}">${ICON.sun}${ICON.moon}</button>
      ${u ? `<a class="icon-btn" href="#/notifications" aria-label="Notifications${store.notifications ? `, ${store.notifications} unread` : ''}">${ICON.bell}${store.notifications ? `<span class="count">${store.notifications > 9 ? '9+' : store.notifications}</span>` : ''}</a>` : ''}
      ${showCart ? `<a class="icon-btn" href="#/cart" aria-label="Shopping cart, ${cart.count()} items">${ICON.cart}${cart.count() ? `<span class="count">${cart.count() > 99 ? '99+' : cart.count()}</span>` : ''}</a>` : ''}
      ${u ? `<a class="btn btn-outline" href="#${dashboardPath()}">${role === 'admin' ? 'Admin' : role === 'seller' ? 'Seller hub' : 'My Account'}</a>` : `<a class="btn btn-outline" href="#/login">Sign in</a><a class="btn btn-primary hide-sm" href="#/register">Register</a>`}
      <button class="icon-btn" id="menu-btn" data-act="toggle-menu" aria-label="Menu" aria-expanded="false">${ICON.menu}</button>
    </div>
  </div></header>`;
  const el = document.getElementById('header'); el.innerHTML = html;
}

export function renderFooter() {
  document.getElementById('footer').innerHTML = `<footer class="site"><div class="wrap">
    <div style="flex:1 1 260px"><div class="logo" style="color:var(--hero-text)"><span class="mark" aria-hidden="true">B</span><span>Bonas<b>Hub</b></span></div><p class="mt small">Connecting businesses. Enabling trade. Tracking transactions.</p></div>
    <div><h4>Marketplace</h4><a href="#/products">Products</a><a href="#/categories">Categories</a><a href="#/suppliers">Suppliers</a></div>
    <div><h4>Company</h4><a href="#/how-it-works">How it works</a><a href="#/register?role=seller">Become a seller</a><a href="#/privacy">Privacy and data protection</a></div>
    <div><h4>Support</h4><a href="#/how-it-works">Help and FAQs</a><a href="#/login">Sign in</a></div>
  </div></footer>`;
}

export async function refreshNotifications() {
  if (!store.user) { store.notifications = 0; return; }
  try { store.notifications = (await get('/api/me/notifications')).unread; } catch { /* ignore */ }
}

export function hideLoader() {
  const l = document.getElementById('boot-loader'); if (!l) return;
  l.classList.add('done'); setTimeout(() => l.remove(), 600);
}
