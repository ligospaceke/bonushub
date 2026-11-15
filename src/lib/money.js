// All money is integer minor units (KES cents). Never use floating point for amounts.
export const isMinor = (n) => Number.isSafeInteger(n) && n >= 0;

/** Round-half-up of (a * b / d) for non-negative integers, exact (BigInt). */
export function mulDivRound(a, b, d) {
  if (d === 0) throw new Error('division by zero');
  const A = BigInt(a), B = BigInt(b), D = BigInt(d);
  return Number((A * B * 2n + D) / (D * 2n));
}

export const kesToMinor = (kes) => Math.round(Number(kes) * 100);
export const minorToKes = (minor) => minor / 100;

export function formatKES(minor) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100).toLocaleString('en-KE');
  const cents = abs % 100;
  return `${sign}KSh ${whole}${cents ? '.' + String(cents).padStart(2, '0') : ''}`;
}
