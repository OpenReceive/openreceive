"""The tables OpenReceive keeps in Odoo's own PostgreSQL database.

`PAYMENTS_DDL` is the library's canonical PostgreSQL schema
(`openreceive.storage.sql.ddl.payments_schema_sql("postgresql")`) with
`IF NOT EXISTS` added, so activating the module again or upgrading it leaves
existing rows alone. It is copied rather than rendered because rendering needs
SQLAlchemy, which Odoo does not ship; packages/python/odoo/tests checks the copy
against the library. `SETTINGS_DDL` is this module's own table for the wallet
and swap codes: no Odoo screen lists it.
"""

PAYMENTS_TABLE = "openreceive_payments"
META_TABLE = "openreceive_meta"
SETTINGS_TABLE = "openreceive_odoo_settings"

PAYMENTS_DDL = """
CREATE TABLE IF NOT EXISTS openreceive_payments (
	id BIGSERIAL NOT NULL,
	reference VARCHAR(255) NOT NULL,
	payment_hash VARCHAR(64) NOT NULL,
	status VARCHAR(32) DEFAULT 'pending' NOT NULL,
	status_reason VARCHAR(255),
	paid_at TIMESTAMP WITHOUT TIME ZONE,
	expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	checkout_data JSON NOT NULL,
	swap_data JSON,
	client_ip VARCHAR(255),
	inserted_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT openreceive_payments_status_check CHECK (status IN ('pending', 'settled', 'expired', 'failed', 'attention')),
	CONSTRAINT openreceive_payments_payment_hash_check CHECK (payment_hash ~ '^[0-9a-f]{64}$'),
	UNIQUE (payment_hash)
);
CREATE INDEX IF NOT EXISTS openreceive_payments_client_ip_inserted_idx ON openreceive_payments (client_ip, inserted_at);
CREATE INDEX IF NOT EXISTS openreceive_payments_reference_created_idx ON openreceive_payments (reference, created_at);
CREATE INDEX IF NOT EXISTS openreceive_payments_status_created_idx ON openreceive_payments (status, created_at);
CREATE TABLE IF NOT EXISTS openreceive_meta (
	key VARCHAR(255) NOT NULL,
	value TEXT NOT NULL,
	rev BIGINT DEFAULT '0' NOT NULL,
	PRIMARY KEY (key)
);
INSERT INTO openreceive_meta (key, value, rev) VALUES ('schema_version', '1', 0) ON CONFLICT (key) DO NOTHING;
"""

SETTINGS_DDL = """
CREATE TABLE IF NOT EXISTS openreceive_odoo_settings (
	key VARCHAR(64) NOT NULL,
	value TEXT NOT NULL,
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (key)
);
"""


def create_tables(cr):
    """Create every table this module needs, keeping any that exist."""
    cr.execute(PAYMENTS_DDL)
    cr.execute(SETTINGS_DDL)
