import { newId, pct, roundHalfAwayFromZero, vatFromGross } from "@astro/commerce-core";
import { type Db, getSetting, insert, nowIso, parseJson } from "@astro/db";
import type { CashflowBreakdown } from "@astro/shared-types";

/**
 * CASHFLOW GUARD + PROFIT ACCOUNTING.
 *
 * Every assumption below is a named, versioned parameter (settings key "cashflow.assumptions") so the
 * self-improvement loop can only change it through the audited settings path.
 *
 * Sources for the defaults (retrieved 2026-09-10/11):
 *  - Stripe EEA cards 1.5% + 0.25 EUR, non-EEA 3.25% + 0.25 EUR, +1% FX; fee NOT returned on refund.
 *  - Stripe first payout 7 to 14 days after first charge; then rolling schedule by country.
 *  - CJdropshipping requires payment at order time (balance/prepaid) -> supplier cash leaves before payout.
 *  - Portugal standard VAT 23% (mainland). OSS applies above 10k EUR EU-wide B2C distance sales.
 */
export interface CashflowAssumptions {
  vatRatePct: number; // 23 PT mainland
  paymentFeePct: number; // blended EEA/non-EEA
  paymentFeeFixed: number; // cents
  chargebackFee: number; // cents (Stripe dispute fee EU)
  chargebackProbability: number; // 0..1
  defaultReturnProbability: number; // 0..1, overridable per category
  contingencyPct: number; // % of gross
  minNetMarginPct: number; // minimum acceptable net margin over gross (pricing + margin check)
  minNetMarginAbs: number; // cents, absolute floor per order
  payoutLagDaysInitial: number; // first payout
  payoutLagDaysRolling: number;
  ownerFloatCents: number; // capital the owner has explicitly made available (default 0)
}

export const DEFAULT_ASSUMPTIONS: CashflowAssumptions = {
  vatRatePct: 23,
  paymentFeePct: 1.9,
  paymentFeeFixed: 25,
  chargebackFee: 2000,
  chargebackProbability: 0.003,
  defaultReturnProbability: 0.06,
  contingencyPct: 3,
  minNetMarginPct: 25,
  minNetMarginAbs: 500,
  payoutLagDaysInitial: 14,
  payoutLagDaysRolling: 7,
  ownerFloatCents: 0,
};

export function getAssumptions(db: Db): CashflowAssumptions {
  return {
    ...DEFAULT_ASSUMPTIONS,
    ...getSetting<Partial<CashflowAssumptions>>(db, "cashflow.assumptions", {}),
  };
}

export interface CashflowInput {
  customerPayment: number; // gross, VAT-inclusive, cents
  currency?: string;
  productCost: number; // cents EUR (supplier cost, all units)
  supplierShipping: number; // cents EUR
  returnProbability?: number;
  vatRatePct?: number; // override e.g. 0 for exports outside EU
  internationalCard?: boolean;
}

/**
 * Expected-value model:
 *   net_success    = gross - VAT - fee - cost - shipping
 *   net_return     = -fee - cost - shipping          (full refund incl. VAT, fee kept by Stripe, goods lost)
 *   net_chargeback = net_return - chargebackFee
 *   E[net] = (1-pR-pC)*net_success + pR*net_return + pC*net_chargeback - contingency
 * expressed as the breakdown the spec asks for.
 */
