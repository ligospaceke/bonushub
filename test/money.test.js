import test from 'node:test';
import assert from 'node:assert/strict';
import { mulDivRound } from '../src/lib/money.js';
import { selectRate, computeSubOrderCommission, reverseCommission, sellerPayable, SETTING_DEFAULTS } from '../src/lib/commission.js';
import { canTransition, parentStatus } from '../src/lib/orderMachine.js';

const S = SETTING_DEFAULTS;

test('the brief example: KSh 100,000 at 5% is KSh 5,000 commission and KSh 95,000 to the seller', () => {
  const c = computeSubOrderCommission([{ lineSubtotalMinor: 10000000, bps: 500, rule: 'default' }]);
  assert.equal(c.commissionMinor, 500000);
  assert.equal(c.sellerProceedsMinor, 9500000);
});

test('rounding is half-up and exact on awkward amounts', () => {
  assert.equal(mulDivRound(1, 500, 10000), 0);        // 0.05 rounds down
  assert.equal(mulDivRound(10, 500, 10000), 1);       // 0.5 rounds up
  assert.equal(computeSubOrderCommission([{ lineSubtotalMinor: 99999, bps: 300, rule: 'founding' }]).commissionMinor, 3000); // 2999.97
  assert.equal(computeSubOrderCommission([{ lineSubtotalMinor: 33333, bps: 500, rule: 'default' }]).commissionMinor, 1667);  // 1666.65
});

test('mixed line rates are summed exactly then rounded once', () => {
  const c = computeSubOrderCommission([
    { lineSubtotalMinor: 100001, bps: 200, rule: 'category' },
    { lineSubtotalMinor: 100001, bps: 500, rule: 'default' },
  ]);
  assert.equal(c.commissionMinor, Math.round((100001 * 200 + 100001 * 500) / 10000));
  assert.equal(c.bps, null);
  assert.equal(c.rule, 'mixed');
});

test('rate priority: admin override beats founding beats category beats default; founding expires', () => {
  const seller = { founding: 1, founding_expires_at: '2027-05-10T00:00:00Z', commission_override_bps: null };
  assert.deepEqual(selectRate({ seller, categoryBps: 200, settings: S, at: '2026-11-10T00:00:00Z' }), { bps: 300, rule: 'founding' });
  assert.deepEqual(selectRate({ seller, categoryBps: 200, settings: S, at: '2027-05-11T00:00:00Z' }), { bps: 200, rule: 'category' });
  assert.deepEqual(selectRate({ seller: { ...seller, commission_override_bps: 250 }, categoryBps: 200, settings: S, at: '2026-11-10T00:00:00Z' }), { bps: 250, rule: 'seller_override' });
  assert.deepEqual(selectRate({ seller: { founding: 0 }, categoryBps: null, settings: S, at: '2026-11-10T00:00:00Z' }), { bps: 500, rule: 'default' });
});

test('proportional commission reversal never exceeds what remains', () => {
  const rev = reverseCommission({ commissionMinor: 500000, reversedMinor: 0, subtotalMinor: 10000000, productRefundMinor: 2500000 });
  assert.equal(rev, 125000);
  const rest = reverseCommission({ commissionMinor: 500000, reversedMinor: 125000, subtotalMinor: 10000000, productRefundMinor: 99999999 });
  assert.equal(rest, 375000);
  assert.equal(sellerPayable({ total_minor: 10500000, refunded_minor: 0, commission_minor: 500000, commission_reversed_minor: 0 }), 10000000);
});

test('state machine: only the right actor can make each move', () => {
  assert.ok(canTransition('payment_confirmed', 'seller_processing', 'seller'));
  assert.ok(!canTransition('payment_confirmed', 'seller_processing', 'buyer'));
  assert.ok(!canTransition('awaiting_payment', 'payment_confirmed', 'buyer'));
  assert.ok(!canTransition('awaiting_payment', 'payment_confirmed', 'seller'));
  assert.ok(canTransition('awaiting_payment', 'payment_confirmed', 'system'));
  assert.ok(!canTransition('dispatched', 'seller_processing', 'seller'));
  assert.ok(!canTransition('completed', 'cancelled', 'admin'));
  assert.equal(parentStatus(['completed', 'cancelled']), 'completed');
});
