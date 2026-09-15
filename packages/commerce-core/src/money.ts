import type { Money } from "@astro/shared-types";

/** All money in integer minor units. These helpers keep rounding explicit and auditable. */

export function money(amount: number, currency = "EUR"): Money {
  if (!Number.isSafeInteger(amount))
    throw new Error(`Money amount must be a safe integer in minor units, got ${amount}`);
  return { amount, currency };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

/** Percentage of an amount, rounded half away from zero (bankers rounding would hide cents). */
export function pct(amount: number, percent: number): number {
  return roundHalfAwayFromZero((amount * percent) / 100);
}

export function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function formatMoney(m: Money | number, currency = "EUR", locale = "pt-PT"): string {
  const amount = typeof m === "number" ? m : m.amount;
  const cur = typeof m === "number" ? currency : m.currency;
  return new Intl.NumberFormat(locale, { style: "currency", currency: cur }).format(amount / 100);
}

/** Convert a supplier cost in a foreign currency to EUR cents using a rate snapshot (rate = EUR per 1 unit). */
export function convertToEur(amount: number, currency: string, rates: Record<string, number>): number {
  if (currency === "EUR") return amount;
  const rate = rates[currency];
  if (!rate) throw new Error(`No FX rate for ${currency}`);
  return roundHalfAwayFromZero(amount * rate);
}

/** Psychological price endings: X.90 / X.95 / X9 depending on band. Never below cost floor. */
export function charmPrice(cents: number): number {
  if (!Number.isFinite(cents)) throw new Error(`charmPrice needs a finite amount, got ${cents}`);
  const c = Math.max(0, Math.ceil(cents));
  if (c < 1000) return Math.max(c, Math.floor(c / 100) * 100 + 90);
  if (c < 10000) {
    // 24.90 style. Exact multiples of 100 would round DOWN by 10 cents (red team P2): step up instead.
    let p = Math.ceil(c / 100) * 100 - 10;
    if (p < c) p += 100;
    return p;
  }
  // 129 style for >100. Same guard: never below the input (the input is the margin floor for callers).
  const euros = Math.ceil(c / 100);
  let p = (Math.ceil(euros / 10) * 10 - 1) * 100;
  if (p < c) p += 1000;
  return p;
}

/** VAT helpers: consumer prices are VAT-inclusive in EU. */
export function vatFromGross(gross: number, ratePct: number): number {
  return roundHalfAwayFromZero(gross - gross / (1 + ratePct / 100));
}

export function netFromGross(gross: number, ratePct: number): number {
  return gross - vatFromGross(gross, ratePct);
}
