import { migrate, openDb, setSetting } from "@astro/db";
import { describe, expect, it } from "vitest";
import {
  bookOrderEstimates,
  checkCashflow,
  checkMargin,
  computeCashflow,
  DEFAULT_ASSUMPTIONS,
  estimateRequiredFloat,
  profitStatement,
  realizeFinancialEvent,
} from "../src/index.ts";

describe("cashflow-engine", () => {
  it("computes the full breakdown with explicit assumptions", () => {
    const bd = computeCashflow({ customerPayment: 2990, productCost: 620, supplierShipping: 380 });
    // VAT 23% of 29.90 gross = 5.59
    expect(bd.taxes).toBe(559);
    // fee 1.9% + 0.25 = 0.57 + 0.25
    expect(bd.paymentFee).toBe(57 + 25);
    expect(bd.expectedReturnCost).toBe(Math.round(0.06 * (2990 - 559)));
    expect(bd.contingencyBuffer).toBe(90);
    const netSuccess = 2990 - 559 - 82 - 620 - 380;
    expect(bd.estimatedNetMargin).toBe(netSuccess - bd.expectedReturnCost - bd.expectedChargebackCost - 90);
    expect(bd.estimatedNetMarginPct).toBeGreaterThan(25);
  });

  it("blocks sales below the margin policy", () => {
    expect(checkMargin({ customerPayment: 1290, productCost: 900, supplierShipping: 300 }).ok).toBe(false);
    expect(checkMargin({ customerPayment: 3990, productCost: 900, supplierShipping: 300 }).ok).toBe(true);
    expect(checkMargin({ customerPayment: 900, productCost: 100, supplierShipping: 100 }).ok).toBe(false); // abs floor 5 EUR
  });

  it("cashflow guard fails closed with zero working capital and passes with owner float", () => {
    const db = openDb(":memory:");
    migrate(db);
    const v = checkCashflow(db, 1000);
    expect(v.ok).toBe(false);
    expect(v.bufferNeededCents).toBe(1000);
    setSetting(db, "cashflow.capital_snapshot", { stripeAvailableCents: 5000 }, "test");
    expect(checkCashflow(db, 1000).ok).toBe(true);
    expect(estimateRequiredFloat(3, 1000, DEFAULT_ASSUMPTIONS).initialCents).toBe(3 * 1000 * 14);
    db.close();
  });

  it("books order estimates and realizes fees without double counting", () => {
    const db = openDb(":memory:");
    migrate(db);
    const ts = new Date().toISOString();
    db.run("INSERT INTO stores(id,slug,name,created_at,updated_at) VALUES ('s1','s1','S',?,?)", [ts, ts]);
    const cf = computeCashflow({ customerPayment: 2990, productCost: 620, supplierShipping: 380 });
    db.run(
      "INSERT INTO orders(id,store_id,number,email,state,mode,grand_total,cashflow,paid_at,created_at,updated_at) VALUES ('o1','s1','AC-1','a@b.c','PAID','SIMULATION',2990,?,?,?,?)",
      [JSON.stringify(cf), ts, ts, ts],
    );
    bookOrderEstimates(db, "o1");
    bookOrderEstimates(db, "o1"); // idempotent
    let p = profitStatement(db, "s1");
    expect(p.grossRevenue).toBe(2990);
    expect(p.orders).toBe(1);
    expect(p.stripeFees).toBe(-82);
    realizeFinancialEvent(db, "o1", "payment_fee", -70, "txn_1");
    p = profitStatement(db, "s1");
    expect(p.stripeFees).toBe(-70);
    expect(p.estimatedNetProfit).toBe(2990 - 559 - 70 - 620 - 380);
    db.close();
  });
});
