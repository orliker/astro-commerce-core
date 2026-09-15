/**
 * Secret scrubbing at the sink (red team INV09, defence in depth). Every row written to system_events,
 * audit_log and job_logs passes through here, so a caller that forgot to redact cannot leak a credential
 * into the database. Two layers: known credential shapes, and the current values of every environment
 * variable whose name says it is a secret.
 */
const SECRET_SHAPES = [
  /sk_(live|test)_[A-Za-z0-9]{8,}/g,
  /rk_(live|test)_[A-Za-z0-9]{8,}/g,
  /whsec_[A-Za-z0-9]{8,}/g,
  // Resend keys are re_<segment>_<segment> (30-odd chars) at a word start; without the boundary ordinary
  // identifiers such as compare_at_evidence, pre_purchase or score_threshold were mangled inside audit and
  // event JSON, and without the second underscore Stripe refund ids (re_ + 24 alphanumerics, no underscore)
  // lost their reference in the evidence table (measured 2026-09-12).
  /\bre_[A-Za-z0-9]+_[A-Za-z0-9_]{8,}/g,
  /(?:Bearer\s+)[A-Za-z0-9._-]{12,}/g,
  /EAA[A-Za-z0-9]{20,}/g, // Meta tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\brwl_[A-Za-z0-9]{8,}/g,
];

export function scrubSecrets(input: unknown): string {
  let s = typeof input === "string" ? input : JSON.stringify(input);
  if (!s) return "";
  for (const re of SECRET_SHAPES) s = s.replace(re, "[REDACTED]");
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 12) continue;
    if (!/KEY|SECRET|TOKEN|PASSWORD/i.test(k)) continue;
    if (s.includes(v)) s = s.split(v).join("[REDACTED]");
  }
  return s;
}
