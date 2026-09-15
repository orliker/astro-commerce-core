import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, getSetting, parseJson } from "@astro/db";
import {
  allProviderStatuses,
  type IntegrationEvidence,
  type IntegrationProvider,
  LEVEL_CREDIT,
  type ProviderStatus,
} from "./integration-evidence.ts";
import { canEnterLiveMode, REDTEAM_RESULT_KEY, type RedTeamSummary } from "./live-gate.ts";

/**
 * EXTERNAL READINESS per store. Five levels, each one earned from facts the platform can check:
 *   NOT_READY                   something technical is missing (build, catalogue, acceptance)
 *   INTERNAL_TEST_READY         builds, has sellable products, passes the internal suites (simulation only)
 *   READY_FOR_EXTERNAL_SANDBOX  internal + Stripe test keys configured + legal pages present
 *   REVENUE_READY_TEST          deployed on a public host and every external provider proven against the real
 *                               system in TEST mode: Stripe checkout + webhook, supplier data validated read-only,
 *                               email delivered, LLM completion + policy + memory, public end-to-end order
 *   REVENUE_READY_LIVE          the store status is REVENUE_READY (compliance closed) AND the LIVE hard gate is open
 * TEST is never LIVE: REVENUE_READY_TEST means the machinery works with test money, nothing more.
 */
export type ExternalReadinessLevel =
  | "NOT_READY"
  | "INTERNAL_TEST_READY"
  | "READY_FOR_EXTERNAL_SANDBOX"
  | "REVENUE_READY_TEST"
  | "REVENUE_READY_LIVE";

export const EXTERNAL_LEVELS: ExternalReadinessLevel[] = [
  "NOT_READY",
  "INTERNAL_TEST_READY",
  "READY_FOR_EXTERNAL_SANDBOX",
  "REVENUE_READY_TEST",
  "REVENUE_READY_LIVE",
];

export interface ReadinessCondition {
  id: string;
  title: string;
  /** true = proven, false = proven missing, null = never checked */
  ok: boolean | null;
  detail: string;
  /** which level first requires this condition */
  requiredFor: ExternalReadinessLevel;
  /** who unblocks it */
  needs: "system" | "owner" | "external";
}

export interface StoreExternalReadiness {
  storeId: string;
  slug: string;
  name: string;
  status: string;
  level: ExternalReadinessLevel;
  conditions: ReadinessCondition[];
  /** condition ids that stop the next level */
  blockers: string[];
  nextLevel: ExternalReadinessLevel | null;
  checkedAt: string;
}

export interface ReadinessOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
}

const LEGAL_PLACEHOLDER = "[dados do vendedor por preencher]";

interface AcceptanceReport {
  checkedAt: string;
  stores: { slug: string; items: { id: string; status: string; detail?: string }[]; verdict: string }[];
}

function readAcceptance(root: string): AcceptanceReport | null {
  const p = join(root, "data", "reports", "acceptance.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AcceptanceReport;
  } catch {
    return null;
  }
}

/** Latest evidence for a capability scoped to one store (detail.store) */
export function latestStoreEvidence(
  db: Db,
  provider: IntegrationProvider,
  capability: string,
  slug: string,
): IntegrationEvidence | null {
  const rows = latestEvidenceHistory(db, provider, capability);
  return rows.find((e) => e.detail?.store === slug) ?? null;
}

function latestEvidenceHistory(
  db: Db,
  provider: IntegrationProvider,
  capability: string,
): IntegrationEvidence[] {
  const rows = db.all<{
    id: string;
    provider: string;
    capability: string;
    environment: string;
    ok: number;
    reference: string | null;
    latency_ms: number | null;
    failure_reason: string | null;
    detail: string | null;
    actor: string;
    tested_at: string;
  }>(
    "SELECT * FROM integration_evidence WHERE provider=? AND capability=? ORDER BY tested_at DESC, id DESC LIMIT 100",
    [provider, capability],
  );
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as IntegrationProvider,
    capability: r.capability,
    environment: r.environment as IntegrationEvidence["environment"],
    ok: r.ok === 1,
    reference: r.reference,
    latencyMs: r.latency_ms,
    failureReason: r.failure_reason,
    detail: r.detail ? parseJson<Record<string, unknown> | null>(r.detail, null) : null,
    actor: r.actor,
    testedAt: r.tested_at,
  }));
}

