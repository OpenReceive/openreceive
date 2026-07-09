-- Migration 001 — normalized openreceive_invoices (SQLite dialect).
--
-- SQLite sibling of 001_create_openreceive_invoices.postgres.sql. SQLite has no JSONB,
-- TIMESTAMPTZ, or regex CHECKs, so JSON is stored as TEXT, timestamps as INTEGER unix
-- seconds, and format validation happens in application code. Field/enum shapes match the
-- Postgres schema exactly so both dialects satisfy the same invoice-storage contract.

CREATE TABLE IF NOT EXISTS openreceive_invoices (
  invoice_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotency_request_hash TEXT NOT NULL,
  order_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  invoice TEXT NOT NULL UNIQUE,
  amount_msats INTEGER NOT NULL,
  transaction_state TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  settlement_action_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  settlement_action_completed_at INTEGER,
  refreshed_from_invoice_id TEXT REFERENCES openreceive_invoices(invoice_id),
  metadata TEXT NOT NULL DEFAULT '{}',
  fiat_quote TEXT,
  created_row_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_row_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT openreceive_invoices_amount_msats_bounds
    CHECK (amount_msats >= 1000 AND amount_msats <= 9007199254740991),
  CONSTRAINT openreceive_invoices_time_order
    CHECK (expires_at >= created_at),
  CONSTRAINT openreceive_invoices_transaction_state
    CHECK (transaction_state IN ('pending', 'settled', 'expired', 'failed', 'accepted')),
  CONSTRAINT openreceive_invoices_workflow_state
    CHECK (workflow_state IN (
      'draft',
      'invoice_created',
      'verifying',
      'settlement_action_pending',
      'settlement_action_completed',
      'expiry_pending_verification',
      'expired_closed',
      'failed_closed',
      'cancelled'
    )),
  CONSTRAINT openreceive_invoices_settlement_action_state
    CHECK (settlement_action_state IN ('pending', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS openreceive_invoices_idempotency_scope_idx
  ON openreceive_invoices (namespace, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS openreceive_invoices_recovery_idx
  ON openreceive_invoices (workflow_state, transaction_state, expires_at);

CREATE INDEX IF NOT EXISTS openreceive_invoices_order_idx
  ON openreceive_invoices (order_id, created_at);

CREATE INDEX IF NOT EXISTS openreceive_invoices_checkout_idx
  ON openreceive_invoices (checkout_id, created_at);

CREATE TABLE IF NOT EXISTS openreceive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS openreceive_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO openreceive_schema_migrations (version) VALUES ('v0.2');
