import { describe, expect, it } from "vitest";
import {
  audit,
  getSetting,
  insert,
  logEvent,
  migrate,
  nowIso,
  openDb,
  scrubSecrets,
  setSetting,
  update,
} from "../src/index.ts";

describe("@astro/db", () => {
  it("migrates an in-memory database and applies all tables", () => {
    const db = openDb(":memory:");
    const applied = migrate(db);
    expect(applied.length).toBeGreaterThan(0);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name);
    for (const t of [
      "stores",
      "brands",
      "products",
      "product_variants",
      "suppliers",
      "supplier_products",
      "prices",
      "inventory",
      "customers",
      "orders",
      "order_items",
      "payments",
      "shipments",
      "refunds",
      "content",
      "social_accounts",
      "social_posts",
      "seo_pages",
      "analytics_events",
      "experiments",
      "jobs",
      "agents",
      "memories",
      "research_sources",
      "research_claims",
      "decisions",
      "financial_events",
      "system_events",
      "owner_actions",
      "credentials_metadata",
      "opportunities",
      "compliance_items",
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
    // idempotent
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  it("versions settings with history", () => {
    const db = openDb(":memory:");
    migrate(db);
    expect(getSetting(db, "x", 1)).toBe(1);
    expect(setSetting(db, "x", 2, "test", "first")).toBe(1);
    expect(setSetting(db, "x", 3, "test", "second")).toBe(2);
    expect(getSetting(db, "x", 1)).toBe(3);
    const hist = db.all("SELECT * FROM settings_history WHERE key='x' ORDER BY version");
    expect(hist).toHaveLength(2);
    db.close();
  });

  it("insert/update helpers work with FTS memory index", () => {
    const db = openDb(":memory:");
    migrate(db);
    insert(db, "memories", {
      id: "m1",
      kind: "SYSTEM",
      scope_id: null,
      title: "Stripe payout delay",
      body: "First payout arrives 7 to 14 days after first charge",
      tags: '["stripe","cashflow"]',
      importance: 0.9,
      source: "test",
      embedding: null,
      created_at: new Date().toISOString(),
    });
    const hits = db.all<{ id: string }>(
      "SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid=f.rowid WHERE memories_fts MATCH ?",
      ["payout"],
    );
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
    expect(update(db, "memories", "m1", { importance: 0.4 })).toBe(1);
    db.close();
  });

  it("regression (red team P2): time-window SQL compares ISO columns with ISO-formatted now, not datetime()", () => {
    // nowIso() stores 2026-09-11T05:00:00.000Z while datetime('now') yields 2026-09-11 05:00:00. Because ' ' < 'T',
    // `col < datetime('now','-1 hour')` was false for every row written on the same UTC day (sweeps ran a day late).
    const db = openDb(":memory:");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    // Fixed same-UTC-day literals document the trap deterministically: 09:00 is plainly earlier than 12:00, yet
    // because ' ' < 'T' the naive compare reports not-less-than. (A wall-clock `twoHoursAgo` vs datetime('now')
    // pair crosses the UTC day boundary in the ~2 h after midnight, where the differing date — not the separator —
    // governs the compare, so it cannot demonstrate the trap reliably.)
    const wrong = db.get<{ hit: number }>(
      "SELECT ('2026-09-13T09:00:00.000Z' < datetime('2026-09-13 12:00:00')) AS hit",
    );
    expect(wrong?.hit).toBe(0); // documents the trap
    const right = db.get<{ hit: number }>(
      "SELECT (? < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')) AS hit",
      [twoHoursAgo],
    );
    expect(right?.hit).toBe(1);
    const fresh = db.get<{ hit: number }>(
      "SELECT (? < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')) AS hit",
      [nowIso()],
    );
    expect(fresh?.hit).toBe(0);
    db.close();
  });

  it("regression (red team, INV09): system_events, audit_log and env-shaped values are scrubbed at the sink", () => {
    const db = openDb(":memory:");
    migrate(db);
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_UNIT_TEST_VALUE_0123456789abcdef";
    try {
      // Synthetic fixture: assembled at runtime to avoid resembling a committed credential.
      const planted = ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "0123"].join("_");
      logEvent(db, "error", "test", `stripe said ${planted}`, {
        key: planted,
        resend: process.env.RESEND_API_KEY,
        nested: { auth: "Bearer abcdefghijklmnopqrstuvwxyz" },
      });
      audit(
        db,
        "owner:test",
        "settings.update",
        { type: "setting", id: "x" },
        { token: planted },
        { token: process.env.RESEND_API_KEY },
      );
      const texts = [
        ...db
          .all<{ t: string }>("SELECT COALESCE(event,'') || COALESCE(data,'') t FROM system_events")
          .map((r) => r.t),
        ...db
          .all<{ t: string }>("SELECT COALESCE(before,'') || COALESCE(after,'') t FROM audit_log")
          .map((r) => r.t),
      ];
      expect(texts.length).toBe(2);
      for (const t of texts) {
        expect(t).not.toContain(planted);
        expect(t).not.toContain(process.env.RESEND_API_KEY as string);
        expect(t).not.toMatch(/Bearer abcdefghijklmnopqrstuvwxyz/);
      }
      expect(scrubSecrets("nothing secret here 12345")).toBe("nothing secret here 12345");
      // regression (external sandbox): identifiers that merely contain "re_" or "sk-" are not secrets
      const plain =
        '{"compare_at_evidence":1,"pre_purchase":true,"score_threshold":5,"desk-lamp-organizer-set":2}';
      expect(scrubSecrets(plain)).toBe(plain);
      expect(scrubSecrets("re_placeholder_0123456789abcdefFAKEKEY")).toBe("[REDACTED]");
      // a Stripe refund id is not a Resend key
      expect(scrubSecrets("refund re_3SGx1kGgVW2fWBCR0AbCdEfG done")).toBe(
        "refund re_3SGx1kGgVW2fWBCR0AbCdEfG done",
      );
      expect(scrubSecrets("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED]");
    } finally {
      if (prev === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
      db.close();
    }
  });
});
