import { type Db, insert, nowIso, scrubSecrets } from "@astro/db";
import { newId } from "./ids.ts";

/**
 * EVIDENCE OF REAL EXTERNAL INTEGRATIONS. One row per executed check against a real external system (Stripe
 * test mode, CJ read-only API, Resend, Featherless, Meta Graph, Cloudflare, the public storefront). Three
 * rules, enforced here so every script and handler inherits them:
 *   1. a credential being present is NOT evidence; only an executed check is (see providerStatus)
 *   2. nothing secret is ever stored: references are provider ids (cs_test_..., evt_..., message ids, model
 *      names) and every free-text field passes through scrubSecrets before insert
 *   3. the latest row per (provider, capability) wins; history is kept for the report
 */
export type IntegrationProvider =
  | "stripe"
  | "cj"
  | "resend"
  | "featherless"
  | "meta"
  | "cloudflare"
  | "public";

export type IntegrationEnvironment = "test" | "sandbox" | "read_only" | "production";

export interface IntegrationEvidenceInput {
  provider: IntegrationProvider;
  capability: string;
  environment: IntegrationEnvironment;
  ok: boolean;
  /** provider-side id or a short non-secret reference (never a key, token or signing secret) */
  reference?: string | null;
  latencyMs?: number | null;
  failureReason?: string | null;
  detail?: Record<string, unknown> | null;
  actor?: string;
}

export interface IntegrationEvidence {
  id: string;
  provider: IntegrationProvider;
  capability: string;
  environment: IntegrationEnvironment;
  ok: boolean;
  reference: string | null;
  latencyMs: number | null;
  failureReason: string | null;
  detail: Record<string, unknown> | null;
  actor: string;
  testedAt: string;
}

/** Shapes that must never reach the evidence table even as a "reference". */
const FORBIDDEN_REFERENCE =
  /sk_(live|test)_|rk_(live|test)_|whsec_|^re_[A-Za-z0-9_]{20,}|^EAA|sk-ant-|Bearer\s/i;

export function recordIntegrationEvidence(db: Db, e: IntegrationEvidenceInput): IntegrationEvidence {
  const reference = e.reference && !FORBIDDEN_REFERENCE.test(e.reference) ? e.reference.slice(0, 200) : null;
  const detail = e.detail ? (JSON.parse(scrubSecrets(e.detail)) as Record<string, unknown>) : null;
  const row: IntegrationEvidence = {
    id: newId("evd"),
    provider: e.provider,
    capability: e.capability,
    environment: e.environment,
    ok: e.ok,
    reference,
    latencyMs: e.latencyMs ?? null,
    failureReason: e.failureReason ? scrubSecrets(e.failureReason).slice(0, 500) : null,
    detail,
    actor: e.actor ?? "system",
    testedAt: nowIso(),
  };
  insert(db, "integration_evidence", {
    id: row.id,
    provider: row.provider,
    capability: row.capability,
    environment: row.environment,
    ok: row.ok ? 1 : 0,
    reference: row.reference,
    latency_ms: row.latencyMs,
    failure_reason: row.failureReason,
    detail: detail ? JSON.stringify(detail) : null,
    actor: row.actor,
    tested_at: row.testedAt,
  });
  return row;
}

interface EvidenceRow {
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
}

function fromRow(r: EvidenceRow): IntegrationEvidence {
  let detail: Record<string, unknown> | null = null;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      detail = null;
    }
  }
  return {
    id: r.id,
    provider: r.provider as IntegrationProvider,
    capability: r.capability,
    environment: r.environment as IntegrationEnvironment,
    ok: r.ok === 1,
    reference: r.reference,
    latencyMs: r.latency_ms,
    failureReason: r.failure_reason,
    detail,
    actor: r.actor,
    testedAt: r.tested_at,
  };
}

/** Latest recorded check for one capability (null when never executed). */
export function latestEvidence(
  db: Db,
  provider: IntegrationProvider,
  capability: string,
): IntegrationEvidence | null {
  const r = db.get<EvidenceRow>(
    "SELECT * FROM integration_evidence WHERE provider=? AND capability=? ORDER BY tested_at DESC, id DESC LIMIT 1",
    [provider, capability],
  );
  return r ? fromRow(r) : null;
}

/** Latest row per capability for a provider. */
export function latestEvidenceByProvider(db: Db, provider: IntegrationProvider): IntegrationEvidence[] {
  const rows = db.all<EvidenceRow>(
    `SELECT e.* FROM integration_evidence e
      WHERE e.provider=? AND e.id = (SELECT id FROM integration_evidence x WHERE x.provider=e.provider AND x.capability=e.capability ORDER BY tested_at DESC, id DESC LIMIT 1)
      ORDER BY e.capability`,
    [provider],
  );
  return rows.map(fromRow);
}

export function evidenceHistory(db: Db, limit = 200): IntegrationEvidence[] {
  return db
    .all<EvidenceRow>("SELECT * FROM integration_evidence ORDER BY tested_at DESC, id DESC LIMIT ?", [limit])
    .map(fromRow);
}

/**
 * Provider status ladder. Each step is earned, never assumed:
 *   NOT_CONFIGURED  credential absent from the environment
 *   CONFIGURED      credential present, no executed check yet (worth zero points)
 *   AUTHENTICATED   the provider accepted the credential (auth capability ok)
 *   TESTED          at least one operational capability passed, not all required ones
 *   VERIFIED        every required capability passed
 *   FAILED          the latest check of a required capability failed
 */
export type ProviderLevel =
  | "NOT_CONFIGURED"
  | "CONFIGURED"
  | "AUTHENTICATED"
  | "TESTED"
  | "VERIFIED"
  | "FAILED";

