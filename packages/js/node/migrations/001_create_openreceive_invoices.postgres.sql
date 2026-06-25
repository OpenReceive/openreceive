CREATE TABLE IF NOT EXISTS openreceive_invoices (
  invoice_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotency_request_hash TEXT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  invoice TEXT NOT NULL UNIQUE,
  amount_msats BIGINT NOT NULL,
  transaction_state TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  settlement_action_state TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  settled_at BIGINT,
  settlement_action_completed_at BIGINT,
  refreshed_from_invoice_id TEXT REFERENCES openreceive_invoices(invoice_id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fiat_quote JSONB,
  created_row_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_row_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT openreceive_invoices_idempotency_hash
    CHECK (idempotency_request_hash ~ '^sha256:[0-9a-f]{64}$'),
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

CREATE TABLE IF NOT EXISTS openreceive_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO openreceive_schema_migrations (version)
  VALUES ('v0.1')
  ON CONFLICT (version) DO NOTHING;
