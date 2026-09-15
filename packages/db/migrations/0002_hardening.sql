-- Pre-launch hardening (red team, 2026-09-11). Additive only.

-- Fulfilment idempotency: the external purchase is claimed BEFORE the supplier call.
--   fulfillment_status: NULL | submitting | submitted | unknown | failed
--   fulfillment_key:    idempotency key sent to the supplier (one per order, never regenerated)
ALTER TABLE orders ADD COLUMN fulfillment_status TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_key TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_started_at TEXT;

-- Refund idempotency: the refund row id doubles as the provider idempotency key; `executing` marks the
-- window between "we asked the provider" and "we stored the answer".
ALTER TABLE refunds ADD COLUMN idempotency_key TEXT;
ALTER TABLE refunds ADD COLUMN executing_since TEXT;

-- Transactional email deliveries: idempotent per (order, kind, variant) and retriable on their own.
CREATE TABLE IF NOT EXISTS email_deliveries (
  idempotency_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | given_up
  attempts INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_id TEXT,
  last_error TEXT,
  extra TEXT,                               -- JSON (refundAmount, message)
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_status ON email_deliveries(status, next_attempt_at);

-- Webhook events keep their own attempt counter so a transient apply failure is retried on redelivery.
ALTER TABLE webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
