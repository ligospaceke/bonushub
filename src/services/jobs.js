import { nowIso, addDays, addMinutes, getSettings } from '../lib/db.js';
import { confirmPayment } from './payments.js';
import { transition } from './fulfilment.js';
import { audit } from './audit.js';

const SYSTEM = { id: null, role: 'system' };

/**
 * Housekeeping, run on a schedule (Cron Trigger) and on demand by the owner:
 *  1. Pending payments past their window: ask the provider one last time, then fail them and cancel the unpaid orders (stock returns).
 *  2. Delivered orders the buyer never confirmed: complete them after the auto-complete period if no dispute is open.
 */
export async function runJobs(env) {
  const settings = await getSettings(env.DB);
  const now = nowIso(env);
  const out = { expiredPayments: 0, cancelledOrders: 0, autoCompleted: 0 };

  const stale = (await env.DB.prepare("SELECT * FROM payments WHERE status = 'pending' AND created_at <= ?").bind(addMinutes(now, -settings.paymentExpiryMinutes)).all()).results;
  for (const p of stale) {
    const r = await confirmPayment(env, p.ref).catch((e) => { console.error('confirm during expiry failed', e); return { status: 'pending' }; });
    if (r.status === 'successful') continue;
    if (r.status === 'pending') {
      await env.DB.prepare("UPDATE payments SET status = 'failed', failure_reason = 'Expired without payment', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, p.id).run();
      out.expiredPayments++;
    }
  }
  const unpaid = (await env.DB.prepare(
    `SELECT so.id FROM seller_orders so WHERE so.status = 'awaiting_payment' AND so.created_at <= ?
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = so.order_id AND p.status = 'pending')`
  ).bind(addMinutes(now, -settings.paymentExpiryMinutes)).all()).results;
  for (const s of unpaid) {
    try { await transition(env, SYSTEM, s.id, 'cancelled', { note: 'Payment was not completed in time' }); out.cancelledOrders++; }
    catch (e) { console.error('expiry cancel failed', s.id, e.message); }
  }

  const due = (await env.DB.prepare("SELECT id FROM seller_orders WHERE status = 'delivered' AND dispute_open = 0 AND delivered_at <= ?").bind(addDays(now, -settings.autoCompleteDays)).all()).results;
  for (const s of due) {
    try { await transition(env, SYSTEM, s.id, 'completed', { note: 'Auto-completed: buyer did not respond within the confirmation period' }); out.autoCompleted++; }
    catch (e) { console.error('auto-complete failed', s.id, e.message); }
  }
  if (out.expiredPayments || out.cancelledOrders || out.autoCompleted) await audit(env, { action: 'jobs.ran', data: out });
  return out;
}
