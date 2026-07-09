-- Migration 002 — capability tokens (PART 2 of the route-shipping spec).
--
-- Adds a per-order capability-token hash to the normalized openreceive_invoices table so
-- anonymous payers can poll their own order without a login and cannot read anyone else's.
-- The raw token is returned once at checkout creation as `order_access_token`; only its
-- sha256 hash (`sha256:<64hex>`) is stored here. Reads present the token and the route
-- verifies it by hashing and comparing to the stored hash for that order_id.
--
-- Note: the JS KV stores persist this hash in the meta KV instead (no column needed there);
-- see docs/internal/adr/ADR-0008-route-shipping-decisions.md. This column is the canonical shape
-- for hosts (e.g. Rails) running the fully normalized schema.

ALTER TABLE openreceive_invoices
  ADD COLUMN IF NOT EXISTS order_access_token_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'openreceive_invoices_order_token_hash'
  ) THEN
    ALTER TABLE openreceive_invoices
      ADD CONSTRAINT openreceive_invoices_order_token_hash
      CHECK (
        order_access_token_hash IS NULL
        OR order_access_token_hash ~ '^sha256:[0-9a-f]{64}$'
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS openreceive_invoices_order_token_idx
  ON openreceive_invoices (order_id, order_access_token_hash);

INSERT INTO openreceive_schema_migrations (version)
  VALUES ('v0.3')
  ON CONFLICT (version) DO NOTHING;
