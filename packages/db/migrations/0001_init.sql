-- Astro Commerce Autonomous Lab: core schema (SQLite dialect, portable to Cloudflare D1 / Postgres with minor edits)
-- Money: integer minor units + currency. Timestamps: ISO-8601 UTC text.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- system ----------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,            -- JSON
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',   -- owner | operator | viewer
  password_hash TEXT,                   -- scrypt hash, never plaintext
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials_metadata (
  name TEXT PRIMARY KEY,               -- e.g. STRIPE_SECRET_KEY
  provider TEXT NOT NULL,
  present INTEGER NOT NULL DEFAULT 0,  -- 1 when env var is set (value never stored)
  mode TEXT,                           -- test | live | n/a
  fingerprint TEXT,                    -- last 4 chars only, for identification
  last_verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'missing', -- missing | present | verified | invalid
  notes TEXT
);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,                 -- debug | info | warn | error
  source TEXT NOT NULL,                -- component name
  event TEXT NOT NULL,
  store_id TEXT,
  data TEXT,                           -- JSON (redacted)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_level ON system_events(level, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,                 -- user id | agent role | system
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  before TEXT,
  after TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  impact TEXT NOT NULL,
  how TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL DEFAULT 5,
  blocking INTEGER NOT NULL DEFAULT 0,
  store_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | done | dismissed
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_actions_open ON owner_actions(kind, COALESCE(entity_id,''), status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                 -- system | store | product | supplier | content
  store_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  alternatives TEXT,                   -- JSON array
  evidence TEXT,                       -- JSON array of research_claims ids or Evidence objects
  expected_result TEXT,
  actual_result TEXT,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

-- ---------- jobs / agents ----------
CREATE TABLE IF NOT EXISTS agents (
  role TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  prompt_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  store_id TEXT,
  priority INTEGER NOT NULL DEFAULT 50,   -- 0 highest
  created_at TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  dependencies TEXT,                      -- JSON array of job ids
  input TEXT,                             -- JSON
  output TEXT,                            -- JSON
  cost_eur INTEGER NOT NULL DEFAULT 0,    -- cents, external spend attributed (must be 0 unless approved)
  risk TEXT NOT NULL DEFAULT 'low',       -- low | medium | high
  tier INTEGER NOT NULL DEFAULT 0,        -- autonomy tier required
  owner_required INTEGER NOT NULL DEFAULT 0,
  agent_role TEXT,
  error TEXT,
  dedupe_key TEXT,
  lock_token TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_sched ON jobs(status, scheduled_at, priority);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING','RETRY');

CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);

-- ---------- research ----------
CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- web | reddit | trends | marketplace | social | forum | supplier | manual
  url TEXT,
  title TEXT,
  retrieved_at TEXT NOT NULL,
  raw_path TEXT,                       -- path to cached raw content (data/cache)
  hash TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS research_claims (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,          -- opportunity | product | supplier | competitor | market | platform
  subject_id TEXT,
  claim TEXT NOT NULL,
  source_id TEXT REFERENCES research_sources(id),
  source_url TEXT,
  retrieved_at TEXT NOT NULL,
  confidence REAL NOT NULL,            -- 0..1
  evidence TEXT NOT NULL,              -- quote / number / observation
  assumptions TEXT,
  created_by TEXT NOT NULL DEFAULT 'research-engine',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON research_claims(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  vertical TEXT NOT NULL,
  product_thesis TEXT NOT NULL,
  target_customer TEXT,
  core_problem TEXT,
  market_gap TEXT,
  brand_angle TEXT,
  why_now TEXT,
  price_range_min INTEGER,             -- cents EUR
  price_range_max INTEGER,
  expected_aov INTEGER,
  estimated_margin_pct REAL,
  scores TEXT NOT NULL,                -- JSON: {DEMAND: 0..100, ...}
  opportunity_score REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  stage TEXT NOT NULL DEFAULT 'candidate', -- candidate | semifinalist | finalist | selected | rejected | capital_required
  risks TEXT,                          -- JSON array
  safety_flags TEXT,                   -- JSON array (regulated, medical claims, ...)
  capital_required TEXT,               -- JSON {investment, expected_return, risk, payback_months, evidence, recommendation}
  research_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT REFERENCES opportunities(id),
  store_id TEXT,
  name TEXT NOT NULL,
  url TEXT,
  kind TEXT NOT NULL DEFAULT 'direct',  -- direct | indirect
  pricing_notes TEXT,
  offer_notes TEXT,
  review_notes TEXT,
  complaints TEXT,                       -- JSON array of repeated complaints
  seo_notes TEXT,
  social_notes TEXT,
  weaknesses TEXT,
  brand_gaps TEXT,
  retrieved_at TEXT NOT NULL
);

-- ---------- stores / brands ----------
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  opportunity_id TEXT REFERENCES opportunities(id),
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  lifecycle TEXT NOT NULL DEFAULT 'DISCOVERY',
  paused INTEGER NOT NULL DEFAULT 0,
  primary_market TEXT NOT NULL DEFAULT 'PT',   -- ISO country
  markets TEXT NOT NULL DEFAULT '["PT","ES"]', -- JSON array of ISO countries we ship to
  currency TEXT NOT NULL DEFAULT 'EUR',
  locale TEXT NOT NULL DEFAULT 'pt-PT',
  domain TEXT,                                   -- current public host (pages.dev subdomain until owner buys domain)
  target_domain TEXT,                            -- future branddomain.com
  design_system TEXT,                            -- JSON design tokens (generated)
  config TEXT,                                   -- JSON store config (nav, categories, policies)
  seo_score REAL NOT NULL DEFAULT 0,
  social_score REAL NOT NULL DEFAULT 0,
  supplier_score REAL NOT NULL DEFAULT 0,
  fitness_score REAL NOT NULL DEFAULT 0,
  revenue_ready_report TEXT,                     -- JSON checklist
  compliance_report TEXT,                        -- JSON checklist
  launched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL UNIQUE REFERENCES stores(id),
  name TEXT NOT NULL,
  tagline TEXT,
  positioning TEXT,
  target_customer TEXT,
  personality TEXT,
  voice TEXT,
  visual_direction TEXT,
  logo_concept TEXT,
  wordmark_svg TEXT,
  palette TEXT,                    -- JSON
  typography TEXT,                 -- JSON
  story TEXT,
  value_proposition TEXT,
  differentiator TEXT,
  name_check TEXT,                 -- JSON: conflicts searched, results, verdict
  quality_gate TEXT,               -- JSON: gate results
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------- suppliers ----------
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- cj | aliexpress | eu_wholesale | manual | other
  api_supported INTEGER NOT NULL DEFAULT 0,
  api_adapter TEXT,                -- adapter key in supplier-engine
  website TEXT,
  eu_warehouse INTEGER NOT NULL DEFAULT 0,
  countries_from TEXT,             -- JSON array of origin countries
  payment_terms TEXT,              -- prepaid | balance | credit
  processing_days_min INTEGER,
  processing_days_max INTEGER,
  score REAL NOT NULL DEFAULT 0,
  score_breakdown TEXT,            -- JSON
  paused INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'unknown',  -- ok | degraded | down | unknown
  last_health_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_products (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  external_id TEXT,                -- supplier product id (pid)
  external_variant_id TEXT,        -- vid / sku
  external_url TEXT,
  title TEXT NOT NULL,
  cost INTEGER NOT NULL,           -- cents
  currency TEXT NOT NULL DEFAULT 'USD',
  shipping_cost INTEGER,           -- cents to primary market
  shipping_days_min INTEGER,
  shipping_days_max INTEGER,
  ship_from TEXT,                  -- ISO country / warehouse code
  eu_warehouse INTEGER NOT NULL DEFAULT 0,
  stock INTEGER,
  stock_checked_at TEXT,
  rating REAL,
  order_volume INTEGER,
  weight_grams INTEGER,
  compliance_info TEXT,            -- JSON: {gpsr_rp, ce, docs}
  images TEXT,                     -- JSON array of urls (license: supplier grant)
  score REAL NOT NULL DEFAULT 0,
  score_breakdown TEXT,
  evidence TEXT,                   -- JSON array of claim ids
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_products_supplier ON supplier_products(supplier_id);

-- ---------- catalog ----------
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'core',   -- hero | core | upsell | cross_sell | bundle
  category TEXT,
  description TEXT,
  benefits TEXT,                        -- JSON array
  specifications TEXT,                  -- JSON object (only supplier-provided facts)
  faq TEXT,                             -- JSON array [{q,a}]
  images TEXT,                          -- JSON array [{url, alt, source, license}]
  shipping_expectation TEXT,
  return_notes TEXT,
  seo_title TEXT,
  seo_description TEXT,
  structured_data TEXT,                 -- JSON-LD override
  status TEXT NOT NULL DEFAULT 'draft', -- draft | active | blocked | archived
  block_reason TEXT,
  safety_review TEXT,                   -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(store_id, slug)
);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  options TEXT,                          -- JSON {color, size}
  weight_grams INTEGER,
  primary_supplier_product_id TEXT REFERENCES supplier_products(id),
  secondary_supplier_product_id TEXT REFERENCES supplier_products(id),
  backup_supplier_product_id TEXT REFERENCES supplier_products(id),
  status TEXT NOT NULL DEFAULT 'active', -- active | blocked | archived
  block_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prices (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES product_variants(id),
  currency TEXT NOT NULL DEFAULT 'EUR',
  amount INTEGER NOT NULL,               -- cents, VAT-inclusive consumer price
  compare_at INTEGER,                    -- only when legitimate (previous real price)
  compare_at_evidence TEXT,
  cost_snapshot INTEGER,                 -- supplier cost at pricing time (cents EUR)
  margin_breakdown TEXT,                 -- JSON CashflowBreakdown
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_by TEXT NOT NULL DEFAULT 'pricing-engine'
);
CREATE INDEX IF NOT EXISTS idx_prices_variant_active ON prices(variant_id, active);

CREATE TABLE IF NOT EXISTS inventory (
  variant_id TEXT PRIMARY KEY REFERENCES product_variants(id),
  available INTEGER NOT NULL DEFAULT 0,     -- known supplier stock snapshot
  reserved INTEGER NOT NULL DEFAULT 0,
  protection_threshold INTEGER NOT NULL DEFAULT 3,   -- stop selling below this
  last_synced_at TEXT,
  source TEXT
);

-- ---------- customers / orders ----------
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  email TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  country TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  consent_recorded_at TEXT,
  orders_count INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(store_id, email)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  number TEXT NOT NULL UNIQUE,            -- human order number e.g. AC-1A2B3C
  customer_id TEXT REFERENCES customers(id),
  email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'CREATED',
  mode TEXT NOT NULL,                     -- SIMULATION | TEST | LIVE
  currency TEXT NOT NULL DEFAULT 'EUR',
  subtotal INTEGER NOT NULL DEFAULT 0,
  shipping_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL DEFAULT 0,
  shipping_address TEXT,                  -- JSON Address
  billing_address TEXT,
  payment_provider TEXT,
  payment_ref TEXT,                       -- stripe checkout session id
  payment_intent TEXT,
  validation TEXT,                        -- JSON {FRAUD_CHECK: {ok, notes}, ...}
  cashflow TEXT,                          -- JSON CashflowBreakdown
  supplier_id TEXT,
  supplier_order_ref TEXT,
  supplier_status TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  carrier TEXT,
  notes TEXT,
  utm TEXT,                               -- JSON attribution
  risk_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_store_state ON orders(store_id, state);
CREATE INDEX IF NOT EXISTS idx_orders_payment_ref ON orders(payment_ref);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES product_variants(id),
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  supplier_product_id TEXT,
  total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_transitions_order ON order_transitions(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL UNIQUE,      -- payment_intent id / session id
  status TEXT NOT NULL,                   -- pending | succeeded | failed | refunded | partially_refunded | disputed
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL DEFAULT 0,
  fee_estimated INTEGER NOT NULL DEFAULT 1,  -- 1 until balance transaction fetched
  raw TEXT,                               -- redacted JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,                    -- provider event id (idempotency)
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  error TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  supplier_id TEXT,
  supplier_order_ref TEXT,
  carrier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | shipped | in_transit | delivered | exception
  events TEXT,                            -- JSON array of tracking events
  shipped_at TEXT,
  delivered_at TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  payment_id TEXT REFERENCES payments(id),
  provider_ref TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested', -- requested | approved | processed | failed | rejected
  requires_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_events (
  id TEXT PRIMARY KEY,
  store_id TEXT,
  order_id TEXT,
  kind TEXT NOT NULL,   -- gross_revenue | discount | refund | tax | payment_fee | supplier_cost | shipping_cost | chargeback | chargeback_fee | other_variable_cost | payout
  amount INTEGER NOT NULL,     -- cents, positive = inflow, negative = outflow
  currency TEXT NOT NULL DEFAULT 'EUR',
  estimated INTEGER NOT NULL DEFAULT 0,   -- 1 = estimate, 0 = realized
  ref TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fin_store ON financial_events(store_id, occurred_at);

-- ---------- support ----------
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  order_id TEXT,
  customer_email TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'OTHER',
  subject TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | auto_replied | escalated | resolved
  auto_reply TEXT,
  escalation_reason TEXT,
  thread TEXT,                           -- JSON array of messages
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------- content / seo / social ----------
CREATE TABLE IF NOT EXISTS seo_pages (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  path TEXT NOT NULL,
  kind TEXT NOT NULL,             -- product | category | guide | comparison | faq | use_case | problem_solution | legal | home
  title TEXT NOT NULL,
  meta_description TEXT,
  target_keyword TEXT,
  supporting_keywords TEXT,       -- JSON array
  search_intent TEXT,
  competition_estimate TEXT,
  internal_links TEXT,            -- JSON array of paths
  body_md TEXT,
  quality_gate TEXT,              -- JSON
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | published | retired
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(store_id, path)
);

CREATE TABLE IF NOT EXISTS content (
  id TEXT PRIMARY KEY,
  store_id TEXT,                  -- NULL = AstroNexo brand
  brand_key TEXT NOT NULL DEFAULT 'store',  -- store | astronexo
  stage TEXT NOT NULL DEFAULT 'IDEA',
  category TEXT,
  platform TEXT,
  format TEXT,                    -- reel | carousel | image | pin | short | post
  idea TEXT,
  research TEXT,
  script TEXT,
  copy TEXT,
  hashtags TEXT,                  -- JSON array
  assets TEXT,                    -- JSON array [{path,url,source,license}]
  composition_path TEXT,
  quality TEXT,                   -- JSON
  approval TEXT NOT NULL DEFAULT 'auto',   -- auto | owner
  scheduled_at TEXT,
  published_at TEXT,
  metrics TEXT,                   -- JSON
  learnings TEXT,
  fingerprint TEXT,               -- dedupe / cannibalization key
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_stage ON content(stage, scheduled_at);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  brand_key TEXT NOT NULL,        -- store slug | astronexo
  store_id TEXT,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  external_id TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  credential_name TEXT,           -- env var name holding token (value never stored)
  paused INTEGER NOT NULL DEFAULT 0,
  followers INTEGER,
  last_synced_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES social_accounts(id),
  content_id TEXT REFERENCES content(id),
  platform TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | published | failed | cancelled
  scheduled_at TEXT,
  published_at TEXT,
  permalink TEXT,
  metrics TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engagement_queue (
  id TEXT PRIMARY KEY,
  brand_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,             -- follow | comment | dm | community | conversation
  target TEXT NOT NULL,           -- account/post/community url
  recommendation TEXT NOT NULL,
  why TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

-- ---------- analytics ----------
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  visitor_id TEXT,
  event TEXT NOT NULL,            -- page_view | product_view | add_to_cart | checkout_started | purchase
  path TEXT,
  referrer TEXT,
  source TEXT,                    -- seo | social | direct | referral | email
  utm TEXT,                       -- JSON
  product_id TEXT,
  value INTEGER,
  currency TEXT,
  country TEXT,
  device TEXT,
  consent INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_store_time ON analytics_events(store_id, occurred_at);

CREATE TABLE IF NOT EXISTS daily_metrics (
  store_id TEXT NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD
  visitors INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  product_views INTEGER NOT NULL DEFAULT 0,
  add_to_cart INTEGER NOT NULL DEFAULT 0,
  checkouts INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  revenue INTEGER NOT NULL DEFAULT 0,
  profit_est INTEGER NOT NULL DEFAULT 0,
  seo_sessions INTEGER NOT NULL DEFAULT 0,
  social_sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, day)
);

-- ---------- experiments / evolution ----------
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  store_id TEXT REFERENCES stores(id),
  kind TEXT NOT NULL,             -- hero_copy | pricing | bundle | product_order | cta | navigation | product_selection | content_angle | seo_page
  hypothesis TEXT NOT NULL,
  variants TEXT NOT NULL,         -- JSON array [{key, description, config}]
  metric TEXT NOT NULL,
  min_sample INTEGER NOT NULL DEFAULT 200,
  duration_days INTEGER NOT NULL DEFAULT 14,
  status TEXT NOT NULL DEFAULT 'planned',   -- planned | running | analyzing | decided | cancelled
  result TEXT,                    -- JSON per variant stats
  confidence REAL,
  decision TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fitness_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  fitness REAL NOT NULL,
  components TEXT NOT NULL,       -- JSON
  rank INTEGER,
  lifecycle_before TEXT,
  lifecycle_after TEXT,
  created_at TEXT NOT NULL
);

-- ---------- memory ----------
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- SEMANTIC | EPISODIC | BUSINESS | STORE | PRODUCT | SUPPLIER | CONTENT | EXPERIMENT | CUSTOMER_SUPPORT | SYSTEM
  scope_id TEXT,                  -- store id / product id / supplier id
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT,                      -- JSON array
  importance REAL NOT NULL DEFAULT 0.5,
  source TEXT,
  embedding TEXT,                 -- JSON float array (optional; hashed bag-of-words when no embedder)
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_kind_scope ON memories(kind, scope_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, tags, content='memories', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, COALESCE(new.tags,''));
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES('delete', old.rowid, old.title, old.body, COALESCE(old.tags,''));
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES('delete', old.rowid, old.title, old.body, COALESCE(old.tags,''));
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, COALESCE(new.tags,''));
END;

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_role TEXT,
  job_id TEXT,
  purpose TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL
);

-- ---------- compliance ----------
CREATE TABLE IF NOT EXISTS compliance_items (
  id TEXT PRIMARY KEY,
  store_id TEXT,                  -- NULL = platform-wide
  requirement TEXT NOT NULL,
  area TEXT NOT NULL,             -- GDPR | COOKIES | CONSUMER | VAT | IOSS | GPSR | CE | IDENTITY | TERMS | RETURNS | SHIPPING | PRICING | INVOICE
  status TEXT NOT NULL DEFAULT 'NEEDS_OWNER',   -- VERIFIED | NEEDS_OWNER | NOT_APPLICABLE | BLOCKING
  critical INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  source_url TEXT,
  notes TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL
);

-- ---------- edge sync ----------
CREATE TABLE IF NOT EXISTS edge_inbox (
  id TEXT PRIMARY KEY,            -- edge-side id
  kind TEXT NOT NULL,             -- stripe_event | analytics_batch | support_message | checkout_started
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT
);