export interface ProviderStatus {
  provider: IntegrationProvider;
  level: ProviderLevel;
  configured: boolean;
  /** required capabilities and whether each one passed (null = never executed) */
  required: { capability: string; ok: boolean | null; testedAt: string | null; reference: string | null }[];
  optional: { capability: string; ok: boolean; testedAt: string; reference: string | null }[];
  lastVerifiedAt: string | null;
  failureReason: string | null;
  /** how the owner makes it CONFIGURED (variable names only) and which command revalidates */
  configure: string;
  verify: string;
}

interface ProviderSpec {
  configured: (env: NodeJS.ProcessEnv) => boolean;
  required: string[];
  configure: string;
  verify: string;
}

const has = (env: NodeJS.ProcessEnv, k: string) => (env[k] ?? "").trim().length > 0;

export const PROVIDER_SPECS: Record<IntegrationProvider, ProviderSpec> = {
  stripe: {
    configured: (env) => has(env, "STRIPE_SECRET_KEY"),
    required: ["auth", "checkout", "webhook"],
    configure: "STRIPE_SECRET_KEY (sk_test_) + STRIPE_WEBHOOK_SECRET (whsec_) in .env",
    verify: "npm run stripe:sandbox",
  },
  cj: {
    configured: (env) => has(env, "CJ_API_KEY"),
    required: ["auth", "mapping"],
    configure: "CJ_API_KEY in .env",
    verify: "npm run cj:validate",
  },
  resend: {
    configured: (env) =>
      (env.EMAIL_PROVIDER ?? "file") === "resend" &&
      has(env, "RESEND_API_KEY") &&
      has(env, "EMAIL_FROM_DOMAIN"),
    required: ["auth", "delivery"],
    configure: "EMAIL_PROVIDER=resend + RESEND_API_KEY + EMAIL_FROM_DOMAIN + TEST_EMAIL_RECIPIENT in .env",
    verify: "npm run email:test",
  },
  featherless: {
    configured: (env) => has(env, "FEATHERLESS_API_KEY"),
    required: ["auth", "completion", "json", "policy", "memory"],
    configure: "FEATHERLESS_API_KEY (+ FEATHERLESS_MODEL, or let llm:smoke list the models) in .env",
    verify: "npm run llm:smoke",
  },
  meta: {
    configured: (env) => has(env, "META_ACCESS_TOKEN") && has(env, "META_IG_USER_ID"),
    required: ["auth", "permissions"],
    configure:
      "META_ACCESS_TOKEN + META_IG_USER_ID (+ META_APP_ID + META_APP_SECRET for token inspection) in .env",
    verify: "npm run meta:check",
  },
  cloudflare: {
    configured: (env) => has(env, "CLOUDFLARE_API_TOKEN") || has(env, "WRANGLER_AUTHENTICATED"),
    required: ["auth", "deployment"],
    configure: "npx wrangler login (browser) or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in .env",
    verify: "npm run cloudflare:verify",
  },
  public: {
    configured: () => true,
    required: ["deployment", "e2e"],
    configure: "deploy the pilot storefront (docs/DEPLOYMENT.md)",
    verify: "npm run external:e2e",
  },
};

export function providerStatus(
  db: Db,
  provider: IntegrationProvider,
  env: NodeJS.ProcessEnv = process.env,
): ProviderStatus {
  const spec = PROVIDER_SPECS[provider];
  const latest = latestEvidenceByProvider(db, provider);
  const byCap = new Map(latest.map((e) => [e.capability, e]));
  // cloudflare auth can be proven only by an executed wrangler check; a recorded auth counts as configured
  const configured = spec.configured(env) || (provider === "cloudflare" && !!byCap.get("auth")?.ok);
  const required = spec.required.map((capability) => {
    const e = byCap.get(capability);
    return {
      capability,
      ok: e ? e.ok : null,
      testedAt: e?.testedAt ?? null,
      reference: e?.reference ?? null,
    };
  });
  const optional = latest
    .filter((e) => !spec.required.includes(e.capability))
    .map((e) => ({ capability: e.capability, ok: e.ok, testedAt: e.testedAt, reference: e.reference }));
  const failed = required.find((r) => r.ok === false) ?? null;
  const authOk = required.find((r) => r.capability === "auth")?.ok === true;
  const passed = required.filter((r) => r.ok === true).length;
  let level: ProviderLevel;
  if (failed) level = "FAILED";
  else if (passed === required.length) level = "VERIFIED";
  else if (passed > (authOk ? 1 : 0)) level = "TESTED";
  else if (authOk) level = "AUTHENTICATED";
  else if (configured) level = "CONFIGURED";
  else level = "NOT_CONFIGURED";
  const lastVerifiedAt =
    level === "VERIFIED"
      ? required.map((r) => r.testedAt ?? "").reduce((a, b) => (a > b ? a : b), "") || null
      : null;
  return {
    provider,
    level,
    configured,
    required,
    optional,
    lastVerifiedAt,
    failureReason: failed ? (byCap.get(failed.capability)?.failureReason ?? "check failed") : null,
    configure: spec.configure,
    verify: spec.verify,
  };
}

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  "stripe",
  "cj",
  "resend",
  "featherless",
  "meta",
  "cloudflare",
  "public",
];

export function allProviderStatuses(db: Db, env: NodeJS.ProcessEnv = process.env): ProviderStatus[] {
  return INTEGRATION_PROVIDERS.map((p) => providerStatus(db, p, env));
}

/** Points a provider level is worth, as a fraction of its weight. A present key alone is worth nothing. */
export const LEVEL_CREDIT: Record<ProviderLevel, number> = {
  NOT_CONFIGURED: 0,
  CONFIGURED: 0,
  FAILED: 0,
  AUTHENTICATED: 0.4,
  TESTED: 0.7,
  VERIFIED: 1,
};
