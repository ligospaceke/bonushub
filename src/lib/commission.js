import { mulDivRound } from './money.js';

export const SETTING_DEFAULTS = {
  defaultBps: 500, foundingBps: 300, foundingSlots: 50, foundingMonths: 6,
  disputeWindowDays: 7, autoCompleteDays: 7, paymentExpiryMinutes: 30, vatBps: 0,
};

/**
 * Choose the commission rate for one order line. One winner, recorded with the reason.
 * Order: administrator override for the seller, else founding rate while valid, else category rate, else default.
 * Founding and negotiated rates never stack: an override always wins and the admin chooses it explicitly.
 */
export function selectRate({ seller, categoryBps, settings, at }) {
  if (seller.commission_override_bps != null) return { bps: seller.commission_override_bps, rule: 'seller_override' };
  if (seller.founding && seller.founding_expires_at && at < seller.founding_expires_at) {
    return { bps: settings.foundingBps, rule: 'founding' };
  }
  if (categoryBps != null) return { bps: categoryBps, rule: 'category' };
  return { bps: settings.defaultBps, rule: 'default' };
}

/**
 * Commission for one seller sub-order. Base is the product subtotal only (never delivery or tax).
 * Lines may carry different rates; the sum is computed exactly and rounded half-up once per sub-order.
 */
export function computeSubOrderCommission(lines) {
  let num = 0n, subtotal = 0;
  for (const l of lines) { num += BigInt(l.lineSubtotalMinor) * BigInt(l.bps); subtotal += l.lineSubtotalMinor; }
  const commissionMinor = Number((num * 2n + 10000n) / 20000n);
  const bpsSet = new Set(lines.map((l) => l.bps));
  const ruleSet = new Set(lines.map((l) => l.rule));
  return {
    subtotalMinor: subtotal,
    commissionMinor,
    sellerProceedsMinor: subtotal - commissionMinor,
    bps: bpsSet.size === 1 ? [...bpsSet][0] : null,
    rule: ruleSet.size === 1 ? [...ruleSet][0] : 'mixed',
  };
}

/** Proportional commission reversal for a refund of part of the product value. Never exceeds what remains. */
export function reverseCommission({ commissionMinor, reversedMinor = 0, subtotalMinor, productRefundMinor }) {
  if (subtotalMinor <= 0) return 0;
  const portion = mulDivRound(commissionMinor, Math.min(productRefundMinor, subtotalMinor), subtotalMinor);
  return Math.min(portion, commissionMinor - reversedMinor);
}

/** What the seller is owed for a sub-order: total paid, less refunds, less BonasHub commission still standing. */
export function sellerPayable({ total_minor, refunded_minor, commission_minor, commission_reversed_minor }) {
  return total_minor - refunded_minor - (commission_minor - commission_reversed_minor);
}
