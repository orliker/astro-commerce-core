import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, getSetting } from "@astro/db";
import {
  computeAllStoreReadiness,
  computeReadinessScores,
  currentPilot,
  latestStoreEvidence,
  type ReadinessScores,
  type StoreExternalReadiness,
} from "./external-readiness.ts";
import {
  allProviderStatuses,
  type IntegrationEvidence,
  type IntegrationProvider,
  latestEvidence,
  type ProviderStatus,
} from "./integration-evidence.ts";
import { canEnterLiveMode, REDTEAM_RESULT_KEY, type RedTeamSummary } from "./live-gate.ts";

/**
 * PRE-LAUNCH CHECKLIST, machine readable. Every item is decided from evidence the platform holds (environment
 * shape, database rows, recorded external checks, report files); nothing is assumed. Statuses:
 *   PASS            evidence recorded and positive
 *   FAIL            the system (not the owner) has something to fix, or a recorded test failed
 *   NEEDS_OWNER     blocked on the owner: credentials, legal data, an external account, an explicit approval
 *   NOT_APPLICABLE  the item does not apply to the current configuration
 * A present credential is never PASS on its own: CONFIGURED is worth nothing until a real check ran.
 */
export type ChecklistStatus = "PASS" | "FAIL" | "NEEDS_OWNER" | "NOT_APPLICABLE";

export type ChecklistItemId =
  | "legal_identity"
  | "gpsr"
  | "stripe_test"
  | "stripe_auth"
  | "stripe_checkout"
  | "stripe_webhook"
  | "stripe_refund"
  | "cj_auth"
  | "cj_product_mapping"
  | "cj_fulfillment"
  | "resend"
  | "featherless"
  | "meta"
  | "cloudflare"
  | "public_deployment"
  | "public_e2e"
  | "pilot_revenue_ready_test"
  | "acceptance"
  | "red_team";

export interface ChecklistItem {
  id: ChecklistItemId;
  title: string;
  status: ChecklistStatus;
  detail: string;
  /** what unblocks it (owner's words) or the command the system runs */
  next: string;
  /** provider/capability of the recorded evidence, when applicable */
  evidence?: {
    provider: IntegrationProvider;
    capability: string;
    testedAt: string | null;
    reference: string | null;
  };
  /** true when the item gates REVENUE_READY_TEST for the pilot */
  blockingForTest: boolean;
}

export interface LaunchChecklist {
  checkedAt: string;
  mode: string;
  items: ChecklistItem[];
  summary: Record<ChecklistStatus, number>;
  liveGate: { ok: boolean; blockers: string[] };
  providers: ProviderStatus[];
  scores: ReadinessScores;
  stores: StoreExternalReadiness[];
  pilot: { slug: string; level: string } | null;
  /**
   * NOT_READY while any FAIL exists; READY_FOR_EXTERNAL_SANDBOX when only owner-side items remain;
   * EXTERNAL_SANDBOX_VERIFIED once every external provider on the money path is VERIFIED and the pilot
   * reached REVENUE_READY_TEST; READY_FOR_CONTROLLED_LIVE only when the LIVE gate is open as well.
   */
  verdict:
    | "NOT_READY"
    | "READY_FOR_EXTERNAL_SANDBOX"
    | "EXTERNAL_SANDBOX_VERIFIED"
    | "READY_FOR_CONTROLLED_LIVE";
}

function evidenceItem(
  e: IntegrationEvidence | null,
  configured: boolean,
  labels: { title: string; notConfigured: string; configuredNotRun: string; verify: string },
  id: ChecklistItemId,
  blockingForTest: boolean,
  provider: IntegrationProvider,
  capability: string,
): ChecklistItem {
  const status: ChecklistStatus = e ? (e.ok ? "PASS" : "FAIL") : "NEEDS_OWNER";
  const detail = e
    ? `${e.ok ? "passed" : "FAILED"} at ${e.testedAt}${e.reference ? ` (${e.reference})` : ""}${e.latencyMs != null ? `, ${e.latencyMs} ms` : ""}${e.failureReason ? `: ${e.failureReason}` : ""}`
    : configured
      ? labels.configuredNotRun
      : labels.notConfigured;
  return {
    id,
    title: labels.title,
    status,
    detail,
    next: e?.ok ? "re-run after changes" : labels.verify,
    evidence: { provider, capability, testedAt: e?.testedAt ?? null, reference: e?.reference ?? null },
    blockingForTest,
  };
}

