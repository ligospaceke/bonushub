-- BonasHub v2 schema. Money is stored as integer minor units (KES cents). Timestamps are ISO-8601 UTC text.
-- Financial tables (ledger_entries, payment_events, order_status_history, audit_log) are append-only, enforced by triggers.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buyer','seller','admin')),
  staff_role TEXT CHECK (staff_role IN ('owner','finance','catalogue','support')),
  full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  country TEXT, county TEXT, town TEXT,
  account_type TEXT CHECK (account_type IN ('individual','business')),
  business_name TEXT, business_type TEXT,
  email_verified_at TEXT, phone_verified_at TEXT,
  consent_at TEXT, consent_version TEXT,
  created_at TEXT NOT NULL,
  CHECK (role <> 'admin' OR staff_role IS NOT NULL)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE verification_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','phone')),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_vcodes_user ON verification_codes(user_id);

-- Messages waiting for an email/SMS provider. No provider is wired yet; the in-platform notification is always created too.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  channel TEXT NOT NULL,
  to_addr TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
-- Guard table: a statement that inserts NULL here aborts the whole D1 batch (used for conditional atomic writes).
CREATE TABLE guard (ok INTEGER NOT NULL);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  commission_bps INTEGER CHECK (commission_bps IS NULL OR (commission_bps >= 0 AND commission_bps <= 10000))
);

CREATE TABLE seller_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  slug TEXT NOT NULL UNIQUE,
  contact_name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  reg_no TEXT,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  location TEXT,
  country TEXT, region TEXT, town TEXT,
  description TEXT,
  category_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  status_reason TEXT,
  status_changed_at TEXT,
  approved_at TEXT,
  founding INTEGER NOT NULL DEFAULT 0,
  founding_expires_at TEXT,
  commission_override_bps INTEGER CHECK (commission_override_bps IS NULL OR (commission_override_bps >= 0 AND commission_override_bps <= 10000)),
  commission_override_reason TEXT,
  delivery_flat_minor INTEGER CHECK (delivery_flat_minor IS NULL OR delivery_flat_minor >= 0),
  delivery_regions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sellers_status ON seller_profiles(status);

