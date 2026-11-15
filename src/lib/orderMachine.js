// Seller sub-order state machine. Every transition names who may perform it.
// ("Order placed" is recorded as the first history row; the stored state starts at awaiting_payment.)
export const STATUSES = [
  'awaiting_payment', 'payment_confirmed', 'seller_processing', 'ready_for_dispatch',
  'dispatched', 'delivered', 'completed', 'cancelled', 'refund_requested', 'refunded',
];

const T = {
  awaiting_payment: { payment_confirmed: ['system'], cancelled: ['buyer', 'system', 'admin'] },
  payment_confirmed: { seller_processing: ['seller'], cancelled: ['seller', 'admin'] },
  seller_processing: { ready_for_dispatch: ['seller'], cancelled: ['seller', 'admin'] },
  ready_for_dispatch: { dispatched: ['seller'], cancelled: ['admin'] },
  dispatched: { delivered: ['seller', 'admin'], completed: ['buyer', 'admin'] },
  delivered: { completed: ['buyer', 'system', 'admin'], refund_requested: ['buyer'] },
  completed: { refund_requested: ['buyer'] },
  refund_requested: { refunded: ['admin'], delivered: ['admin'], completed: ['admin'] },
  cancelled: {},
  refunded: {},
};

/** States in which stock has been taken and has not yet left with the goods, so a cancel returns it. */
export const STOCK_RETURNABLE = new Set(['awaiting_payment', 'payment_confirmed', 'seller_processing', 'ready_for_dispatch']);
/** States where the payment has been received (money is held with the gateway). */
export const PAID_STATES = new Set(['payment_confirmed', 'seller_processing', 'ready_for_dispatch', 'dispatched', 'delivered', 'completed', 'refund_requested', 'refunded']);

export function canTransition(from, to, actorRole) {
  const allowed = T[from]?.[to];
  return !!allowed && allowed.includes(actorRole);
}

export function allowedActions(from, actorRole) {
  return Object.entries(T[from] || {}).filter(([, roles]) => roles.includes(actorRole)).map(([to]) => to);
}

/** Parent order status derived from its sub-orders. */
export function parentStatus(subStatuses) {
  if (!subStatuses.length) return 'awaiting_payment';
  const all = (s) => subStatuses.every((x) => x === s);
  if (all('cancelled')) return 'cancelled';
  if (all('refunded')) return 'refunded';
  if (all('awaiting_payment')) return 'awaiting_payment';
  const live = subStatuses.filter((s) => s !== 'cancelled' && s !== 'refunded');
  if (live.length && live.every((s) => s === 'completed')) return 'completed';
  if (live.every((s) => s === 'payment_confirmed')) return 'payment_confirmed';
  return 'in_progress';
}
