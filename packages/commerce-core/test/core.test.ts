import { migrate, openDb, setSetting } from "@astro/db";
import { describe, expect, it } from "vitest";
import {
  canEnterLiveMode,
  canTransition,
  charmPrice,
  getKillSwitches,
  getMode,
  InvalidTransition,
  LiveModeBlocked,
  newId,
  newOrderNumber,
  pauseAutonomy,
  pct,
  REDTEAM_RESULT_KEY,
  redact,
  setMode,
  slugify,
  transitionOrder,
  vatFromGross,
} from "../src/index.ts";

function db() {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

describe("commerce-core", () => {
  it("ids and slugs", () => {
    expect(newId("ord")).toMatch(/^ord_[0-9A-Z]{19}$/);
    expect(newOrderNumber("AC")).toMatch(/^AC-[0-9A-Z]{6}$/);
    expect(slugify("Cozinha & Café à Noite!")).toBe("cozinha-cafe-a-noite");
  });

  it("money helpers are integer-safe", () => {
    expect(pct(10000, 1.5)).toBe(150);
    expect(pct(2999, 23)).toBe(690);
    expect(vatFromGross(12300, 23)).toBe(2300);
    expect(charmPrice(2412)).toBe(2490);
    expect(charmPrice(13200)).toBe(13900);
    expect(charmPrice(750)).toBe(790);
    // regression (red team P2): exact multiples used to round DOWN below the margin floor (2000 -> 1990, 11000 -> 10900)
    expect(charmPrice(2000)).toBe(2090);
    expect(charmPrice(11000)).toBe(11900);
    expect(charmPrice(10000)).toBe(10900);
    // property: never below the input, deterministic, charm ending kept
    let x = 1;
    for (let i = 0; i < 5000; i++) {
      x = (x * 48271) % 2147483647;
      const c = x % 500_000;
      const p = charmPrice(c);
      expect(p).toBeGreaterThanOrEqual(c);
      expect(charmPrice(c)).toBe(p);
      if (c >= 1000 && c < 10000) expect(p % 100).toBe(90);
      if (c >= 10000) expect(p % 1000).toBe(900);
    }
    expect(() => charmPrice(Number.NaN)).toThrow();
  });

  it("order state machine validates transitions and records history", () => {
    const d = db();
    const ts = new Date().toISOString();
    d.run("INSERT INTO stores(id,slug,name,created_at,updated_at) VALUES ('st1','s1','S1',?,?)", [ts, ts]);
    d.run(
      "INSERT INTO orders(id,store_id,number,email,state,mode,created_at,updated_at) VALUES ('o1','st1','AC-1','a@b.c','CREATED','SIMULATION',?,?)",
      [ts, ts],
    );
    expect(canTransition("CREATED", "PAID")).toBe(true);
    expect(canTransition("CREATED", "SHIPPED")).toBe(false);
    expect(transitionOrder(d, "o1", "PAID", "test")).toBe("PAID");
    expect(transitionOrder(d, "o1", "VALIDATING", "test")).toBe("VALIDATING");
    expect(() => transitionOrder(d, "o1", "DELIVERED", "test")).toThrow(InvalidTransition);
    // idempotent
    expect(transitionOrder(d, "o1", "VALIDATING", "test")).toBe("VALIDATING");
    const hist = d.all("SELECT to_state FROM order_transitions WHERE order_id='o1' ORDER BY id");
    expect(hist.map((h) => h.to_state)).toEqual(["PAID", "VALIDATING"]);
    const paid = d.get<{ paid_at: string }>("SELECT paid_at FROM orders WHERE id='o1'");
    expect(paid?.paid_at).toBeTruthy();
  });

  it("mode never becomes LIVE silently and kill switches work", () => {
    const d = db();
    expect(getMode(d)).toBe("DEVELOPMENT");
    expect(() => setMode(d, "LIVE", "system", "x")).toThrow();
    expect(() => setMode(d, "LIVE", "agent:ORDER_OPERATOR", "x")).toThrow();
    expect(() => setMode(d, "LIVE", "simulate", "some script")).toThrow(); // allowlist: only owner:*
    expect(() => setMode(d, "LIVE", "owner:alex", "")).toThrow(); // a reason is mandatory
    setMode(d, "SIMULATION", "system", "tests");
    expect(getMode(d)).toBe("SIMULATION");
    // HARD GATE: even the owner cannot enter LIVE while critical blockers exist (empty env, no store, no red team).
    expect(() => setMode(d, "LIVE", "owner:alex", "approved")).toThrow(LiveModeBlocked);
    expect(getMode(d)).toBe("SIMULATION");
    const gate = canEnterLiveMode(d, {});
    expect(gate.ok).toBe(false);
    const ids = gate.blockers.map((b) => b.id);
    for (const id of [
      "stripe_secret_missing",
      "stripe_webhook_secret_missing",
      "email_provider_missing",
      "admin_token_weak",
      "no_revenue_ready_store",
      "redteam_not_run",
    ])
      expect(ids).toContain(id);
    // With every blocker satisfied the gate opens; the env values are never stored anywhere.
    const ts = new Date().toISOString();
    d.run(
      "INSERT INTO stores(id,slug,name,status,currency,markets,locale,config,paused,compliance_report,created_at,updated_at) VALUES ('s1','s1','S1','REVENUE_READY','EUR','[\"PT\"]','pt-PT','{}',0,'{}',?,?)",
      [ts, ts],
    );
    setSetting(
      d,
      REDTEAM_RESULT_KEY,
      {
        seed: 1,
        runs: 500,
        scenarios: 10,
        failures: 0,
        p0: 0,
        p1: 0,
        invariantViolations: 0,
        score: 90,
        at: ts,
      },
      "test",
    );
    const okEnv = {
      STRIPE_SECRET_KEY: "sk_live_PLACEHOLDER_NOT_A_KEY",
      STRIPE_WEBHOOK_SECRET: "whsec_PLACEHOLDER_NOT_A_KEY",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_PLACEHOLDER",
      EMAIL_FROM_DOMAIN: "mail.example.com",
      ADMIN_TOKEN: "0123456789abcdef0123456789abcdef",
    };
    expect(canEnterLiveMode(d, okEnv).ok).toBe(true);
    // A critical BLOCKING compliance item closes the gate again.
    d.run(
      "INSERT INTO compliance_items(id,store_id,requirement,area,status,critical,updated_at) VALUES ('s1:x','s1','x','IDENTITY','BLOCKING',1,?)",
      [ts],
    );
    expect(canEnterLiveMode(d, okEnv).blockers.map((b) => b.id)).toContain("compliance_blocking:s1:x");
    for (const [k, v] of Object.entries(okEnv)) process.env[k] = v;
    d.run("DELETE FROM compliance_items WHERE id='s1:x'");
    try {
      setMode(d, "LIVE", "owner:alex", "approved");
      expect(getMode(d)).toBe("LIVE");
    } finally {
      for (const k of Object.keys(okEnv)) delete process.env[k];
    }
    // No value of the environment leaked into the audited settings or events.
    const dump =
      JSON.stringify(d.all("SELECT * FROM settings")) + JSON.stringify(d.all("SELECT * FROM system_events"));
    expect(dump).not.toContain("PLACEHOLDER_NOT_A_KEY");
    pauseAutonomy(d, true, "owner:alex", "test");
    expect(getKillSwitches(d).autonomyPaused).toBe(true);
  });

  it("redacts secrets", () => {
    process.env.TEST_SECRET_KEY = "supersecretvalue123456";
    const out = redact("key sk_test_abcdefghijklmnop and supersecretvalue123456 and whsec_1234567890abc");
    expect(out).not.toContain("sk_test_abcdefghijklmnop");
    expect(out).not.toContain("supersecretvalue123456");
    expect(out).not.toContain("whsec_1234567890abc");
  });
});

describe("loadEnv", () => {
  it("treats `KEY=   # comment` as empty and keeps real values (regression: comments were read as secrets)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadEnv } = await import("../src/env.ts");
    const dir = mkdtempSync(join(tmpdir(), "astro-env-"));
    writeFileSync(
      join(dir, ".env"),
      [
        "TEST_EMPTY_WITH_COMMENT=     # shared between core and edge",
        "TEST_VALUE_WITH_COMMENT=abc # trailing note",
        'TEST_QUOTED="keep # this"',
        "TEST_PLAIN=xyz",
      ].join("\n"),
    );
    for (const k of ["TEST_EMPTY_WITH_COMMENT", "TEST_VALUE_WITH_COMMENT", "TEST_QUOTED", "TEST_PLAIN"])
      delete process.env[k];
    loadEnv(dir);
    expect(process.env.TEST_EMPTY_WITH_COMMENT).toBe("");
    expect(process.env.TEST_VALUE_WITH_COMMENT).toBe("abc");
    expect(process.env.TEST_QUOTED).toBe("keep # this");
    expect(process.env.TEST_PLAIN).toBe("xyz");
  });
});
