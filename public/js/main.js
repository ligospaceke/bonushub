import { get, store, setUser, onState, resolve, go, ApiError, esc, skeleton, emptyState } from './lib.js';
import { renderHeader, renderFooter, hideLoader, refreshNotifications, dashboardPath, applyTheme, currentTheme } from './shell.js';
import './views/public.js';
import { renderTray } from './views/shop.js';
import './views/auth.js';
import './views/account.js';
import './views/seller.js';
import './views/admin.js';

const view = document.getElementById('view'), bar = document.getElementById('route-bar');
let navId = 0, firstRender = true;

function progress(on) {
  if (on) { bar.className = ''; void bar.offsetWidth; bar.className = 'on'; }
  else { bar.className = 'end'; setTimeout(() => (bar.className = ''), 600); }
}

function show(html, title) {
  view.innerHTML = html; view.classList.remove('leaving'); view.classList.remove('arrive'); void view.offsetWidth; view.classList.add('arrive');
  document.title = title ? `${title} · BonasHub` : 'BonasHub: Connecting Businesses. Enabling Trade.';
}

async function run() {
  const id = ++navId;
  const hashPath = location.hash.slice(1) || '/';
  const found = resolve(hashPath);
  progress(true);
  document.querySelector('nav.main')?.classList.remove('open');
  const slow = setTimeout(() => { if (id === navId) view.setAttribute('aria-busy', 'true'); }, 250);
  try {
    if (!found) { show(emptyState('Page not found', 'That page does not exist or has moved.', '<a class="btn btn-primary" href="#/">Back to home</a>'), 'Not found'); return; }
    const { route, params, query, path } = found;
    const roles = route.opts.roles;
    if (roles) {
      if (!store.user) { go('/login?next=' + encodeURIComponent(hashPath)); return; }
      if (!roles.includes(store.user.role)) { show(emptyState('This area is not for your account type', '', `<a class="btn btn-primary" href="#${dashboardPath()}">Go to my dashboard</a>`), 'Not available'); return; }
    }
    view.classList.add('leaving');   // dim the page we are leaving; no boxed placeholder
    const out = await route.handler({ params, query, path, user: store.user });
    if (id !== navId) return;                       // a newer navigation took over
    if (!out) return;
    show(out.html, out.title);
    renderHeader(path); renderTray();
    window.scrollTo(0, 0);
    const h1 = view.querySelector('h1'); if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
    out.after?.();
  } catch (err) {
    if (id !== navId) return;
    if (err instanceof ApiError && err.status === 401) { setUser(null); go('/login?next=' + encodeURIComponent(hashPath)); return; }
    if (err instanceof ApiError && err.status === 404) { show(emptyState('Not found', 'We could not find that. It may have been removed.', '<a class="btn btn-primary" href="#/products">Browse products</a>'), 'Not found'); return; }
    console.error(err);
    show(emptyState('We could not load this page', esc(err.message || 'Please try again.'), '<button class="btn btn-primary" onclick="location.reload()">Try again</button>'), 'Error');
  } finally { clearTimeout(slow); view.removeAttribute('aria-busy'); view.classList.remove('leaving'); if (id === navId) progress(false); }
}

async function boot() {
  applyTheme(currentTheme(), { save: false, animate: false });
  try { setUser((await get('/api/auth/me')).user); } catch { setUser(null); }
  await refreshNotifications();
  renderHeader(location.hash.slice(1) || '/'); renderFooter();
  window.addEventListener('hashchange', run);
  onState(() => renderHeader(location.hash.slice(1) || '/'));
  await run();
  // Keep the loader up long enough to read as a deliberate intro, never longer than needed.
  setTimeout(hideLoader, Math.max(0, 700 - performance.now()));
}
boot().catch((e) => { console.error(e); hideLoader(); document.getElementById('view').innerHTML = '<div class="wrap page"><div class="card"><h2>BonasHub could not start</h2><p class="mt">Please refresh the page. If this keeps happening, contact support.</p></div></div>'; });
