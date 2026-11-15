import { json, readJson, ApiError, bad, sessionCookie, clearCookie, forbidden } from '../lib/http.js';
import { fields, slugify } from '../lib/validate.js';
import { hashPassword, verifyPassword, uuid, randomDigits, sha256Hex, timingSafeEqual } from '../lib/crypto.js';
import { createSession, destroySession, publicUser } from '../lib/session.js';
import { nowIso, addMinutes } from '../lib/db.js';
import { rateLimit, clientIp } from '../lib/ratelimit.js';
import { audit } from '../services/audit.js';
import { notifyAdmins, notifyStmts } from '../services/notify.js';

export const CONSENT_VERSION = '2026-11';
const secure = (env, request) => !env.DEV_MODE && new URL(request.url).protocol === 'https:';

async function issueCode(env, user, channel) {
  const code = randomDigits(6);
  const ts = nowIso(env);
  await env.DB.batch([
    env.DB.prepare('UPDATE verification_codes SET used_at = ? WHERE user_id = ? AND channel = ? AND used_at IS NULL').bind(ts, user.id, channel),
    env.DB.prepare('INSERT INTO verification_codes (id, user_id, channel, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)')
      .bind(uuid(), user.id, channel, await sha256Hex(`${user.id}:${channel}:${code}`), addMinutes(ts, 15), ts),
    ...(channel === 'email'
      ? [env.DB.prepare('INSERT INTO outbox (id, user_id, channel, to_addr, subject, body, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(uuid(), user.id, 'email', user.email, 'Your BonasHub verification code', `Your verification code is ${code}. It expires in 15 minutes.`, ts)]
      : [env.DB.prepare('INSERT INTO outbox (id, user_id, channel, to_addr, subject, body, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(uuid(), user.id, 'sms', user.phone, null, `BonasHub code: ${code}`, ts)]),
  ]);
  // Development only: surface the code so the flow can be exercised without an email/SMS provider.
  return env.DEV_MODE ? code : undefined;
}

export function authRoutes(r) {
  r.post('/api/auth/register', { public: true }, async ({ env, request }) => {
    await rateLimit(env, `reg:${clientIp(request)}`, 10, 3600);
    const b = await readJson(request);
    const f = fields();
    const role = f.oneOf(b, 'role', ['buyer', 'seller'], { label: 'Account type' });
    const fullName = f.str(b, 'fullName', { max: 120, label: 'Full name' });
    const email = f.email(b);
    const phone = f.phone(b);
    const password = f.password(b);
    const country = f.str(b, 'country', { max: 80, label: 'Country' });
    const county = f.str(b, 'county', { max: 80, label: 'County or region' });
    const town = f.str(b, 'town', { max: 80, label: 'Town or location' });
    f.bool(b, 'consent', { mustBeTrue: true, label: 'Consent to the privacy notice' });
    let accountType = null, businessName = null, businessType = null;
    if (role === 'buyer') {
      accountType = f.oneOf(b, 'accountType', ['individual', 'business'], { label: 'Individual or business' });
      if (accountType === 'business') {
        businessName = f.str(b, 'businessName', { max: 160, label: 'Business name' });
        businessType = f.str(b, 'businessType', { max: 80, label: 'Business type' });
      }
    }
    let seller = null;
    if (role === 'seller') {
      seller = {
        businessName: f.str(b, 'businessName', { max: 160, label: 'Registered business name' }),
        regNo: f.str(b, 'regNo', { max: 60, optional: true }),
        location: f.str(b, 'location', { max: 300, label: 'Physical business location' }),
        description: f.str(b, 'description', { max: 2000, label: 'Business description' }),
        categoryIds: Array.isArray(b.categoryIds) ? b.categoryIds.filter((x) => typeof x === 'string').slice(0, 10) : [],
      };
      if (!seller.categoryIds.length) f.errors.categoryIds = 'Choose at least one product category.';
    }
    f.done();

    const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
    if (exists) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Try signing in.');

    if (seller) {
      const cats = (await env.DB.prepare(`SELECT id FROM categories WHERE active = 1 AND id IN (${seller.categoryIds.map(() => '?').join(',')})`).bind(...seller.categoryIds).all()).results;
      if (cats.length !== seller.categoryIds.length) throw bad(undefined, { categoryIds: 'One or more categories are not valid.' });
    }

    const id = uuid(), ts = nowIso(env);
    const stmts = [env.DB.prepare(
      `INSERT INTO users (id, email, phone, password_hash, role, full_name, country, county, town, account_type, business_name, business_type, consent_at, consent_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, email, phone, await hashPassword(password), role, fullName, country, county, town, accountType, businessName, businessType, ts, CONSENT_VERSION, ts)];
    if (seller) {
      let slug = slugify(seller.businessName);
      if (await env.DB.prepare('SELECT 1 FROM seller_profiles WHERE slug = ?').bind(slug).first()) slug += '-' + id.slice(0, 4);
      stmts.push(env.DB.prepare(
        `INSERT INTO seller_profiles (user_id, slug, contact_name, business_name, reg_no, phone, email, location, country, region, town, description, category_ids, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`
      ).bind(id, slug, fullName, seller.businessName, seller.regNo, phone, email, seller.location, country, county, town, seller.description, JSON.stringify(seller.categoryIds), ts));
    }
    stmts.push(...notifyStmts(env, { userId: id, email, kind: 'welcome', title: role === 'seller' ? 'Application received' : 'Welcome to BonasHub', body: role === 'seller' ? 'We will review your business details and notify you.' : 'Your account is ready.' }));
    await env.DB.batch(stmts);

    const user = { id, email, phone };
    const devCode = await issueCode(env, user, 'email');
    await audit(env, { actor: { id, role }, action: role === 'seller' ? 'seller.registered' : 'buyer.registered', entity: 'user', entityId: id });
    await notifyAdmins(env, role === 'seller'
      ? { kind: 'seller_application', title: `New seller application: ${seller.businessName}`, body: 'Review their details and documents.', link: '#/admin/sellers' }
      : { kind: 'buyer_registered', title: `New buyer registered: ${fullName}`, body: email });

    const session = await createSession(env, id);
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (role === 'seller') row.seller = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(id).first();
    return json({ user: publicUser(row), devVerificationCode: devCode }, 201, { 'Set-Cookie': sessionCookie(session.token, { secure: secure(env, request), maxAgeSeconds: session.maxAgeSeconds }) });
  });

  r.post('/api/auth/login', { public: true }, async ({ env, request }) => {
    const ip = clientIp(request);
    await rateLimit(env, `login-ip:${ip}`, 30, 600);
    const b = await readJson(request);
    const email = String(b.email ?? '').trim().toLowerCase();
    const password = String(b.password ?? '');
    if (!email || !password) throw bad('Enter your email and password.');
    await rateLimit(env, `login-id:${email}`, 8, 900);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    // Same work and same message whether or not the account exists.
    const ok = u ? await verifyPassword(password, u.password_hash) : await verifyPassword(password, 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').then(() => false);
    if (!u || !ok) throw new ApiError(401, 'invalid_credentials', 'Email or password is not correct.');
    if (u.status !== 'active') throw new ApiError(403, 'account_suspended', 'This account is suspended. Contact support.');
    const session = await createSession(env, u.id);
    if (u.role === 'seller') u.seller = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(u.id).first();
    await audit(env, { actor: { id: u.id, role: u.role }, action: 'auth.login', entity: 'user', entityId: u.id });
    return json({ user: publicUser(u) }, 200, { 'Set-Cookie': sessionCookie(session.token, { secure: secure(env, request), maxAgeSeconds: session.maxAgeSeconds }) });
  });

  r.post('/api/auth/logout', { public: true }, async ({ env, request }) => {
    await destroySession(env, request);
    return json({ loggedOut: true }, 200, { 'Set-Cookie': clearCookie(secure(env, request)) });
  });

  r.get('/api/auth/me', { public: true }, async ({ user }) => json({ user: publicUser(user) }));

  r.post('/api/auth/verify', async ({ env, request, user }) => {
    await rateLimit(env, `verify:${user.id}`, 10, 900);
    const b = await readJson(request);
    const channel = b.channel === 'phone' ? 'phone' : 'email';
    const code = String(b.code ?? '').trim();
    const row = await env.DB.prepare('SELECT * FROM verification_codes WHERE user_id = ? AND channel = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').bind(user.id, channel).first();
    if (!row || row.expires_at < nowIso(env) || row.attempts >= 5) throw new ApiError(400, 'code_invalid', 'That code has expired. Request a new one.');
    await env.DB.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    if (!timingSafeEqual(await sha256Hex(`${user.id}:${channel}:${code}`), row.code_hash)) throw new ApiError(400, 'code_invalid', 'That code is not correct.');
    const ts = nowIso(env);
    await env.DB.batch([
      env.DB.prepare('UPDATE verification_codes SET used_at = ? WHERE id = ?').bind(ts, row.id),
      env.DB.prepare(`UPDATE users SET ${channel === 'email' ? 'email_verified_at' : 'phone_verified_at'} = ? WHERE id = ?`).bind(ts, user.id),
    ]);
    await audit(env, { actor: user, action: `auth.verify_${channel}`, entity: 'user', entityId: user.id });
    return json({ verified: true });
  });

  r.post('/api/auth/resend', async ({ env, request, user }) => {
    await rateLimit(env, `resend:${user.id}`, 5, 3600);
    const b = await readJson(request);
    const channel = b.channel === 'phone' ? 'phone' : 'email';
    const devCode = await issueCode(env, user, channel);
    return json({ sent: true, devVerificationCode: devCode });
  });

  r.post('/api/auth/password', async ({ env, request, user }) => {
    await rateLimit(env, `pw:${user.id}`, 5, 900);
    const b = await readJson(request);
    const f = fields();
    const next = f.password(b, 'newPassword');
    f.done();
    if (!(await verifyPassword(String(b.currentPassword ?? ''), user.password_hash))) throw new ApiError(400, 'invalid_credentials', 'Your current password is not correct.');
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(next), user.id).run();
    await audit(env, { actor: user, action: 'auth.password_changed', entity: 'user', entityId: user.id });
    return json({ changed: true });
  });
}