export function computeCashflow(
  input: CashflowInput,
  a: CashflowAssumptions = DEFAULT_ASSUMPTIONS,
): CashflowBreakdown {
  const gross = input.customerPayment;
  const vat = input.vatRatePct ?? a.vatRatePct;
  const taxes = vatFromGross(gross, vat);
  const feePct = input.internationalCard ? a.paymentFeePct + 1.35 : a.paymentFeePct;
  const paymentFee = pct(gross, feePct) + a.paymentFeeFixed;
  const pR = input.returnProbability ?? a.defaultReturnProbability;
  const pC = a.chargebackProbability;
  const netSuccess = gross - taxes - paymentFee - input.productCost - input.supplierShipping;
  const expectedReturnCost = roundHalfAwayFromZero(pR * (gross - taxes));
  const expectedChargebackCost = roundHalfAwayFromZero(pC * (gross - taxes + a.chargebackFee));
  const contingencyBuffer = pct(gross, a.contingencyPct);
  const estimatedNetMargin = netSuccess - expectedReturnCost - expectedChargebackCost - contingencyBuffer;
  return {
    customerPayment: gross,
    taxes,
    paymentFee,
    productCost: input.productCost,
    supplierShipping: input.supplierShipping,
    expectedReturnCost,
    expectedChargebackCost,
    contingencyBuffer,
    estimatedNetMargin,
    estimatedNetMarginPct: gross > 0 ? Math.round((estimatedNetMargin / gross) * 10000) / 100 : 0,
    currency: input.currency ?? "EUR",
  };
}

export interface MarginVerdict {
  ok: boolean;
  reason: string;
  breakdown: CashflowBreakdown;
}

/** MARGIN_CHECK: block any sale whose expected net margin is below policy. */
export function checkMargin(
  input: CashflowInput,
  a: CashflowAssumptions = DEFAULT_ASSUMPTIONS,
): MarginVerdict {
  const breakdown = computeCashflow(input, a);
  if (breakdown.estimatedNetMargin < a.minNetMarginAbs) {
    return {
      ok: false,
      reason: `net margin ${breakdown.estimatedNetMargin} cents below absolute floor ${a.minNetMarginAbs}`,
      breakdown,
    };
  }
  if (breakdown.estimatedNetMarginPct < a.minNetMarginPct) {
    return {
      ok: false,
      reason: `net margin ${breakdown.estimatedNetMarginPct}% below minimum ${a.minNetMarginPct}%`,
      breakdown,
    };
  }
  return { ok: true, reason: "margin ok", breakdown };
}

// ---------------- Working-capital guard ----------------

export interface WorkingCapitalState {
  stripeAvailableCents: number; // funds Stripe has released (payout-able)
  stripePendingCents: number; // charged but not yet available
  supplierBalanceCents: number; // prepaid balance at supplier (e.g. CJ wallet)
  ownerFloatCents: number;
  committedUnpaidCents: number; // supplier costs of orders READY/SUBMITTED not yet paid
}

export function getWorkingCapital(db: Db): WorkingCapitalState {
  const a = getAssumptions(db);
  const snap = getSetting<Partial<WorkingCapitalState>>(db, "cashflow.capital_snapshot", {});
  const committed = db.get<{ c: number }>(
    `SELECT COALESCE(SUM(json_extract(cashflow,'$.productCost') + json_extract(cashflow,'$.supplierShipping')),0) AS c
       FROM orders WHERE state IN ('READY_FOR_FULFILLMENT','SUPPLIER_SUBMITTED') AND cashflow IS NOT NULL`,
  );
  return {
    stripeAvailableCents: snap.stripeAvailableCents ?? 0,
    stripePendingCents: snap.stripePendingCents ?? 0,
    supplierBalanceCents: snap.supplierBalanceCents ?? 0,
    ownerFloatCents: snap.ownerFloatCents ?? a.ownerFloatCents,
    committedUnpaidCents: committed?.c ?? 0,
  };
}

export interface CashflowVerdict {
  ok: boolean;
  reason: string;
  requiredCents: number;
  availableCents: number;
  bufferNeededCents: number;
}

/**
 * CASHFLOW_CHECK: can we pay the supplier for this order NOW without owner money we do not have?
 * Available = Stripe available balance + supplier prepaid balance + explicit owner float - already committed.
 * In SIMULATION/TEST we still compute the verdict but the caller decides whether it blocks.
 */