function legalPagesState(root: string, slug: string): { present: number; placeholders: number } {
  const dir = join(root, "apps", "storefront", "dist", slug, "legal");
  if (!existsSync(dir)) return { present: 0, placeholders: 0 };
  let present = 0;
  let placeholders = 0;
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".html")) {
        present++;
        if (readFileSync(p, "utf8").includes(LEGAL_PLACEHOLDER)) placeholders++;
      }
    }
  };
  walk(dir);
  return { present, placeholders };
}

export function computeStoreExternalReadiness(
  db: Db,
  storeId: string,
  opts: ReadinessOptions,
  providers?: ProviderStatus[],
): StoreExternalReadiness {
  const env = opts.env ?? process.env;
  const store = db.get<{
    id: string;
    slug: string;
    name: string;
    status: string;
    domain: string | null;
    config: string;
  }>("SELECT id, slug, name, status, domain, config FROM stores WHERE id=?", [storeId]);
  if (!store) throw new Error(`store ${storeId} not found`);
  const cfg = parseJson<{ temporaryHost?: string }>(store.config, {});
  const ps = providers ?? allProviderStatuses(db, env);
  const level = (p: IntegrationProvider) => ps.find((x) => x.provider === p)?.level ?? "NOT_CONFIGURED";
  const conds: ReadinessCondition[] = [];
  const push = (c: ReadinessCondition) => conds.push(c);

  // ---- INTERNAL_TEST_READY ----
  const built = existsSync(join(opts.root, "apps", "storefront", "dist", store.slug, "index.html"));
  push({
    id: "build",
    title: "Static storefront built",
    ok: built,
    detail: built ? `apps/storefront/dist/${store.slug}` : "no build (npm run store:build)",
    requiredFor: "INTERNAL_TEST_READY",
    needs: "system",
  });
  const sellable =
    db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT p.id) c FROM products p JOIN product_variants v ON v.product_id=p.id JOIN prices pr ON pr.variant_id=v.id AND pr.active=1
        WHERE p.store_id=? AND p.status='active' AND v.status='active'`,
      [store.id],
    )?.c ?? 0;
  const drafts =
    db.get<{ c: number }>("SELECT COUNT(*) c FROM products WHERE store_id=? AND status='draft'", [store.id])
      ?.c ?? 0;
  push({
    id: "catalogue",
    title: "At least one active, priced product (three for REVENUE_READY_TEST)",
    ok: sellable >= 1,
    detail: `${sellable} active sellable product(s), ${drafts} draft${drafts && !sellable ? " (draft until a real supplier mapping exists)" : ""}`,
    requiredFor: "INTERNAL_TEST_READY",
    needs: sellable >= 1 ? "system" : "external",
  });
  const acc = readAcceptance(opts.root);
  const accStore = acc?.stores.find((s) => s.slug === store.slug) ?? null;
  const technicalIds = ["build", "indexing", "storefront_runtime"];
  const accTech = accStore
    ? technicalIds.every((id) => accStore.items.find((i) => i.id === id)?.status === "VERIFIED") &&
      !accStore.items.some((i) => i.status === "FAILED")
    : null;
  push({
    id: "acceptance_technical",
    title: "Technical acceptance items verified, none failed",
    ok: accTech,
    detail: accStore
      ? `${accStore.items.filter((i) => i.status === "VERIFIED").length} verified, ${accStore.items.filter((i) => i.status === "NEEDS_OWNER").length} need the owner, ${accStore.items.filter((i) => i.status === "FAILED").length} failed (${acc?.checkedAt})`
      : "no acceptance report for this store (npm run acceptance)",
    requiredFor: "INTERNAL_TEST_READY",
    needs: "system",
  });
  const rt = getSetting<RedTeamSummary | null>(db, REDTEAM_RESULT_KEY, null);
  const rtOk = !!rt && rt.p0 === 0 && rt.p1 === 0 && rt.invariantViolations === 0 && rt.runs >= 500;
  push({
    id: "financial_guards",
    title: "Financial guards and invariants proven (recorded red team)",
    ok: rt ? rtOk : null,
    detail: rt
      ? `seed ${rt.seed}, ${rt.runs} runs, P0 ${rt.p0}, P1 ${rt.p1}, violations ${rt.invariantViolations}`
      : "no recorded run",
    requiredFor: "INTERNAL_TEST_READY",
    needs: "system",
  });

  // ---- READY_FOR_EXTERNAL_SANDBOX ----
  const stripeKeys = (env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
  push({
    id: "stripe_configured",
    title: "Stripe test key configured",
    ok: stripeKeys,
    detail: stripeKeys ? "sk_test_ key present (value never stored)" : "STRIPE_SECRET_KEY (sk_test_) missing",
    requiredFor: "READY_FOR_EXTERNAL_SANDBOX",
    needs: "owner",
  });
  const legal = legalPagesState(opts.root, store.slug);
  push({
    id: "legal_pages",
    title: "Legal pages present in the build",
    ok: legal.present > 0,
    detail: legal.present
      ? `${legal.present} legal page(s)${legal.placeholders ? `, ${legal.placeholders} still carry seller-identity placeholders` : ""}`
      : "no legal pages in the build",
    requiredFor: "READY_FOR_EXTERNAL_SANDBOX",
    needs: "system",
  });

  // ---- REVENUE_READY_TEST ----
  const host = store.domain ?? cfg.temporaryHost ?? null;
  const deployEv = latestStoreEvidence(db, "public", "deployment", store.slug);
  push({
    id: "deployed",
    title: "Storefront reachable on its public host (smoke test recorded)",
    ok: deployEv ? deployEv.ok && !!host : host ? null : false,
    detail: deployEv
      ? `${deployEv.ok ? "reachable" : "FAILED"} at ${deployEv.testedAt}: ${deployEv.reference ?? host ?? ""}`
      : host
        ? `host ${host} recorded, public smoke test not executed (npm run external:e2e -- --store ${store.slug} --smoke)`
        : "no public host (npx wrangler pages deploy after cloudflare:verify)",
    requiredFor: "REVENUE_READY_TEST",
    needs: host ? "system" : "owner",
  });
  push({
    id: "catalogue_pilot",
    title: "At least three active sellable products",
    ok: sellable >= 3,
    detail: `${sellable} active sellable product(s)`,
    requiredFor: "REVENUE_READY_TEST",
    needs: "external",
  });
  const stripeLevel = level("stripe");
  push({
    id: "stripe_verified",
    title: "Stripe TEST proven externally (auth + checkout + webhook)",
    ok: stripeLevel === "VERIFIED" ? true : stripeLevel === "FAILED" ? false : null,
    detail: `provider level ${stripeLevel}`,
    requiredFor: "REVENUE_READY_TEST",
    needs: "external",
  });
  const mapEv = latestStoreEvidence(db, "cj", "mapping", store.slug);
  push({
    id: "supplier_validated",
    title: "Supplier data for this store validated against the real CJ API (read-only)",
    ok: mapEv ? mapEv.ok : null,
    detail: mapEv
      ? `${mapEv.ok ? "validated" : "FAILED"} at ${mapEv.testedAt}: ${mapEv.failureReason ?? String(mapEv.detail?.summary ?? "")}`
      : "not executed (npm run cj:validate -- --store " + store.slug + ")",
    requiredFor: "REVENUE_READY_TEST",
    needs: "external",
  });
  const resendLevel = level("resend");
  push({
    id: "email_verified",
    title: "Transactional email proven externally (Resend)",
    ok: resendLevel === "VERIFIED" ? true : resendLevel === "FAILED" ? false : null,
    detail: `provider level ${resendLevel}`,
    requiredFor: "REVENUE_READY_TEST",
    needs: "external",
  });
  const llmLevel = level("featherless");
  push({
    id: "llm_verified",
    title: "LLM brain proven externally (completion, JSON, policy gate, memory)",
    ok: llmLevel === "VERIFIED" ? true : llmLevel === "FAILED" ? false : null,
    detail: `provider level ${llmLevel}`,
    requiredFor: "REVENUE_READY_TEST",
    needs: "external",
  });
  const e2e = latestStoreEvidence(db, "public", "e2e", store.slug);
  push({
    id: "public_e2e",
    title:
      "Public end-to-end TEST order (storefront -> Stripe test -> real webhook -> order -> gates -> email -> analytics -> ledger)",
    ok: e2e ? e2e.ok : null,
    detail: e2e
      ? `${e2e.ok ? "passed" : "FAILED"} at ${e2e.testedAt}${e2e.reference ? ` (${e2e.reference})` : ""}${e2e.failureReason ? `: ${e2e.failureReason}` : ""}`
      : "not executed",
    requiredFor: "REVENUE_READY_TEST",
    needs: "external",
  });
  push({
    id: "analytics_validated",
    title: "Analytics pipeline recorded the public test order",
    ok: e2e ? e2e.detail?.analytics === true : null,
    detail: e2e
      ? e2e.detail?.analytics === true
        ? "analytics events and daily roll-up seen"
        : "not seen in the E2E"
      : "not executed",
    requiredFor: "REVENUE_READY_TEST",
    needs: "external",
  });

  // ---- REVENUE_READY_LIVE ----
  const gate = canEnterLiveMode(db, env);
  push({
    id: "store_revenue_ready",
    title: "Store status REVENUE_READY (every blocking compliance item closed)",
    ok: store.status === "REVENUE_READY",
    detail: `status ${store.status}`,
    requiredFor: "REVENUE_READY_LIVE",
    needs: "owner",
  });
  push({
    id: "legal_identity",
    title: "Legal pages without seller-identity placeholders",
    ok: legal.present > 0 ? legal.placeholders === 0 : null,
    detail: legal.placeholders ? `${legal.placeholders} page(s) with placeholders` : "no placeholders",
    requiredFor: "REVENUE_READY_LIVE",
    needs: "owner",
  });
  push({
    id: "live_gate",
    title: "LIVE hard gate open",
    ok: gate.ok,
    detail: gate.ok ? "open" : `blocked: ${gate.blockers.map((b) => b.id).join(", ")}`,
    requiredFor: "REVENUE_READY_LIVE",
    needs: "owner",
  });

  // level = highest level whose conditions (and every lower level's) are all proven true
  let reached: ExternalReadinessLevel = "NOT_READY";
  let blockers: string[] = [];
  let nextLevel: ExternalReadinessLevel | null = null;
  for (const lvl of EXTERNAL_LEVELS.slice(1)) {
    const required = conds.filter((c) => c.requiredFor === lvl);
    const missing = required.filter((c) => c.ok !== true).map((c) => c.id);
    if (missing.length) {
      blockers = missing;
      nextLevel = lvl;
      break;
    }
    reached = lvl;
  }
  return {
    storeId: store.id,
    slug: store.slug,
    name: store.name,
    status: store.status,
    level: reached,
    conditions: conds,
    blockers,
    nextLevel,
    checkedAt: new Date().toISOString(),
  };
}

export function computeAllStoreReadiness(db: Db, opts: ReadinessOptions): StoreExternalReadiness[] {
  const ps = allProviderStatuses(db, opts.env ?? process.env);
  return db
    .all<{ id: string }>(
      "SELECT id FROM stores WHERE lifecycle <> 'SUNSET' ORDER BY fitness_score DESC, slug",
    )
    .map((s) => computeStoreExternalReadiness(db, s.id, opts, ps));
}

// ---------- scores ----------

export interface ReadinessScores {
  /** the recorded red-team score (simulation, chaos providers) */
  internal: { score: number; source: string };
  /** earned from executed checks against the real external systems; a present key is worth zero */
  external: {
    score: number;
    parts: { provider: IntegrationProvider; weight: number; level: string; points: number }[];
  };
  /** share of production requirements met; LIVE stays closed until 100 and the owner's click */
  production: { score: number; requirements: { id: string; ok: boolean; detail: string }[] };
  providers: ProviderStatus[];
  checkedAt: string;
}

/** Weights of the external score. Meta is reported but not scored: it is not on the money path. */
export const EXTERNAL_WEIGHTS: Partial<Record<IntegrationProvider, number>> = {
  stripe: 25,
  cj: 20,
  resend: 10,
  featherless: 10,
  cloudflare: 15,
  public: 20,
};

export function computeReadinessScores(db: Db, opts: ReadinessOptions): ReadinessScores {
  const env = opts.env ?? process.env;
  const providers = allProviderStatuses(db, env);
  const rt = getSetting<RedTeamSummary | null>(db, REDTEAM_RESULT_KEY, null);
  const parts = (Object.entries(EXTERNAL_WEIGHTS) as [IntegrationProvider, number][]).map(
    ([provider, weight]) => {
      const level = providers.find((p) => p.provider === provider)?.level ?? "NOT_CONFIGURED";
      return { provider, weight, level, points: Math.round(weight * LEVEL_CREDIT[level]) };
    },
  );
  const external = parts.reduce((s, p) => s + p.points, 0);

  const gate = canEnterLiveMode(db, env);
  const stores = computeAllStoreReadiness(db, { root: opts.root, env });
  const legalOpen =
    db.get<{ c: number }>(
      "SELECT COUNT(*) c FROM owner_actions WHERE kind='REVIEW_LEGAL_DATA' AND status='open'",
    )?.c ?? 0;
  const gpsrOpen =
    db.get<{ c: number }>(
      "SELECT COUNT(*) c FROM owner_actions WHERE kind='GPSR_RESPONSIBLE_PERSON' AND status='open'",
    )?.c ?? 0;
  const stripe = providers.find((p) => p.provider === "stripe");
  const resend = providers.find((p) => p.provider === "resend");
  const requirements = [
    {
      id: "legal_identity",
      ok: legalOpen === 0,
      detail: legalOpen ? `${legalOpen} store(s) open` : "recorded",
    },
    { id: "gpsr", ok: gpsrOpen === 0, detail: gpsrOpen ? `${gpsrOpen} store(s) open` : "recorded" },
    {
      id: "red_team",
      ok: !!rt && rt.p0 === 0 && rt.p1 === 0 && rt.invariantViolations === 0 && rt.runs >= 500,
      detail: rt ? `${rt.score}/100 at ${rt.at}` : "not recorded",
    },
    { id: "stripe_test_verified", ok: stripe?.level === "VERIFIED", detail: `level ${stripe?.level}` },
    { id: "email_verified", ok: resend?.level === "VERIFIED", detail: `level ${resend?.level}` },
    {
      id: "pilot_revenue_ready_test",
      ok: stores.some((s) => s.level === "REVENUE_READY_TEST" || s.level === "REVENUE_READY_LIVE"),
      detail:
        stores
          .filter((s) => s.level === "REVENUE_READY_TEST")
          .map((s) => s.slug)
          .join(", ") || "none",
    },
    {
      id: "revenue_ready_store",
      ok: stores.some((s) => s.status === "REVENUE_READY"),
      detail:
        stores
          .filter((s) => s.status === "REVENUE_READY")
          .map((s) => s.slug)
          .join(", ") || "none",
    },
    { id: "live_gate", ok: gate.ok, detail: gate.ok ? "open" : gate.blockers.map((b) => b.id).join(", ") },
  ];
  const production = Math.round((requirements.filter((r) => r.ok).length / requirements.length) * 100);
  return {
    internal: {
      score: rt?.score ?? 0,
      source: rt ? `red team seed ${rt.seed} at ${rt.at}` : "no recorded red team run",
    },
    external: { score: external, parts },
    production: { score: production, requirements },
    providers,
    checkedAt: new Date().toISOString(),
  };
}

// ---------- pilot selection ----------

export interface PilotCandidate {
  storeId: string;
  slug: string;
  name: string;
  score: number;
  components: Record<string, number>;
  notes: string[];
  excluded: string | null;
}

/**
 * Deterministic pilot ranking. Opportunity score weighs most, but a store cannot be the pilot on opportunity
 * alone: product availability, supplier mapping quality, shipping confidence, compliance completeness and
 * technical readiness all count. Stores with a FAILED acceptance item or a safety flag are excluded.
 */
export function rankPilotCandidates(db: Db, opts: ReadinessOptions): PilotCandidate[] {
  const acc = readAcceptance(opts.root);
  const rows = db.all<{
    id: string;
    slug: string;
    name: string;
    opp: number | null;
    safety: string | null;
    vertical: string | null;
  }>(
    `SELECT s.id, s.slug, s.name, o.opportunity_score opp, o.safety_flags safety, o.vertical FROM stores s
       LEFT JOIN opportunities o ON o.id=s.opportunity_id WHERE s.lifecycle <> 'SUNSET'`,
  );
  const out: PilotCandidate[] = rows.map((s) => {
    const notes: string[] = [];
    const products = db.get<{ total: number; active: number; priced: number }>(
      `SELECT COUNT(DISTINCT p.id) total, COUNT(DISTINCT CASE WHEN p.status='active' THEN p.id END) active,
              COUNT(DISTINCT CASE WHEN pr.id IS NOT NULL THEN p.id END) priced
         FROM products p LEFT JOIN product_variants v ON v.product_id=p.id LEFT JOIN prices pr ON pr.variant_id=v.id AND pr.active=1
        WHERE p.store_id=? AND p.status <> 'archived'`,
      [s.id],
    ) ?? { total: 0, active: 0, priced: 0 };
    const supplier = db.get<{
      variants: number;
      mapped: number;
      costed: number;
      stocked: number;
      eu: number;
      fast: number;
      real: number;
    }>(
      `SELECT COUNT(v.id) variants, COUNT(sp.id) mapped, SUM(sp.cost > 0) costed, SUM(sp.stock > 0) stocked,
              SUM(sp.eu_warehouse = 1) eu, SUM(sp.shipping_days_max <= 15) fast, SUM(su.api_adapter = 'cj') real
         FROM product_variants v JOIN products p ON p.id=v.product_id
         LEFT JOIN supplier_products sp ON sp.id=v.primary_supplier_product_id LEFT JOIN suppliers su ON su.id=sp.supplier_id
        WHERE p.store_id=? AND p.status <> 'archived'`,
      [s.id],
    ) ?? { variants: 0, mapped: 0, costed: 0, stocked: 0, eu: 0, fast: 0, real: 0 };
    const compliance = db.get<{ total: number; verified: number; blocking: number }>(
      "SELECT COUNT(*) total, SUM(status='VERIFIED') verified, SUM(status='BLOCKING') blocking FROM compliance_items WHERE store_id=?",
      [s.id],
    ) ?? { total: 0, verified: 0, blocking: 0 };
    const accStore = acc?.stores.find((a) => a.slug === s.slug);
    const built = existsSync(join(opts.root, "apps", "storefront", "dist", s.slug, "index.html"));
    const failed = accStore?.items.filter((i) => i.status === "FAILED").length ?? 0;
    const verifiedItems = accStore?.items.filter((i) => i.status === "VERIFIED").length ?? 0;
    const safety = parseJson<string[]>(s.safety, []);

    const opportunity = Math.max(0, Math.min(100, s.opp ?? 0));
    const availability =
      Math.min(1, (products.active || 0) / 5) * 70 + Math.min(1, (products.priced || 0) / 5) * 30;
    const mappingQuality = supplier.variants
      ? (supplier.mapped / supplier.variants) * 40 +
        ((supplier.costed ?? 0) / supplier.variants) * 20 +
        ((supplier.stocked ?? 0) / supplier.variants) * 20 +
        ((supplier.real ?? 0) / supplier.variants) * 20
      : 0;
    const shipping = supplier.variants
      ? (Math.max(supplier.eu ?? 0, supplier.fast ?? 0) / supplier.variants) * 100
      : 0;
    const complianceScore = compliance.total ? ((compliance.verified ?? 0) / compliance.total) * 100 : 0;
    const technical = (built ? 50 : 0) + (accStore ? Math.min(50, verifiedItems * 10) : 0);
    if (!supplier.real) notes.push("no real (CJ) supplier mapping yet: simulated catalogue");
    if (!products.active) notes.push("no active product: catalogue is draft");
    if (compliance.blocking) notes.push(`${compliance.blocking} blocking compliance item(s) open`);
    const components = {
      opportunity: Math.round(opportunity),
      availability: Math.round(availability),
      mappingQuality: Math.round(mappingQuality),
      shipping: Math.round(shipping),
      compliance: Math.round(complianceScore),
      technical: Math.round(technical),
      realSupplier: supplier.variants ? Math.round(((supplier.real ?? 0) / supplier.variants) * 100) : 0,
    };
    // one decimal: whole-number rounding produced ties between stores whose opportunity scores differ
    const score =
      Math.round(
        (opportunity * 0.35 +
          availability * 0.2 +
          mappingQuality * 0.15 +
          shipping * 0.1 +
          complianceScore * 0.1 +
          technical * 0.1) *
          10,
      ) / 10;
    let excluded: string | null = null;
    if (failed) excluded = `${failed} FAILED acceptance item(s)`;
    else if (safety.length) excluded = `safety flags: ${safety.join(", ")}`;
    else if (!built) excluded = "no build";
    return { storeId: s.id, slug: s.slug, name: s.name, score, components, notes, excluded };
  });
  return out.sort(
    (a, b) =>
      (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) || b.score - a.score || a.slug.localeCompare(b.slug),
  );
}

export const PILOT_STORE_KEY = "pilot.store";

export function currentPilot(
  db: Db,
): { slug: string; storeId: string; chosenAt: string; score: number } | null {
  return getSetting<{ slug: string; storeId: string; chosenAt: string; score: number } | null>(
    db,
    PILOT_STORE_KEY,
    null,
  );
}

/** Classification of the non-pilot stores for the external report. */
export type StoreClassification =
  | "READY_FOR_DEPLOY"
  | "NEEDS_PRODUCT_FIX"
  | "NEEDS_SUPPLIER_FIX"
  | "NEEDS_LEGAL"
  | "BLOCKED";

export function classifyStore(
  r: StoreExternalReadiness,
  candidate: PilotCandidate | undefined,
): StoreClassification {
  if (candidate?.excluded) return "BLOCKED";
  const cond = (id: string) => r.conditions.find((c) => c.id === id);
  if (cond("build")?.ok === false || cond("acceptance_technical")?.ok === false) return "BLOCKED";
  if (
    cond("supplier_validated")?.ok === false ||
    (candidate &&
      ((candidate.components.realSupplier ?? 0) === 0 || (candidate.components.mappingQuality ?? 0) < 40))
  )
    return "NEEDS_SUPPLIER_FIX";
  if (cond("catalogue")?.ok === false || cond("catalogue_pilot")?.ok === false) return "NEEDS_PRODUCT_FIX";
  if (cond("legal_identity")?.ok === false) return "NEEDS_LEGAL";
  return "READY_FOR_DEPLOY";
}
