#nullable enable
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace BTCPayServer.Plugins.OpenReceive.Data.Migrations;

[DbContext(typeof(OpenReceivePluginDbContext))]
[Migration("20260921000000_PaymentSafetyRecovery")]
public sealed class PaymentSafetyRecovery : Migration
{
    public const string OfferedStateFilter = "retired_at IS NULL AND " + InitialSwaps.LiveStateFilter;
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql($$"""
            ALTER TABLE "{{OpenReceivePluginDbContext.Schema}}".openreceive_invoices
                ADD COLUMN connection_id text,
                ADD COLUMN store_id text,
                ADD COLUMN host_invoice_id text,
                ADD COLUMN payment_method_id text,
                ADD COLUMN next_recovery_at bigint NOT NULL DEFAULT 0,
                ADD COLUMN recovery_closed_at bigint,
                ADD COLUMN recovery_reason text,
                ADD COLUMN host_update_required boolean NOT NULL DEFAULT false,
                ADD COLUMN created_at_authoritative boolean NOT NULL DEFAULT false;
            CREATE INDEX ix_openreceive_invoice_recovery ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_invoices (next_recovery_at, payment_hash) WHERE recovery_closed_at IS NULL;
            ALTER TABLE "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps
                ADD COLUMN retired_at bigint,
                ADD COLUMN replacement_id text,
                ADD COLUMN recovery_refresh_required boolean NOT NULL DEFAULT false,
                ADD COLUMN last_observed_at bigint,
                ADD COLUMN next_poll_at bigint,
                ADD COLUMN poll_lease_until bigint,
                ADD COLUMN poll_lease_owner text;
            UPDATE "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps
                SET retired_at = updated_at, recovery_refresh_required = true, next_poll_at = 0
                WHERE state_reason = 'superseded_near_provider_expiry';
            DROP INDEX "{{OpenReceivePluginDbContext.Schema}}".ux_openreceive_swaps_live_invoice_asset;
            CREATE UNIQUE INDEX ux_openreceive_swaps_live_invoice_asset ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (invoice_id, pay_in_asset) WHERE {{OfferedStateFilter}};
            CREATE INDEX ix_openreceive_swaps_poll_due ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (next_poll_at, last_polled_at, id);
            """);
    }
}
