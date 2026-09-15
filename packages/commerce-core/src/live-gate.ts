import { type Db, getSetting } from "@astro/db";

/**
 * LIVE MODE HARD GATE (red team INV08). Server-side, evaluated inside setMode(): the owner's approval is
 * necessary but not sufficient. Every blocker here is a fact the platform can verify on its own from the
 * environment and the database; none of the values are ever stored or logged, only their presence/shape.
 */
export interface LiveBlocker {
  id: string;
  detail: string;
  /** what unblocks it, in the owner's words */
  fix: string;
}

export interface LiveGateResult {
  ok: boolean;
  blockers: LiveBlocker[];
  warnings: string[];
  checkedAt: string;
}

export interface RedTeamSummary {
  seed: number;
  runs: number;
  scenarios: number;
  failures: number;
  p0: number;
  p1: number;
  invariantViolations: number;
  score: number;
  at: string;
}

export const REDTEAM_RESULT_KEY = "redteam.last_result";

export function canEnterLiveMode(db: Db, envSource: NodeJS.ProcessEnv = process.env): LiveGateResult {
  const blockers: LiveBlocker[] = [];
  const warnings: string[] = [];
  const has = (k: string) => (envSource[k] ?? "").trim().length > 0;
  const startsWith = (k: string, p: string) => (envSource[k] ?? "").trim().startsWith(p);

  // 1. Payments: a LIVE key of the right kind plus a webhook secret. Shape only, never the value.
  if (!has("STRIPE_SECRET_KEY"))
    blockers.push({
      id: "stripe_secret_missing",
      detail: "STRIPE_SECRET_KEY is not set",
      fix: "Owner action CONNECT_STRIPE",
    });
  else if (!startsWith("STRIPE_SECRET_KEY", "sk_live_"))
    blockers.push({
      id: "stripe_key_not_live",
      detail: "STRIPE_SECRET_KEY is not a live key (sk_live_)",
      fix: "Finish the sandbox checkout test, then replace the sk_test_ key with the sk_live_ key",
    });
  if (!startsWith("STRIPE_WEBHOOK_SECRET", "whsec_"))
    blockers.push({
      id: "stripe_webhook_secret_missing",
      detail: "STRIPE_WEBHOOK_SECRET is not a whsec_ signing secret",
      fix: "Create the live webhook endpoint in Stripe and paste its signing secret",
    });

  // 2. Transactional email: customers must receive confirmations from a real provider.
  if (
    (envSource.EMAIL_PROVIDER ?? "file") !== "resend" ||
    !has("RESEND_API_KEY") ||
    !has("EMAIL_FROM_DOMAIN")
  )
    blockers.push({
      id: "email_provider_missing",
      detail: "EMAIL_PROVIDER is not resend with RESEND_API_KEY and EMAIL_FROM_DOMAIN",
      fix: "Owner action CONNECT_EMAIL (verify the sending domain in Resend)",
    });

  // 3. Admin surface protection.
  if ((envSource.ADMIN_TOKEN ?? "").length < 16)
    blockers.push({
      id: "admin_token_weak",
      detail: "ADMIN_TOKEN shorter than 16 characters",
      fix: "Generate a long random ADMIN_TOKEN",
    });

  // 4. At least one store that is allowed to sell, and no critical compliance item BLOCKING on any of them.
  const stores = db.all<{
    id: string;
    slug: string;
    status: string;
    paused: number;
    compliance_report: string | null;
  }>(
    "SELECT id, slug, status, paused, compliance_report FROM stores WHERE status IN ('REVENUE_READY','LIVE')",
  );
  if (stores.length === 0)
    blockers.push({
      id: "no_revenue_ready_store",
      detail: "no store is REVENUE_READY or LIVE",
      fix: "Complete acceptance for at least one store (stores stay NEEDS_OWNER until legal data is entered)",
    });
  for (const s of stores) {
    if (!s.compliance_report)
      blockers.push({
        id: `compliance_not_evaluated:${s.slug}`,
        detail: `store ${s.slug} has never been compliance-checked`,
        fix: "Run the compliance check for the store (Control Center > Store > Compliance)",
      });
    const blocking = db.all<{ id: string; area: string; notes: string | null }>(
      "SELECT id, area, notes FROM compliance_items WHERE store_id=? AND status='BLOCKING' AND critical=1",
      [s.id],
    );
    for (const b of blocking)
      blockers.push({
        id: `compliance_blocking:${b.id}`,
        detail: `${s.slug}: ${b.area} ${b.notes ?? ""}`.trim(),
        fix: "Resolve the owner action for this item and re-run the compliance check",
      });
  }

  // 5. Red team evidence: the last recorded run must exist and carry no open P0/P1 or invariant violation.
  const rt = getSetting<RedTeamSummary | null>(db, REDTEAM_RESULT_KEY, null);
  if (!rt)
    blockers.push({
      id: "redteam_not_run",
      detail: "no red team result recorded",
      fix: "npm run redteam (500 Monte Carlo runs)",
    });
  else if (rt.p0 + rt.p1 > 0 || rt.invariantViolations > 0)
    blockers.push({
      id: "redteam_open_defects",
      detail: `last red team run: P0=${rt.p0} P1=${rt.p1} invariant violations=${rt.invariantViolations}`,
      fix: "Fix the defects, add regression tests, re-run npm run redteam",
    });
  else if (rt.runs < 500) warnings.push(`last red team run had ${rt.runs} Monte Carlo runs (< 500)`);

  // 6. Spend policy stays at zero unless the owner raised it on purpose (warning only: it is a policy, not a defect).
  for (const k of ["MAX_AD_SPEND_EUR", "MAX_SAAS_SPEND_EUR", "MAX_AUTONOMOUS_EXTERNAL_PURCHASE_EUR"])
    if (Number(envSource[k] ?? 0) > 0) warnings.push(`${k} is above zero`);

  return { ok: blockers.length === 0, blockers, warnings, checkedAt: new Date().toISOString() };
}

export class LiveModeBlocked extends Error {
  readonly blockers: LiveBlocker[];
  constructor(blockers: LiveBlocker[]) {
    super(`LIVE mode blocked: ${blockers.map((b) => b.id).join(", ")}`);
    this.blockers = blockers;
  }
}