-- Metadata only. File bytes belong in private object storage (see README, "Not built yet").
CREATE TABLE seller_documents (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(user_id),
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  note TEXT,
  storage_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(user_id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  brand TEXT,
  description TEXT,
  specs TEXT NOT NULL DEFAULT '[]',
  unit TEXT NOT NULL DEFAULT 'unit',
  moq INTEGER NOT NULL DEFAULT 1 CHECK (moq >= 1),
  stock_qty INTEGER CHECK (stock_qty IS NULL OR stock_qty >= 0),
  price_model TEXT NOT NULL CHECK (price_model IN ('fixed','quote')),
  unit_price_minor INTEGER CHECK (unit_price_minor IS NULL OR unit_price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES',
  origin_country TEXT,
  delivery_options TEXT NOT NULL DEFAULT 'both' CHECK (delivery_options IN ('delivery','collection','both')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','active','rejected','removed')),
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (price_model <> 'fixed' OR unit_price_minor IS NOT NULL)
);
CREATE INDEX idx_products_seller ON products(seller_id);
CREATE INDEX idx_products_cat_status ON products(category_id, status);

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pimages_product ON product_images(product_id);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT, name TEXT NOT NULL, phone TEXT NOT NULL,
  county TEXT NOT NULL, town TEXT NOT NULL, address TEXT, notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE quotations (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  buyer_id TEXT NOT NULL REFERENCES users(id),
  seller_id TEXT NOT NULL REFERENCES seller_profiles(user_id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  delivery_location TEXT,
  delivery_method TEXT NOT NULL DEFAULT 'delivery' CHECK (delivery_method IN ('delivery','collection')),
  needed_by TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','quoted','accepted','declined','expired','converted')),
  quoted_unit_price_minor INTEGER CHECK (quoted_unit_price_minor IS NULL OR quoted_unit_price_minor > 0),
  quoted_delivery_minor INTEGER CHECK (quoted_delivery_minor IS NULL OR quoted_delivery_minor >= 0),
  valid_until TEXT,
  seller_notes TEXT,
  order_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_quotes_buyer ON quotations(buyer_id);
CREATE INDEX idx_quotes_seller ON quotations(seller_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  buyer_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  product_subtotal_minor INTEGER NOT NULL,
  delivery_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  delivery_json TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (buyer_id, idempotency_key)
);
CREATE INDEX idx_orders_buyer ON orders(buyer_id, created_at);

CREATE TABLE seller_orders (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  seller_id TEXT NOT NULL REFERENCES seller_profiles(user_id),
  status TEXT NOT NULL CHECK (status IN ('awaiting_payment','payment_confirmed','seller_processing','ready_for_dispatch','dispatched','delivered','completed','cancelled','refund_requested','refunded')),
  prior_status TEXT,
  product_subtotal_minor INTEGER NOT NULL,
  delivery_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  commission_bps INTEGER,
  commission_rule TEXT,
  commission_minor INTEGER NOT NULL,
  commission_reversed_minor INTEGER NOT NULL DEFAULT 0,
  commission_status TEXT NOT NULL DEFAULT 'accrued' CHECK (commission_status IN ('accrued','earned','reversed')),
  earn_after TEXT,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  settlement_status TEXT NOT NULL DEFAULT 'unsettled' CHECK (settlement_status IN ('unsettled','in_settlement','settled')),
  settlement_id TEXT,
  tracking_ref TEXT, carrier TEXT, proof_note TEXT,
  dispatched_at TEXT, delivered_at TEXT, completed_at TEXT,
  cancel_reason TEXT,
  dispute_open INTEGER NOT NULL DEFAULT 0,
  quote_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sorders_seller ON seller_orders(seller_id, status);
CREATE INDEX idx_sorders_order ON seller_orders(order_id);
CREATE INDEX idx_sorders_status ON seller_orders(status);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  category_id TEXT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty >= 1),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0),
  line_subtotal_minor INTEGER NOT NULL,
  commission_bps INTEGER NOT NULL,
  commission_rule TEXT NOT NULL
);
CREATE INDEX idx_oitems_sorder ON order_items(seller_order_id);
CREATE INDEX idx_oitems_product ON order_items(product_id);

CREATE TABLE order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_osh_sorder ON order_status_history(seller_order_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES',
  method TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed','partially_refunded','refunded')),
  failure_reason TEXT,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_order ON payments(order_id);

CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  payment_ref TEXT,
  type TEXT,
  payload TEXT NOT NULL,
  signature_ok INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider, provider_event_id)
);

-- The simulated gateway's own record of truth. Only the sandbox "pay" action writes here. Never present in production use.
CREATE TABLE sandbox_txns (
  payment_ref TEXT PRIMARY KEY,
  provider_ref TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','success','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id),
  payment_id TEXT REFERENCES payments(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  product_portion_minor INTEGER NOT NULL DEFAULT 0,
  commission_reversal_minor INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','processed','rejected')),
  requested_by TEXT, decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_refunds_sorder ON refunds(seller_order_id);

CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id),
  opened_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  account TEXT NOT NULL CHECK (account IN ('gateway_clearing','seller_payable','commission_accrued','commission_earned')),
  seller_id TEXT,
  order_ref TEXT,
  sub_order_ref TEXT,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  ref TEXT,
  note TEXT
);
CREATE INDEX idx_ledger_seller ON ledger_entries(seller_id, account);
CREATE INDEX idx_ledger_sub ON ledger_entries(sub_order_ref);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  seller_id TEXT NOT NULL REFERENCES seller_profiles(user_id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending','processed')),
  method TEXT,
  reference TEXT,
  note TEXT,
  created_by TEXT, processed_by TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX idx_settlements_seller ON settlements(seller_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  data TEXT,
  prev_hash TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL
);

-- Append-only enforcement
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER pevents_no_update BEFORE UPDATE ON payment_events BEGIN SELECT RAISE(ABORT, 'payment_events is append-only'); END;
CREATE TRIGGER pevents_no_delete BEFORE DELETE ON payment_events BEGIN SELECT RAISE(ABORT, 'payment_events is append-only'); END;
CREATE TRIGGER osh_no_update BEFORE UPDATE ON order_status_history BEGIN SELECT RAISE(ABORT, 'order_status_history is append-only'); END;
CREATE TRIGGER osh_no_delete BEFORE DELETE ON order_status_history BEGIN SELECT RAISE(ABORT, 'order_status_history is append-only'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Financial records are never deleted, only cancelled or reversed.
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted'); END;
CREATE TRIGGER sorders_no_delete BEFORE DELETE ON seller_orders BEGIN SELECT RAISE(ABORT, 'seller_orders cannot be deleted'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'payments cannot be deleted'); END;
CREATE TRIGGER settlements_no_delete BEFORE DELETE ON settlements BEGIN SELECT RAISE(ABORT, 'settlements cannot be deleted'); END;
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds BEGIN SELECT RAISE(ABORT, 'refunds cannot be deleted'); END;

-- Seed: the ten launch categories (admin can edit, reorder and remove without code changes)
INSERT INTO categories (id, slug, name, sort_order) VALUES
 ('cat_construction_machinery','construction-machinery','Construction machinery and equipment',1),
 ('cat_agri_machinery','agricultural-machinery','Agricultural machinery and equipment',2),
 ('cat_building_materials','building-materials','Building and construction materials',3),
 ('cat_ev_transport','electric-vehicles-transport','Electric vehicles and commercial transport',4),
 ('cat_industrial','industrial-machinery','Industrial machinery and equipment',5),
 ('cat_electrical','electrical-electronics','Electrical and electronic products',6),
 ('cat_wholesale','wholesale-bulk','Wholesale and bulk merchandise',7),
 ('cat_agri_inputs','agricultural-inputs','Agricultural inputs and supplies',8),
 ('cat_household','household-commercial','Household and commercial products',9),
 ('cat_other','other-approved','Other approved physical merchandise',10);

INSERT INTO settings (key, value) VALUES
 ('defaultBps','500'),
 ('foundingBps','300'),
 ('foundingSlots','50'),
 ('foundingMonths','6'),
 ('disputeWindowDays','7'),
 ('autoCompleteDays','7'),
 ('paymentExpiryMinutes','30'),
 ('currency','KES');

INSERT INTO counters (name, value) VALUES ('order', 0), ('payment', 0), ('quote', 0), ('refund', 0), ('settlement', 0);
