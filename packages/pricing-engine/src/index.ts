import {
  type CashflowAssumptions,
  checkMargin,
  computeCashflow,
  DEFAULT_ASSUMPTIONS,
  getAssumptions,
} from "@astro/cashflow-engine";
import { charmPrice, newId } from "@astro/commerce-core";
import { type Db, insert, nowIso, parseJson } from "@astro/db";
import type { CashflowBreakdown } from "@astro/shared-types";

/**
 * PRICING ENGINE.
 * Finds the lowest charm-rounded consumer price that satisfies the net-margin policy, then nudges toward
 * a target margin and (optionally) toward competitor positioning. Never returns a price below the floor.
 */
export interface PricingInput {
  costCents: number; // supplier product cost in EUR cents (per unit)
  shippingCents: number; // supplier shipping to primary market (per order, assume 1 unit)
  returnProbability?: number;
  targetNetMarginPct?: number; // e.g. 35
  competitorMinCents?: number;
  competitorMaxCents?: number;
  positioning?: "value" | "mid" | "premium";
  vatRatePct?: number;
}

export interface PricingResult {
  priceCents: number;
  floorCents: number; // minimum price satisfying margin policy
  breakdown: CashflowBreakdown;
  rationale: string[];
  blocked: boolean;
  blockReason?: string;
}

