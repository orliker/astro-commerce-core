-- External sandbox activation (2026-09-11). Additive only.

-- Test-order isolation: every financial event remembers the runtime mode of its order so that TEST and
-- SIMULATION money never mixes with LIVE revenue in the dashboard (orders.mode already exists).
ALTER TABLE financial_events ADD COLUMN mode TEXT;
UPDATE financial_events SET mode = (SELECT o.mode FROM orders o WHERE o.id = financial_events.order_id)
  WHERE mode IS NULL AND order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_mode ON financial_events(mode, store_id);

-- Evidence of real external integrations (never credentials): one row per check, latest row wins.
--   provider:    stripe | cj | resend | featherless | meta | cloudflare | public
--   capability:  auth | checkout | webhook | refund | catalog | mapping | shipping | delivery | completion | ...
--   environment: test | sandbox | read_only | production
CREATE TABLE IF NOT EXISTS integration_evidence (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  environment TEXT NOT NULL,
  ok INTEGER NOT NULL,
  reference TEXT,                -- provider id (cs_test_..., evt_..., re_message id, model name); never a secret
  latency_ms INTEGER,
  failure_reason TEXT,
  detail TEXT,                   -- JSON, redacted before insert
  actor TEXT NOT NULL,
  tested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_evidence_latest ON integration_evidence(provider, capability, tested_at);
