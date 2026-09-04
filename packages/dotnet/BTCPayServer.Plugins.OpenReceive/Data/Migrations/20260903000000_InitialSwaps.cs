#nullable enable
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace BTCPayServer.Plugins.OpenReceive.Data.Migrations;

/// <summary>The one table the plugin owns. Hand-written (BTCPay migration rules: no Designer, no Down).</summary>
[DbContext(typeof(OpenReceivePluginDbContext))]
[Migration("20260903000000_InitialSwaps")]
public sealed class InitialSwaps : Migration
{
    /// <summary>Non-terminal states, from spec/data/kernel-tables.json (expired, refunded, attention, failed are terminal).</summary>
    public const string LiveStateFilter = "state NOT IN ('expired', 'refunded', 'attention', 'failed')";

    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.EnsureSchema(name: OpenReceivePluginDbContext.Schema);
        migrationBuilder.Sql($$"""
            CREATE TABLE IF NOT EXISTS "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (
                id text NOT NULL PRIMARY KEY,
                store_id text NOT NULL,
                invoice_id text NOT NULL,
                payment_hash text NOT NULL CHECK (payment_hash ~ '^[0-9a-f]{64}$'),
                bolt11 text NOT NULL,
                invoice_amount_msats bigint NOT NULL,
                provider text NOT NULL,
                provider_order_id text NOT NULL,
                provider_token text NOT NULL,
                pay_in_asset text NOT NULL,
                deposit_address text NOT NULL,
                deposit_memo text NULL,
                deposit_amount text NOT NULL,
                provider_expires_at bigint NOT NULL,
                state text NOT NULL,
                state_reason text NULL,
                attention boolean NOT NULL DEFAULT false,
                attention_reason text NULL,
                plugin_reason text NULL,
                refund_reason text NULL,
                refund_address text NULL,
                refund_tx_id text NULL,
                deposit_tx_id text NULL,
                payout_tx_id text NULL,
                deposit_received_amount text NULL,
                refund_amount text NULL,
                emergency_repeat boolean NOT NULL DEFAULT false,
                fee_currency text NULL,
                pay_in_fiat text NULL,
                payout_fiat text NULL,
                created_at bigint NOT NULL,
                updated_at bigint NOT NULL,
                state_changed_at bigint NOT NULL,
                last_polled_at bigint NULL,
                wallet_settled_at bigint NULL
            );
            CREATE INDEX IF NOT EXISTS ix_openreceive_swaps_invoice_id ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (invoice_id);
            CREATE INDEX IF NOT EXISTS ix_openreceive_swaps_store_id ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (store_id);
            CREATE UNIQUE INDEX IF NOT EXISTS ux_openreceive_swaps_provider_order ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (provider, provider_order_id);
            CREATE INDEX IF NOT EXISTS ix_openreceive_swaps_state_live ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (state) WHERE {{LiveStateFilter}};
            CREATE UNIQUE INDEX IF NOT EXISTS ux_openreceive_swaps_live_invoice_asset ON "{{OpenReceivePluginDbContext.Schema}}".openreceive_swaps (invoice_id, pay_in_asset) WHERE {{LiveStateFilter}};
            """);
    }
}
