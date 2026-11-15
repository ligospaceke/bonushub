import { uuid } from '../lib/crypto.js';
import { nowIso } from '../lib/db.js';

/**
 * Statements (for use inside a batch) that create an in-platform notification and, when an email address is
 * given, queue an email in the outbox. No email provider is connected yet, so queued mail waits for one.
 */
export function notifyStmts(env, { userId, email, kind, title, body, link }) {
  const ts = nowIso(env);
  const out = [env.DB.prepare('INSERT INTO notifications (id, user_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(uuid(), userId, kind, title, body ?? null, link ?? null, ts)];
  if (email) {
    out.push(env.DB.prepare('INSERT INTO outbox (id, user_id, channel, to_addr, subject, body, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uuid(), userId, 'email', email, title, body ?? title, ts));
  }
  return out;
}

export const notify = (env, args) => env.DB.batch(notifyStmts(env, args));

export async function adminIds(env) {
  return (await env.DB.prepare("SELECT id, email FROM users WHERE role = 'admin' AND status = 'active'").all()).results;
}

export async function notifyAdmins(env, { kind, title, body, link }) {
  const admins = await adminIds(env);
  if (!admins.length) return;
  await env.DB.batch(admins.flatMap((a) => notifyStmts(env, { userId: a.id, kind, title, body, link })));
}
