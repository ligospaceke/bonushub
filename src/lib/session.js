import { parseCookies } from './http.js';
import { sha256Hex, randomToken, uuid } from './crypto.js';
import { nowIso, addDays } from './db.js';

export const SESSION_DAYS = 14;

export async function createSession(env, userId) {
  const token = randomToken(32);
  const ts = nowIso(env);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
    .bind(uuid(), userId, await sha256Hex(token), addDays(ts, SESSION_DAYS), ts).run();
  return { token, maxAgeSeconds: SESSION_DAYS * 86400 };
}

export async function destroySession(env, request) {
  const token = parseCookies(request.headers.get('cookie')).bh_session;
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

/** Resolve the signed-in user (with seller profile if any) from the session cookie, or null. */
export async function loadUser(env, request) {
  const token = parseCookies(request.headers.get('cookie')).bh_session;
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
  ).bind(await sha256Hex(token), nowIso(env)).first();
  if (!row) return null;
  if (row.role === 'seller') {
    row.seller = await env.DB.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').bind(row.id).first();
  }
  return row;
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, phone: u.phone, fullName: u.full_name, role: u.role, staffRole: u.staff_role,
    emailVerified: !!u.email_verified_at, phoneVerified: !!u.phone_verified_at,
    verified: !!(u.email_verified_at || u.phone_verified_at),
    country: u.country, county: u.county, town: u.town, accountType: u.account_type,
    businessName: u.business_name, businessType: u.business_type,
    seller: u.seller ? {
      slug: u.seller.slug, businessName: u.seller.business_name, status: u.seller.status, statusReason: u.seller.status_reason,
      founding: !!u.seller.founding, foundingExpiresAt: u.seller.founding_expires_at, approvedAt: u.seller.approved_at,
    } : undefined,
  };
}
