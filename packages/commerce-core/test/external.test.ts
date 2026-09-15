import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, setSetting } from "@astro/db";
import { describe, expect, it } from "vitest";
import {
  allProviderStatuses,
  computeLaunchChecklist,
  computeReadinessScores,
  computeStoreExternalReadiness,
  EXTERNAL_WEIGHTS,
  latestEvidence,
  providerStatus,
  REDTEAM_RESULT_KEY,
  rankPilotCandidates,
  recordIntegrationEvidence,
} from "../src/index.ts";

const NO_ENV: NodeJS.ProcessEnv = {};
const STRIPE_ENV: NodeJS.ProcessEnv = {
  STRIPE_SECRET_KEY: "sk_test_UNIT_ONLY_0123456789abcdef",
  STRIPE_WEBHOOK_SECRET: "whsec_UNIT_ONLY_0123456789",
};

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  const ts = new Date().toISOString();
  db.run(
    "INSERT INTO stores(id,slug,name,status,lifecycle,config,created_at,updated_at) VALUES ('st1','lumen','Lumen','BUILDING','ACTIVE','{}',?,?)",
    [ts, ts],
  );
  return db;
}

function rootWithAcceptance(items: { id: string; status: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "astro-root-"));
  mkdirSync(join(root, "data", "reports"), { recursive: true });
  writeFileSync(
    join(root, "data", "reports", "acceptance.json"),
    JSON.stringify({ checkedAt: new Date().toISOString(), stores: [{ slug: "lumen", verdict: "x", items }] }),
  );
  return root;
}

describe("integration evidence and provider ladder", () => {
  it("never stores a secret, even when handed one as reference, detail or failure reason", () => {
    const db = freshDb();
    const planted = "sk_test_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
    const row = recordIntegrationEvidence(db, {
      provider: "stripe",
      capability: "auth",
      environment: "test",
      ok: false,
      reference: planted,
      failureReason: `Stripe rejected ${planted}`,
      detail: {
        key: planted,
        whsec: "whsec_0123456789abcdef",
        nested: { auth: "Bearer abcdefghijklmnopqrstuvwxyz" },
        fine: "acct_123",
      },
    });
    expect(row.reference).toBeNull();
    const stored = JSON.stringify(db.all("SELECT * FROM integration_evidence"));
    expect(stored).not.toContain(planted);
    expect(stored).not.toContain("whsec_0123456789abcdef");
    expect(stored).not.toMatch(/Bearer abcdefghijklmnopqrstuvwxyz/);
    expect(stored).toContain("acct_123");
    expect(latestEvidence(db, "stripe", "auth")?.ok).toBe(false);
    // the latest row wins, history is kept
    recordIntegrationEvidence(db, {
      provider: "stripe",
      capability: "auth",
      environment: "test",
      ok: true,
      reference: "acct_1",
    });
    expect(latestEvidence(db, "stripe", "auth")?.ok).toBe(true);
    expect(
      db.all("SELECT 1 FROM integration_evidence WHERE provider='stripe' AND capability='auth'"),
    ).toHaveLength(2);
  });

  it("moves a provider up the ladder only through executed checks; a present key is CONFIGURED and worth zero points", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "astro-root-"));
    const level = (env: NodeJS.ProcessEnv) => providerStatus(db, "stripe", env).level;
    const points = (env: NodeJS.ProcessEnv) =>
      computeReadinessScores(db, { root, env }).external.parts.find((p) => p.provider === "stripe")?.points;
    expect(level(NO_ENV)).toBe("NOT_CONFIGURED");
    expect(level(STRIPE_ENV)).toBe("CONFIGURED");
    expect(points(STRIPE_ENV)).toBe(0);

    recordIntegrationEvidence(db, {
      provider: "stripe",
      capability: "auth",
      environment: "test",
      ok: true,
      reference: "acct_1",
    });
    expect(level(STRIPE_ENV)).toBe("AUTHENTICATED");
    const authPoints = points(STRIPE_ENV) ?? 0;
    expect(authPoints).toBeGreaterThan(0);
    expect(authPoints).toBeLessThan(EXTERNAL_WEIGHTS.stripe ?? 0);

    recordIntegrationEvidence(db, {
      provider: "stripe",
      capability: "checkout",
      environment: "test",
      ok: true,
      reference: "cs_test_1",
    });
    expect(level(STRIPE_ENV)).toBe("TESTED");
    expect(points(STRIPE_ENV) ?? 0).toBeGreaterThan(authPoints);

    recordIntegrationEvidence(db, {
      provider: "stripe",
      capability: "webhook",
      environment: "test",
      ok: true,
      reference: "evt_1",
    });
    expect(level(STRIPE_ENV)).toBe("VERIFIED");
    expect(points(STRIPE_ENV)).toBe(EXTERNAL_WEIGHTS.stripe);
    expect(providerStatus(db, "stripe", STRIPE_ENV).lastVerifiedAt).toBeTruthy();

    // a failed re-check drops it to FAILED regardless of the earlier passes
    recordIntegrationEvidence(db, {
      provider: "stripe",
      capability: "webhook",
      environment: "test",
      ok: false,
      failureReason: "signature mismatch",
    });
    expect(level(STRIPE_ENV)).toBe("FAILED");
    expect(providerStatus(db, "stripe", STRIPE_ENV).failureReason).toContain("signature mismatch");
    expect(points(STRIPE_ENV)).toBe(0);

    // every provider is reported, and the configure hint names variables, never values
    const all = allProviderStatuses(db, STRIPE_ENV);
    expect(all.map((p) => p.provider)).toEqual([
      "stripe",
      "cj",
      "resend",
      "featherless",
      "meta",
      "cloudflare",
      "public",
    ]);
    for (const p of all) expect(p.configure).not.toContain(STRIPE_ENV.STRIPE_SECRET_KEY as string);
  });
});