export function checkCashflow(db: Db, orderSupplierCostCents: number): CashflowVerdict {
  const wc = getWorkingCapital(db);
  const available =
    wc.stripeAvailableCents + wc.supplierBalanceCents + wc.ownerFloatCents - wc.committedUnpaidCents;
  const ok = available >= orderSupplierCostCents;
  return {
    ok,
    reason: ok
      ? "working capital available"
      : `insufficient working capital: need ${orderSupplierCostCents}, available ${available} (Stripe pending ${wc.stripePendingCents} not yet released)`,
    requiredCents: orderSupplierCostCents,
    availableCents: available,
    bufferNeededCents: ok ? 0 : orderSupplierCostCents - available,
  };
}

/** Estimate the float needed to run N orders/day at a given average supplier cost through the payout lag. */
export function estimateRequiredFloat(
  ordersPerDay: number,
  avgSupplierCostCents: number,
  a: CashflowAssumptions = DEFAULT_ASSUMPTIONS,
): { initialCents: number; rollingCents: number } {
  return {
    initialCents: Math.ceil(ordersPerDay * avgSupplierCostCents * a.payoutLagDaysInitial),
    rollingCents: Math.ceil(ordersPerDay * avgSupplierCostCents * a.payoutLagDaysRolling),
  };
}

// ---------------- Profit accounting ----------------

export type FinancialKind =
  | "gross_revenue"
  | "discount"
  | "refund"
  | "tax"
  | "payment_fee"
  | "supplier_cost"
  | "shipping_cost"
  | "chargeback"
  | "chargeback_fee"
  | "other_variable_cost"
  | "payout";

export function recordFinancialEvent(
  db: Db,
  e: {
    storeId?: string | null;
    orderId?: string | null;
    kind: FinancialKind;
    amount: number; // signed cents (+ inflow, - outflow)
    currency?: string;
    estimated?: boolean;
    ref?: string;
    occurredAt?: string;
    /** runtime mode of the money (TEST money never counts as revenue); defaults to the order's mode */
    mode?: string | null;
  },
): string {
  const id = newId("fin");
  const mode =
    e.mode ??
    (e.orderId
      ? (db.get<{ mode: string }>("SELECT mode FROM orders WHERE id=?", [e.orderId])?.mode ?? null)
      : null);
  insert(db, "financial_events", {
    id,
    store_id: e.storeId ?? null,
    order_id: e.orderId ?? null,
    kind: e.kind,
    amount: e.amount,
    currency: e.currency ?? "EUR",
    estimated: e.estimated ? 1 : 0,
    ref: e.ref ?? null,
    mode,
    occurred_at: e.occurredAt ?? nowIso(),
    created_at: nowIso(),
  });
  return id;
}

/** Replace estimated events of a kind for an order with a realized value (e.g. exact Stripe fee). */
export function realizeFinancialEvent(
  db: Db,
  orderId: string,
  kind: FinancialKind,
  amount: number,
  ref?: string,
): void {
  db.transaction(() => {
    db.run("DELETE FROM financial_events WHERE order_id=? AND kind=? AND estimated=1", [orderId, kind]);
    const store = db.get<{ store_id: string }>("SELECT store_id FROM orders WHERE id=?", [orderId]);
    recordFinancialEvent(db, { storeId: store?.store_id, orderId, kind, amount, estimated: false, ref });
  });
}

export interface ProfitStatement {
  grossRevenue: number;
  discounts: number;
  refunds: number;
  taxes: number;
  stripeFees: number;
  supplierCost: number;
  shipping: number;
  chargebacks: number;
  otherVariableCost: number;
  grossProfit: number;
  estimatedNetProfit: number;
  realizedNetProfit: number;
  orders: number;
}

/**
 * Money filter for statements. TEST orders (Stripe test mode) and SIMULATION orders go through the same
 * ledger as real ones so the logic is identical, but they must never be read as revenue: callers that
 * present commercial numbers pass `{ modes: ["LIVE"] }` (or the current runtime mode) and show the rest
 * separately. No filter = everything, which is what the simulation and the tests want.
 */
export interface StatementFilter {
  modes?: string[];
}

