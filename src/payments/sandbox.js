// Sandbox gateway: a stand-in for a licensed payment provider so the whole money flow can be built and tested.
// It keeps its own record of each transaction (sandbox_txns). Orders are only marked paid after the app asks this
// "gateway" server-to-server what really happened, exactly as it must with a real provider.
import { hmacHex, timingSafeEqual, randomToken } from '../lib/crypto.js';
import { nowIso } from '../lib/db.js';

export const sandboxSecret = (env) => {
  if (env.PAYMENT_WEBHOOK_SECRET) return env.PAYMENT_WEBHOOK_SECRET;
  if (env.DEV_MODE) return 'dev-webhook-secret';
  throw new Error('PAYMENT_WEBHOOK_SECRET is not set');
};

export const sandbox = {
  name: 'sandbox',

  async initiate(env, payment, { method, phone }) {
    const ts = nowIso(env);
    const providerRef = 'SBX-' + randomToken(9);
    await env.DB.prepare('INSERT INTO sandbox_txns (payment_ref, provider_ref, amount_minor, state, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .bind(payment.ref, providerRef, payment.amount_minor, 'pending', ts, ts).run();
    await env.DB.prepare('UPDATE payments SET provider_ref = ? WHERE ref = ?').bind(providerRef, payment.ref).run();
    return {
      providerRef,
      action: { type: 'sandbox_redirect', url: `/#/pay/${payment.ref}`, method, phoneHint: phone || null },
    };
  },

  async verifyWebhook(env, rawBody, headers) {
    const sig = headers.get('x-bh-signature') || '';
    const expected = await hmacHex(sandboxSecret(env), rawBody);
    if (!timingSafeEqual(sig, expected)) return { ok: false };
    const e = JSON.parse(rawBody);
    return { ok: true, event: { id: String(e.id), type: e.type, paymentRef: e.paymentRef, providerRef: e.providerRef } };
  },

  /** Server-to-server truth check. */
  async query(env, payment) {
    const t = await env.DB.prepare('SELECT * FROM sandbox_txns WHERE payment_ref = ?').bind(payment.ref).first();
    if (!t) return { state: 'pending' };
    return { state: t.state === 'success' ? 'success' : t.state === 'failed' ? 'failed' : 'pending', amountMinor: t.amount_minor, providerRef: t.provider_ref };
  },

  async refund(env, payment, amountMinor) {
    return { providerRefundRef: 'SBX-RF-' + randomToken(6) };
  },

  /** Sandbox-only: what the buyer does on the simulated payment page. */
  async settleSandboxTxn(env, paymentRef, outcome) {
    const state = outcome === 'success' ? 'success' : 'failed';
    const r = await env.DB.prepare("UPDATE sandbox_txns SET state = ?, updated_at = ? WHERE payment_ref = ? AND state = 'pending'")
      .bind(state, nowIso(env), paymentRef).run();
    return r.meta.changes === 1;
  },
};
