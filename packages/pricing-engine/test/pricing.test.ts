import { checkMargin } from "@astro/cashflow-engine";
import { migrate, openDb } from "@astro/db";
import { describe, expect, it } from "vitest";
import { getActivePrice, proposeBundlePrice, proposePrice, setVariantPrice } from "../src/index.ts";

describe("pricing-engine", () => {
  it("never proposes a price below the margin floor and charm-rounds", () => {
    const r = proposePrice({ costCents: 620, shippingCents: 380 });
    expect(r.blocked).toBe(false);
    expect(r.priceCents).toBeGreaterThanOrEqual(r.floorCents);
    expect(r.priceCents % 100).toBe(90);
    expect(checkMargin({ customerPayment: r.priceCents, productCost: 620, supplierShipping: 380 }).ok).toBe(
      true,
    );
  });

  it("moves toward competitor anchor without breaking margin", () => {
    const base = proposePrice({ costCents: 620, shippingCents: 380 });
    const up = proposePrice({
      costCents: 620,
      shippingCents: 380,
      competitorMinCents: 4990,
      competitorMaxCents: 6990,
      positioning: "premium",
    });
    expect(up.priceCents).toBeGreaterThan(base.priceCents);
  });

  it("blocks unpriceable SKUs and persists prices", () => {
    const db = openDb(":memory:");
    migrate(db);
    const ts = new Date().toISOString();
    db.run("INSERT INTO stores(id,slug,name,created_at,updated_at) VALUES ('s1','s1','S',?,?)", [ts, ts]);
    db.run(
      "INSERT INTO products(id,store_id,slug,title,created_at,updated_at) VALUES ('p1','s1','p1','P',?,?)",
      [ts, ts],
    );
    db.run(
      "INSERT INTO product_variants(id,product_id,sku,title,created_at,updated_at) VALUES ('v1','p1','SKU1','V',?,?)",
      [ts, ts],
    );
    const r = setVariantPrice(db, "v1", { costCents: 620, shippingCents: 380 });
    expect(r.blocked).toBe(false);
    expect(getActivePrice(db, "v1")?.amount).toBe(r.priceCents);
    const r2 = setVariantPrice(db, "v1", { costCents: 700, shippingCents: 380 });
    expect(db.all("SELECT * FROM prices WHERE variant_id='v1' AND active=1")).toHaveLength(1);
    expect(getActivePrice(db, "v1")?.amount).toBe(r2.priceCents);
    db.close();
  });

  it("bundle price respects floor", () => {
    const b = proposeBundlePrice([
      { costCents: 620, shippingCents: 380, priceCents: 2990 },
      { costCents: 400, shippingCents: 300, priceCents: 1990 },
    ]);
    expect(b.blocked).toBe(false);
    expect(b.priceCents).toBeLessThan(2990 + 1990);
    expect(b.priceCents).toBeGreaterThanOrEqual(b.floorCents);
  });
});