export function computeLaunchChecklist(
  db: Db,
  opts: { root: string; env?: NodeJS.ProcessEnv } = { root: process.cwd() },
): LaunchChecklist {
  const env = opts.env ?? process.env;
  const startsWith = (k: string, p: string) => (env[k] ?? "").trim().startsWith(p);
  const items: ChecklistItem[] = [];
  const mode = getSetting<string>(db, "runtime.mode", "SIMULATION");
  const openActions = (kind: string) =>
    db.get<{ c: number }>("SELECT COUNT(*) c FROM owner_actions WHERE kind=? AND status='open'", [kind])?.c ??
    0;
  const activeStores = db.all<{ id: string; slug: string; status: string; domain: string | null }>(
    "SELECT id, slug, status, domain FROM stores WHERE lifecycle <> 'SUNSET'",
  );
  const providers = allProviderStatuses(db, env);
  const prov = (p: IntegrationProvider) => providers.find((x) => x.provider === p) as ProviderStatus;
  const ev = (p: IntegrationProvider, c: string) => latestEvidence(db, p, c);

  // ---- legal ----
  const legalOpen = openActions("REVIEW_LEGAL_DATA");
  items.push({
    id: "legal_identity",
    title: "Legal identity on every store (seller name, address, VAT/NIF, contact)",
    status: legalOpen ? "NEEDS_OWNER" : activeStores.length ? "PASS" : "NOT_APPLICABLE",
    detail: legalOpen
      ? `${legalOpen} store(s) still show seller-identity placeholders`
      : `${activeStores.length} store(s) with legal data recorded`,
    next: legalOpen
      ? "NEEDS ALEX: Stores > Legal identity (fill once, Apply to all stores), then npm run store:build"
      : "none",
    blockingForTest: false,
  });
  const gpsrOpen = openActions("GPSR_RESPONSIBLE_PERSON");
  items.push({
    id: "gpsr",
    title:
      "GPSR responsible economic operator per store (importer, authorised representative or manufacturer in the EU)",
    status: gpsrOpen ? "NEEDS_OWNER" : activeStores.length ? "PASS" : "NOT_APPLICABLE",
    detail: gpsrOpen ? `${gpsrOpen} store(s) without a GPSR responsible person` : "recorded for every store",
    next: gpsrOpen
      ? "NEEDS ALEX: GPSR section of the Legal identity form (role + contact), Apply to all stores"
      : "none",
    blockingForTest: false,
  });

  // ---- Stripe ----
  const stripeTest = startsWith("STRIPE_SECRET_KEY", "sk_test_");
  const stripeLive = startsWith("STRIPE_SECRET_KEY", "sk_live_");
  items.push({
    id: "stripe_test",
    title: "Stripe TEST secret key configured (sk_test_); a live key is refused in this stage",
    status: stripeTest ? "PASS" : stripeLive ? "FAIL" : "NEEDS_OWNER",
    detail: stripeTest
      ? `sk_test_ key present${startsWith("STRIPE_WEBHOOK_SECRET", "whsec_") ? ", webhook signing secret present" : ", STRIPE_WEBHOOK_SECRET (whsec_) still missing"} (values never stored)`
      : stripeLive
        ? "a LIVE key is configured: the external sandbox stage runs on test keys only"
        : "STRIPE_SECRET_KEY (sk_test_) missing",
    next: stripeTest
      ? "npm run stripe:sandbox"
      : "NEEDS ALEX: STRIPE_SECRET_KEY (sk_test_) + STRIPE_WEBHOOK_SECRET in .env, then npm run stripe:sandbox",
    blockingForTest: true,
  });
  const stripeConfigured = prov("stripe").configured;
  items.push(
    evidenceItem(
      ev("stripe", "auth"),
      stripeConfigured,
      {
        title: "Stripe account authenticated in test mode (real API call)",
        notConfigured: "no test key",
        configuredNotRun: "key present, authentication not executed",
        verify: "npm run stripe:sandbox -- --check",
      },
      "stripe_auth",
      true,
      "stripe",
      "auth",
    ),
  );
  items.push(
    evidenceItem(
      ev("stripe", "checkout"),
      stripeConfigured,
      {
        title: "Real Stripe test checkout paid and applied exactly once (session -> PAID -> ledger)",
        notConfigured: "no test key",
        configuredNotRun: "not executed (needs one test-card payment by the owner)",
        verify: "npm run stripe:sandbox (guided; card 4242 4242 4242 4242)",
      },
      "stripe_checkout",
      true,
      "stripe",
      "checkout",
    ),
  );
  items.push(
    evidenceItem(
      ev("stripe", "webhook"),
      stripeConfigured,
      {
        title: "Real Stripe test webhook received, signature verified, duplicate delivery deduplicated",
        notConfigured: "no test key",
        configuredNotRun:
          "not observed: needs the edge worker deployed (Stripe -> edge -> sync) or the Stripe CLI forwarding to the local API",
        verify:
          "npm run stripe:sandbox after the cloudflare deploy (or with `stripe listen --forward-to localhost:4310/webhooks/stripe`)",
      },
      "stripe_webhook",
      true,
      "stripe",
      "webhook",
    ),
  );
  items.push(
    evidenceItem(
      ev("stripe", "refund"),
      stripeConfigured,
      {
        title: "Real Stripe test refund executed through the platform's refund path (idempotent)",
        notConfigured: "no test key",
        configuredNotRun: "not executed",
        verify: "npm run stripe:sandbox -- --refund <order number>",
      },
      "stripe_refund",
      false,
      "stripe",
      "refund",
    ),
  );

  // ---- CJ ----
  const cjConfigured = prov("cj").configured;
  items.push(
    evidenceItem(
      ev("cj", "auth"),
      cjConfigured,
      {
        title: "CJdropshipping API authenticated (token exchange + account read)",
        notConfigured: "CJ_API_KEY missing",
        configuredNotRun: "key present, validation not executed",
        verify: "npm run cj:validate (read-only, no spend)",
      },
      "cj_auth",
      true,
      "cj",
      "auth",
    ),
  );
  const mapping = ev("cj", "mapping");
  items.push({
    ...evidenceItem(
      mapping,
      cjConfigured,
      {
        title:
          "Product mappings audited against live CJ data (VALID / STALE / INVALID / MISSING / NEEDS_REVIEW)",
        notConfigured: "CJ_API_KEY missing",
        configuredNotRun: "not executed",
        verify: "npm run cj:validate -- --all",
      },
      "cj_product_mapping",
      true,
      "cj",
      "mapping",
    ),
    detail: mapping
      ? `${mapping.ok ? "passed" : "needs work"} at ${mapping.testedAt}: ${String(mapping.detail?.summary ?? mapping.failureReason ?? "")}`
      : cjConfigured
        ? "not executed"
        : "CJ_API_KEY missing",
  });
  const cjOrder = ev("cj", "fulfillment");
  items.push({
    id: "cj_fulfillment",
    title: "Supplier order placed at CJ (sandbox flag) after explicit owner approval",
    status: cjOrder ? (cjOrder.ok ? "PASS" : "FAIL") : "NEEDS_OWNER",
    detail: cjOrder
      ? `${cjOrder.ok ? "passed" : "FAILED"} at ${cjOrder.testedAt}${cjOrder.reference ? ` (${cjOrder.reference})` : ""}`
      : "NOT_TESTED_NO_SAFE_SANDBOX: the platform cannot prove a CJ sandbox order is free of charge, so none is placed automatically; the owner releases one TEST order from Orders when ready",
    next: cjOrder?.ok
      ? "none"
      : "after the public E2E: Orders > <TEST order> > Release (owner click); the worker records the evidence",
    evidence: {
      provider: "cj",
      capability: "fulfillment",
      testedAt: cjOrder?.testedAt ?? null,
      reference: cjOrder?.reference ?? null,
    },
    blockingForTest: false,
  });

  // ---- Resend ----
  const resendP = prov("resend");
  const delivery = ev("resend", "delivery");
  items.push({
    id: "resend",
    title: "Transactional email proven externally (Resend authenticated + one marked test email accepted)",
    status: resendP.level === "VERIFIED" ? "PASS" : resendP.level === "FAILED" ? "FAIL" : "NEEDS_OWNER",
    detail:
      resendP.level === "VERIFIED"
        ? `verified at ${resendP.lastVerifiedAt}${delivery?.reference ? ` (message ${delivery.reference})` : ""}`
        : resendP.level === "FAILED"
          ? `FAILED: ${resendP.failureReason}`
          : resendP.configured
            ? "provider configured, test send not executed (needs TEST_EMAIL_RECIPIENT)"
            : "EMAIL_PROVIDER=resend with RESEND_API_KEY and EMAIL_FROM_DOMAIN not set (file provider in use)",
    next: resendP.level === "VERIFIED" ? "none" : `${resendP.configure}; then ${resendP.verify}`,
    evidence: {
      provider: "resend",
      capability: "delivery",
      testedAt: delivery?.testedAt ?? null,
      reference: delivery?.reference ?? null,
    },
    blockingForTest: true,
  });

  // ---- Featherless ----
  const llmP = prov("featherless");
  items.push({
    id: "featherless",
    title: "LLM brain proven externally (auth, model, completion, JSON, policy gate, memory round trip)",
    status: llmP.level === "VERIFIED" ? "PASS" : llmP.level === "FAILED" ? "FAIL" : "NEEDS_OWNER",
    detail:
      llmP.level === "VERIFIED"
        ? `verified at ${llmP.lastVerifiedAt}: ${llmP.required.map((r) => r.capability).join(", ")}`
        : llmP.level === "FAILED"
          ? `FAILED: ${llmP.failureReason}`
          : llmP.configured
            ? `key present; ${llmP.required.filter((r) => r.ok).length}/${llmP.required.length} capabilities proven`
            : "FEATHERLESS_API_KEY missing (mock provider in use; autonomy runs on rules)",
    next: llmP.level === "VERIFIED" ? "none" : `${llmP.configure}; then ${llmP.verify}`,
    blockingForTest: true,
  });

  // ---- Meta ----
  const metaP = prov("meta");
  items.push({
    id: "meta",
    title:
      "Instagram (Meta Graph API) token authenticated and permissions read; publishing stays approval-gated",
    status: metaP.level === "VERIFIED" ? "PASS" : metaP.level === "FAILED" ? "FAIL" : "NEEDS_OWNER",
    detail:
      metaP.level === "VERIFIED"
        ? `verified at ${metaP.lastVerifiedAt}`
        : metaP.level === "FAILED"
          ? `FAILED: ${metaP.failureReason}`
          : metaP.configured
            ? "token present, check not executed"
            : "META_ACCESS_TOKEN / META_IG_USER_ID missing; social publishing stays simulated (not on the money path)",
    next: metaP.level === "VERIFIED" ? "none" : `${metaP.configure}; then ${metaP.verify}`,
    blockingForTest: false,
  });

  // ---- Cloudflare / deployment ----
  const cfP = prov("cloudflare");
  const cfAuth = ev("cloudflare", "auth");
  items.push({
    id: "cloudflare",
    title: "Cloudflare authenticated (wrangler) and the edge worker deployed on the free plan",
    status: cfP.level === "VERIFIED" ? "PASS" : cfP.level === "FAILED" ? "FAIL" : "NEEDS_OWNER",
    detail:
      cfP.level === "VERIFIED"
        ? `verified at ${cfP.lastVerifiedAt}`
        : cfP.level === "FAILED"
          ? `FAILED: ${cfP.failureReason}`
          : cfAuth?.ok
            ? "authenticated; edge worker not deployed/verified yet"
            : "OWNER_REQUIRED: no wrangler login and no CLOUDFLARE_API_TOKEN",
    next:
      cfP.level === "VERIFIED"
        ? "none"
        : "NEEDS ALEX: npx wrangler login, then npm run cloudflare:verify (deploy commands in docs/DEPLOYMENT.md)",
    blockingForTest: true,
  });
  const pilot = currentPilot(db);
  const deployEv = pilot ? latestStoreEvidence(db, "public", "deployment", pilot.slug) : null;
  const deployed = activeStores.filter((s) => s.domain);
  items.push({
    id: "public_deployment",
    title:
      "Pilot storefront on a public host with the smoke test passed (home, category, product, cart, legal, SEO files)",
    status: deployEv ? (deployEv.ok ? "PASS" : "FAIL") : "NEEDS_OWNER",
    detail: deployEv
      ? `${deployEv.ok ? "passed" : "FAILED"} at ${deployEv.testedAt}: ${deployEv.reference ?? ""}${deployEv.failureReason ? ` ${deployEv.failureReason}` : ""}`
      : deployed.length
        ? `${deployed.length} store(s) with a public host, smoke test not executed`
        : pilot
          ? `pilot ${pilot.slug} chosen, not deployed (builds exist under apps/storefront/dist)`
          : "no pilot chosen yet (npm run pilot:select)",
    next: deployEv?.ok
      ? "none"
      : "after cloudflare: npx wrangler pages deploy apps/storefront/dist/<pilot> --project-name <pilot>, then npm run external:e2e -- --smoke",
    evidence: {
      provider: "public",
      capability: "deployment",
      testedAt: deployEv?.testedAt ?? null,
      reference: deployEv?.reference ?? null,
    },
    blockingForTest: true,
  });
  const e2e = pilot ? latestStoreEvidence(db, "public", "e2e", pilot.slug) : null;
  items.push({
    id: "public_e2e",
    title:
      "Public end-to-end TEST order on the pilot (real storefront, Stripe test, real webhook, order once, gates, hold, email, analytics, ledger)",
    status: e2e ? (e2e.ok ? "PASS" : "FAIL") : "NEEDS_OWNER",
    detail: e2e
      ? `${e2e.ok ? "passed" : "FAILED"} at ${e2e.testedAt}${e2e.reference ? ` (${e2e.reference})` : ""}${e2e.failureReason ? `: ${e2e.failureReason}` : ""}`
      : "not executed",
    next: e2e?.ok ? "none" : "npm run external:e2e (guided; one test-card payment by the owner)",
    evidence: {
      provider: "public",
      capability: "e2e",
      testedAt: e2e?.testedAt ?? null,
      reference: e2e?.reference ?? null,
    },
    blockingForTest: true,
  });

  // ---- pilot level ----
  const stores = computeAllStoreReadiness(db, { root: opts.root, env });
  const pilotStore = pilot ? stores.find((s) => s.slug === pilot.slug) : undefined;
  const pilotOk = !!pilotStore && ["REVENUE_READY_TEST", "REVENUE_READY_LIVE"].includes(pilotStore.level);
  items.push({
    id: "pilot_revenue_ready_test",
    title: "Pilot store at REVENUE_READY_TEST (every external proof recorded; TEST is not LIVE)",
    status: pilotOk ? "PASS" : "NEEDS_OWNER",
    detail: pilotStore
      ? `${pilotStore.slug}: ${pilotStore.level}${pilotStore.blockers.length ? `, waiting on ${pilotStore.blockers.join(", ")}` : ""}`
      : "no pilot chosen (npm run pilot:select)",
    next: pilotOk ? "none" : "complete the blocking items above, then npm run launch:checklist",
    blockingForTest: false,
  });

  // ---- acceptance ----
  const accPath = join(opts.root, "data", "reports", "acceptance.json");
  let accStatus: ChecklistStatus = "FAIL";
  let accDetail = "data/reports/acceptance.json missing";
  if (existsSync(accPath)) {
    try {
      const acc = JSON.parse(readFileSync(accPath, "utf8")) as {
        checkedAt: string;
        stores: { slug: string; items: { status: string }[] }[];
      };
      const all = acc.stores.flatMap((s) => s.items);
      const failed = all.filter((i) => i.status === "FAILED").length;
      const owner = all.filter((i) => i.status === "NEEDS_OWNER").length;
      const verified = all.filter((i) => i.status === "VERIFIED").length;
      accStatus = failed ? "FAIL" : owner ? "NEEDS_OWNER" : "PASS";
      accDetail = `${acc.stores.length} store(s) at ${acc.checkedAt}: ${verified} verified, ${owner} need the owner, ${failed} failed`;
    } catch (e) {
      accDetail = `acceptance.json unreadable: ${(e as Error).message}`;
    }
  }
  items.push({
    id: "acceptance",
    title: "Final acceptance test per store (npm run acceptance)",
    status: accStatus,
    detail: accDetail,
    next:
      accStatus === "PASS"
        ? "none"
        : "npm run acceptance -- --json; fix FAILED items, NEEDS_OWNER items go to NEEDS ALEX",
    blockingForTest: false,
  });

  // ---- red team ----
  const rt = getSetting<RedTeamSummary | null>(db, REDTEAM_RESULT_KEY, null);
  const rtOk = !!rt && rt.p0 === 0 && rt.p1 === 0 && rt.invariantViolations === 0 && rt.runs >= 500;
  items.push({
    id: "red_team",
    title:
      "Production red team: deterministic scenarios + Monte Carlo (>= 500 runs) with no P0/P1 and no invariant violation",
    status: rt ? (rtOk ? "PASS" : "FAIL") : "FAIL",
    detail: rt
      ? `seed ${rt.seed}, ${rt.scenarios} scenarios, ${rt.runs} Monte Carlo runs, ${rt.failures} scenario failures, P0 ${rt.p0}, P1 ${rt.p1}, invariant violations ${rt.invariantViolations}, readiness ${rt.score}/100 at ${rt.at}`
      : "no recorded run (settings redteam.last_result missing)",
    next: rtOk ? "re-run after every hardening change" : "npm run redteam -- --runs 500 --seed 12345",
    blockingForTest: true,
  });

  const summary: Record<ChecklistStatus, number> = { PASS: 0, FAIL: 0, NEEDS_OWNER: 0, NOT_APPLICABLE: 0 };
  for (const i of items) summary[i.status]++;
  const gate = canEnterLiveMode(db, env);
  const scores = computeReadinessScores(db, { root: opts.root, env });
  const moneyPath: IntegrationProvider[] = ["stripe", "cj", "resend", "featherless", "cloudflare", "public"];
  const externalVerified = moneyPath.every((p) => prov(p).level === "VERIFIED") && pilotOk;
  const verdict: LaunchChecklist["verdict"] =
    summary.FAIL > 0
      ? "NOT_READY"
      : gate.ok && summary.NEEDS_OWNER === 0
        ? "READY_FOR_CONTROLLED_LIVE"
        : externalVerified
          ? "EXTERNAL_SANDBOX_VERIFIED"
          : "READY_FOR_EXTERNAL_SANDBOX";
  return {
    checkedAt: new Date().toISOString(),
    mode,
    items,
    summary,
    liveGate: { ok: gate.ok, blockers: gate.blockers.map((b) => b.id) },
    providers,
    scores,
    stores,
    pilot: pilotStore ? { slug: pilotStore.slug, level: pilotStore.level } : null,
    verdict,
  };
}