export function profitStatement(
  db: Db,
  storeId?: string,
  from?: string,
  to?: string,
  filter: StatementFilter = {},
): ProfitStatement {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (storeId) {
    where.push("store_id=?");
    params.push(storeId);
  }
  if (filter.modes?.length) {
    where.push(`mode IN (${filter.modes.map(() => "?").join(",")})`);
    params.push(...filter.modes);
  }
  if (from) {
    where.push("occurred_at>=?");
    params.push(from);
  }
  if (to) {
    where.push("occurred_at<=?");
    params.push(to);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.all<{ kind: FinancialKind; estimated: number; total: number }>(
    `SELECT kind, estimated, SUM(amount) AS total FROM financial_events ${w} GROUP BY kind, estimated`,
    params,
  );
  const sum = (kind: FinancialKind, estimated?: 0 | 1) =>
    rows
      .filter((r) => r.kind === kind && (estimated === undefined || r.estimated === estimated))
      .reduce((s, r) => s + Number(r.total), 0);
  const grossRevenue = sum("gross_revenue");
  const discounts = sum("discount");
  const refunds = sum("refund");
  const taxes = sum("tax");
  const stripeFees = sum("payment_fee");
  const supplierCost = sum("supplier_cost");
  const shipping = sum("shipping_cost");
  const chargebacks = sum("chargeback") + sum("chargeback_fee");
  const other = sum("other_variable_cost");
  const grossProfit = grossRevenue + discounts + refunds + taxes + supplierCost + shipping;
  const estimatedNetProfit = grossProfit + stripeFees + chargebacks + other;
  // realized = only non-estimated rows
  const realized = rows
    .filter((r) => r.estimated === 0 && r.kind !== "payout")
    .reduce((s, r) => s + Number(r.total), 0);
  const ordersRow = db.get<{ c: number }>(
    `SELECT COUNT(DISTINCT order_id) AS c FROM financial_events ${w ? `${w} AND` : "WHERE"} kind='gross_revenue'`,
    params,
  );
  return {
    grossRevenue,
    discounts,
    refunds,
    taxes,
    stripeFees,
    supplierCost,
    shipping,
    chargebacks,
    otherVariableCost: other,
    grossProfit,
    estimatedNetProfit,
    realizedNetProfit: realized,
    orders: ordersRow?.c ?? 0,
  };
}

/** Book the estimated economics of a paid order (gross, tax, fee, supplier cost, shipping) from its cashflow JSON. */
export function bookOrderEstimates(db: Db, orderId: string): void {
  const o = db.get<{
    store_id: string;
    grand_total: number;
    cashflow: string;
    currency: string;
    paid_at: string;
  }>("SELECT store_id, grand_total, cashflow, currency, paid_at FROM orders WHERE id=?", [orderId]);
  if (!o) throw new Error(`order ${orderId} not found`);
  const cf = parseJson<CashflowBreakdown | null>(o.cashflow, null);
  if (!cf) throw new Error(`order ${orderId} has no cashflow breakdown`);
  const at = o.paid_at ?? nowIso();
  const existing = db.get<{ c: number }>(
    "SELECT COUNT(*) c FROM financial_events WHERE order_id=? AND kind='gross_revenue'",
    [orderId],
  );
  if ((existing?.c ?? 0) > 0) return; // idempotent
  const base = { storeId: o.store_id, orderId, currency: o.currency, occurredAt: at };
  recordFinancialEvent(db, { ...base, kind: "gross_revenue", amount: cf.customerPayment, estimated: false });
  recordFinancialEvent(db, { ...base, kind: "tax", amount: -cf.taxes, estimated: true });
  recordFinancialEvent(db, { ...base, kind: "payment_fee", amount: -cf.paymentFee, estimated: true });
  recordFinancialEvent(db, { ...base, kind: "supplier_cost", amount: -cf.productCost, estimated: true });
  recordFinancialEvent(db, { ...base, kind: "shipping_cost", amount: -cf.supplierShipping, estimated: true });
}
