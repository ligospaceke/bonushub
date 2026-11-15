import { esc, get, post, route, forms, actions, go, setUser, toast, field, selectField, textField, store } from '../lib.js';
import { refreshNotifications, dashboardPath } from '../shell.js';

let devCode = null; // only ever present when the server runs in development mode

const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : null);

route('/login', async ({ query }) => {
  if (store.user) { go(safeNext(query.next) || dashboardPath()); return null; }
  return { title: 'Sign in', html: `<div class="wrap page"><div class="auth card"><h1>Sign in</h1><p class="muted mt">Welcome back. Sign in to track orders, quotations and payments.</p>
  <form data-form="login" class="stack mt2" novalidate>
    <input type="hidden" name="next" value="${esc(query.next || '')}">
    ${field('Email', 'email', { type: 'email', req: true, autocomplete: 'email' })}
    ${field('Password', 'password', { type: 'password', req: true, autocomplete: 'current-password' })}
    <p class="err" data-form-error role="alert"></p>
    <button class="btn btn-primary" type="submit">Sign in</button>
  </form>
  <p class="small muted mt2">New to BonasHub? <a href="#/register">Create a buyer account</a> or <a href="#/register?role=seller">apply to sell</a>.</p></div></div>` };
}, { skeleton: false });

forms.login = async (v) => {
  const r = await post('/api/auth/login', { email: v.email, password: v.password });
  setUser(r.user); await refreshNotifications();
  toast('Signed in.', 'ok');
  go(safeNext(v.next) || dashboardPath());
};

route('/register', async ({ query }) => {
  if (store.user) { go(dashboardPath()); return null; }
  const role = query.role === 'seller' ? 'seller' : 'buyer';
  const cats = (await get('/api/categories')).categories;
  const common = `
    ${field('Full name', 'fullName', { req: true, autocomplete: 'name' })}
    <div class="grid2">${field('Email', 'email', { type: 'email', req: true, autocomplete: 'email' })}${field('Phone', 'phone', { type: 'tel', req: true, ph: '07xx xxx xxx', autocomplete: 'tel' })}</div>
    ${field('Password', 'password', { type: 'password', req: true, hint: 'At least 10 characters.', autocomplete: 'new-password' })}
    <div class="grid2">${field('Country', 'country', { req: true, value: 'Kenya' })}${field('County or region', 'county', { req: true })}</div>
    ${field('Town or location', 'town', { req: true })}`;
  const buyer = `${selectField('I am registering as', 'accountType', [['individual', 'An individual'], ['business', 'A business']], 'business')}
    <div id="biz-fields" class="grid2">${field('Business name', 'businessName', { req: true })}${field('Business type', 'businessType', { req: true, ph: 'Retailer, contractor, farm…' })}</div>`;
  const seller = `${field('Registered business name', 'businessName', { req: true })}
    ${field('Registration number', 'regNo')}
    ${field('Physical business location', 'location', { req: true })}
    ${textField('Business description', 'description', { req: true, rows: 4, ph: 'What you sell and who you serve.' })}
    <fieldset class="field"><legend>Product categories you will sell</legend><div class="checks">${cats.map((c) => `<label class="check"><input type="checkbox" name="categoryIds[]" value="${esc(c.id)}"> ${esc(c.name)}</label>`).join('')}</div><span class="err" data-err="categoryIds"></span></fieldset>`;
  return { title: role === 'seller' ? 'Become a seller' : 'Create account', html: `<div class="wrap page"><div class="auth card wide">
    <div class="tabs" role="tablist"><a role="tab" aria-selected="${role === 'buyer'}" href="#/register">Buyer</a><a role="tab" aria-selected="${role === 'seller'}" href="#/register?role=seller">Seller</a></div>
    <h1 class="mt">${role === 'seller' ? 'Apply to sell on BonasHub' : 'Create a buyer account'}</h1>
    <p class="muted mt">${role === 'seller' ? 'Registration and listing are free. Our team reviews every application before you can list products.' : 'Order from verified suppliers and track every purchase.'}</p>
    <form data-form="register" class="stack mt2" novalidate><input type="hidden" name="role" value="${role}">
      ${common}${role === 'seller' ? seller : buyer}
      <label class="check"><input type="checkbox" name="consent"> I have read the <a href="#/privacy" target="_blank" rel="noopener">privacy notice</a> and agree to BonasHub processing my details to run my account.</label><span class="err" data-err="consent"></span>
      <p class="err" data-form-error role="alert"></p>
      <button class="btn btn-primary" type="submit">${role === 'seller' ? 'Submit application' : 'Create account'}</button>
    </form><p class="small muted mt2">Already registered? <a href="#/login">Sign in</a></p></div></div>`,
    after() {
      const sel = document.querySelector('[name=accountType]'), box = document.getElementById('biz-fields');
      if (sel && box) { const sync = () => { const b = sel.value === 'business'; box.hidden = !b; box.querySelectorAll('input').forEach((i) => (i.disabled = !b)); }; sel.addEventListener('change', sync); sync(); }
    } };
});

forms.register = async (v) => {
  const body = { ...v, consent: !!v.consent };
  const r = await post('/api/auth/register', body);
  devCode = r.devVerificationCode || null;
  setUser(r.user); await refreshNotifications();
  toast(r.user.role === 'seller' ? 'Application received.' : 'Account created.', 'ok');
  go('/verify');
};

route('/verify', async () => {
  const u = store.user; if (!u) { go('/login?next=/verify'); return null; }
  return { title: 'Verify your account', html: `<div class="wrap page"><div class="auth card"><h1>Verify your email</h1>
    <p class="muted mt">We sent a 6-digit code to <b>${esc(u.email)}</b>. ${u.emailVerified ? '<span class="badge ok">Verified</span>' : ''}</p>
    ${devCode ? `<p class="note mt">Development mode: your code is <b>${esc(devCode)}</b>. Real codes are sent by email once a provider is connected.</p>` : ''}
    <form data-form="verify" class="stack mt2" novalidate>${field('Verification code', 'code', { req: true, attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })}
      <p class="err" data-form-error role="alert"></p><button class="btn btn-primary" type="submit">Verify</button></form>
    <p class="mt2 small"><button class="btn btn-ghost" data-act="resend-code" type="button">Send a new code</button> <a href="#${dashboardPath()}" class="small">Skip for now</a></p></div></div>` };
}, { skeleton: false });

forms.verify = async (v) => {
  await post('/api/auth/verify', { channel: 'email', code: v.code });
  setUser((await get('/api/auth/me')).user); devCode = null;
  toast('Email verified.', 'ok'); go(dashboardPath());
};
actions['resend-code'] = async () => { const r = await post('/api/auth/resend', { channel: 'email' }); devCode = r.devVerificationCode || null; toast('A new code was sent.'); go('/verify'); };