describe("store external readiness and launch verdict", () => {
  it("computes store levels and the verdict from evidence only", () => {
    const db = freshDb();
    const root = rootWithAcceptance([
      { id: "build", status: "VERIFIED" },
      { id: "indexing", status: "VERIFIED" },
      { id: "storefront_runtime", status: "VERIFIED" },
      { id: "legal_identity", status: "NEEDS_OWNER" },
    ]);
    // nothing built, no products, no red team: NOT_READY store and NOT_READY verdict (system-side FAILs)
    let cl = computeLaunchChecklist(db, { root, env: NO_ENV });
    expect(cl.verdict).toBe("NOT_READY");
    expect(cl.stores[0]?.level).toBe("NOT_READY");
    expect(cl.stores[0]?.blockers).toContain("build");
    expect(cl.pilot).toBeNull();
    expect(cl.scores.external.score).toBe(0);

    // a clean recorded red team removes the last system-side FAIL: only owner/external items remain
    setSetting(
      db,
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
        at: new Date().toISOString(),
      },
      "test",
    );
    cl = computeLaunchChecklist(db, { root, env: NO_ENV });
    expect(cl.items.find((i) => i.id === "red_team")?.status).toBe("PASS");
    expect(cl.summary.FAIL).toBe(0);
    expect(cl.verdict).toBe("READY_FOR_EXTERNAL_SANDBOX");
    expect(cl.scores.internal.score).toBe(90);
    expect(cl.liveGate.ok).toBe(false);

    // the store cannot pass INTERNAL_TEST_READY without a build and an active product; evidence for other
    // stores never leaks into this one (detail.store scoping)
    recordIntegrationEvidence(db, {
      provider: "public",
      capability: "deployment",
      environment: "production",
      ok: true,
      reference: "https://other.pages.dev",
      detail: { store: "other" },
    });
    const r = computeStoreExternalReadiness(db, "st1", { root, env: NO_ENV });
    expect(r.level).toBe("NOT_READY");
    expect(r.conditions.find((c) => c.id === "deployed")?.ok).not.toBe(true);
    expect(r.conditions.find((c) => c.id === "build")?.needs).toBe("system");
    expect(r.conditions.find((c) => c.id === "catalogue")?.needs).toBe("external");
  });

  it("ranks pilot candidates deterministically and excludes stores with failed acceptance items or no build", () => {
    const db = freshDb();
    const ts = new Date().toISOString();
    db.run(
      "INSERT INTO stores(id,slug,name,status,lifecycle,config,created_at,updated_at) VALUES ('st2','nova','Nova','BUILDING','ACTIVE','{}',?,?)",
      [ts, ts],
    );
    const root = rootWithAcceptance([{ id: "build", status: "FAILED" }]);
    const ranking = rankPilotCandidates(db, { root });
    // both excluded (lumen: FAILED item; nova: no build) -> equal scores, deterministic slug order
    expect(ranking.map((c) => c.slug)).toEqual(["lumen", "nova"]);
    expect(ranking.every((c) => c.excluded)).toBe(true);
    expect(ranking.find((c) => c.slug === "lumen")?.excluded).toContain("FAILED");
    expect(ranking.find((c) => c.slug === "nova")?.excluded).toContain("no build");
    for (const c of ranking) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(Object.keys(c.components).sort()).toEqual([
        "availability",
        "compliance",
        "mappingQuality",
        "opportunity",
        "realSupplier",
        "shipping",
        "technical",
      ]);
    }
    expect(rankPilotCandidates(db, { root })).toEqual(ranking); // deterministic
  });
});