export function priceFloor(input: PricingInput, a: CashflowAssumptions): number {
  // Binary search for the lowest gross price that passes checkMargin.
  let lo = input.costCents + input.shippingCents;
  let hi = Math.max(lo * 6, lo + 20000);
  const passes = (p: number) =>
    checkMargin(
      {
        customerPayment: p,
        productCost: input.costCents,
        supplierShipping: input.shippingCents,
        returnProbability: input.returnProbability,
        vatRatePct: input.vatRatePct,
      },
      a,
    ).ok;
  if (!passes(hi)) return -1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function proposePrice(
  input: PricingInput,
  a: CashflowAssumptions = DEFAULT_ASSUMPTIONS,
): PricingResult {
  const rationale: string[] = [];
  const floor = priceFloor(input, a);
  if (floor < 0) {
    return {
      priceCents: 0,
      floorCents: -1,
      breakdown: computeCashflow(
        { customerPayment: 0, productCost: input.costCents, supplierShipping: input.shippingCents },
        a,
      ),
      rationale: ["no price satisfies margin policy within 6x cost"],
      blocked: true,
      blockReason: "unpriceable",
    };
  }
  rationale.push(`floor for ${a.minNetMarginPct}% net / ${a.minNetMarginAbs} cents abs = ${floor}`);

  const target = input.targetNetMarginPct ?? Math.max(a.minNetMarginPct + 10, 35);
  let candidate = floor;
  // walk up until target margin reached (bounded)
  for (let i = 0; i < 400; i++) {
    const bd = computeCashflow(
      {
        customerPayment: candidate,
        productCost: input.costCents,
        supplierShipping: input.shippingCents,
        returnProbability: input.returnProbability,
        vatRatePct: input.vatRatePct,
      },
      a,
    );
    if (bd.estimatedNetMarginPct >= target) break;
    candidate += 50;
  }
  rationale.push(`target net margin ${target}% reached near ${candidate}`);

  // competitor positioning
  if (input.competitorMinCents && input.competitorMaxCents) {
    const pos = input.positioning ?? "mid";
    const anchor =
      pos === "value"
        ? input.competitorMinCents
        : pos === "premium"
          ? input.competitorMaxCents
          : Math.round((input.competitorMinCents + input.competitorMaxCents) / 2);
    if (anchor > candidate) {
      // room to price up toward market without hurting conversion badly: take 60% of the gap
      candidate = candidate + Math.round((anchor - candidate) * 0.6);
      rationale.push(`moved 60% toward ${pos} competitor anchor ${anchor}`);
    } else if (anchor < candidate) {
      rationale.push(
        `competitor anchor ${anchor} below our margin-driven price ${candidate}; keeping margin`,
      );
    }
  }

  let price = charmPrice(candidate);
  if (price < floor) price = charmPrice(floor + 100);
  const breakdown = computeCashflow(
    {
      customerPayment: price,
      productCost: input.costCents,
      supplierShipping: input.shippingCents,
      returnProbability: input.returnProbability,
      vatRatePct: input.vatRatePct,
    },
    a,
  );
  rationale.push(`charm-rounded to ${price}, net margin ${breakdown.estimatedNetMarginPct}%`);
  return { priceCents: price, floorCents: floor, breakdown, rationale, blocked: false };
}

/** Bundle economics: bundle price must beat sum-of-parts for the customer but keep policy margin. */
export function proposeBundlePrice(
  parts: { costCents: number; shippingCents: number; priceCents: number }[],
  discountPct = 12,
  a: CashflowAssumptions = DEFAULT_ASSUMPTIONS,
): PricingResult {
  const cost = parts.reduce((s, p) => s + p.costCents, 0);
  // shipping: assume supplier consolidates, take max + 40% of the rest
  const sorted = parts.map((p) => p.shippingCents).sort((x, y) => y - x);
  const shipping = (sorted[0] ?? 0) + Math.round(sorted.slice(1).reduce((s, x) => s + x, 0) * 0.4);
  const sumParts = parts.reduce((s, p) => s + p.priceCents, 0);
  const wanted = Math.round(sumParts * (1 - discountPct / 100));
  const floor = priceFloor({ costCents: cost, shippingCents: shipping }, a);
  const price = charmPrice(Math.max(wanted, floor));
  const breakdown = computeCashflow(
    { customerPayment: price, productCost: cost, supplierShipping: shipping },
    a,
  );
  return {
    priceCents: price,
    floorCents: floor,
    breakdown,
    rationale: [`sum of parts ${sumParts}, ${discountPct}% off -> ${wanted}, floor ${floor}`],
    blocked: floor < 0,
    blockReason: floor < 0 ? "unpriceable" : undefined,
  };
}

/** Persist an active price for a variant (deactivating the previous one). Blocks the variant if unpriceable. */
export function setVariantPrice(
  db: Db,
  variantId: string,
  input: PricingInput,
  createdBy = "pricing-engine",
  compareAt?: { amount: number; evidence: string },
): PricingResult {
  const a = getAssumptions(db);
  const result = proposePrice(input, a);
  const ts = nowIso();
  db.transaction(() => {
    if (result.blocked) {
      db.run("UPDATE product_variants SET status='blocked', block_reason=?, updated_at=? WHERE id=?", [
        `pricing: ${result.blockReason}`,
        ts,
        variantId,
      ]);
      return;
    }
    db.run("UPDATE prices SET active=0, valid_to=? WHERE variant_id=? AND active=1", [ts, variantId]);
    insert(db, "prices", {
      id: newId("prc"),
      variant_id: variantId,
      currency: "EUR",
      amount: result.priceCents,
      compare_at: compareAt?.amount ?? null,
      compare_at_evidence: compareAt?.evidence ?? null,
      cost_snapshot: input.costCents,
      margin_breakdown: JSON.stringify(result.breakdown),
      active: 1,
      valid_from: ts,
      valid_to: null,
      created_by: createdBy,
    });
    db.run("UPDATE product_variants SET status='active', block_reason=NULL, updated_at=? WHERE id=?", [
      ts,
      variantId,
    ]);
  });
  return result;
}

export function getActivePrice(
  db: Db,
  variantId: string,
): { amount: number; currency: string; breakdown: CashflowBreakdown | null } | null {
  const row = db.get<{ amount: number; currency: string; margin_breakdown: string }>(
    "SELECT amount, currency, margin_breakdown FROM prices WHERE variant_id=? AND active=1 ORDER BY valid_from DESC LIMIT 1",
    [variantId],
  );
  if (!row) return null;
  return {
    amount: row.amount,
    currency: row.currency,
    breakdown: parseJson<CashflowBreakdown | null>(row.margin_breakdown, null),
  };
}
