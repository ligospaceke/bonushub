import { sandbox } from './sandbox.js';

/**
 * Payment provider adapter. A provider implements:
 *   initiate(env, payment, {method, phone})  -> { providerRef, action }
 *   verifyWebhook(env, rawBody, headers)      -> { ok, event: {id, type, paymentRef, providerRef} }
 *   query(env, payment)                       -> { state: 'success'|'failed'|'pending', amountMinor, providerRef }
 *   refund(env, payment, amountMinor)         -> { providerRefundRef }
 * Add the licensed gateway chosen for production as a new file here and select it with PAYMENT_PROVIDER.
 */
const providers = { sandbox };

export function getProvider(env) {
  const name = env.PAYMENT_PROVIDER || 'sandbox';
  const p = providers[name];
  if (!p) throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`);
  return p;
}

export const providerByName = (name) => providers[name] || null;
