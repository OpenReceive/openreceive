-- Migration 002 — capability tokens (PART 2 of the route-shipping spec). SQLite dialect.
--
-- Adds a per-order capability-token hash to the normalized openreceive_invoices table.
-- The raw token is returned once at checkout creation as `order_access_token`; only its
-- sha256 hash (`sha256:<64hex>`) is stored. SQLite lacks regex CHECKs, so the format is
-- validated in application code; a coarse prefix GLOB guards obvious corruption.
--
-- The JS KV SQLite store persists this hash in the meta KV instead (no column needed there);
-- see docs/internal/adr/ADR-0008-route-shipping-decisions.md.

ALTER TABLE openreceive_invoices
  ADD COLUMN order_access_token_hash TEXT
    CHECK (order_access_token_hash IS NULL OR order_access_token_hash GLOB 'sha256:*');

CREATE INDEX IF NOT EXISTS openreceive_invoices_order_token_idx
  ON openreceive_invoices (order_id, order_access_token_hash);

INSERT OR IGNORE INTO openreceive_schema_migrations (version)
  VALUES ('v0.3');
