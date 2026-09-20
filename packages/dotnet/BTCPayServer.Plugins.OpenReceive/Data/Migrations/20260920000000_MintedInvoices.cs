#nullable enable
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace BTCPayServer.Plugins.OpenReceive.Data.Migrations;

/// <summary>The minted-invoice table. Hand-written (BTCPay migration rules: no Designer, no Down).</summary>
[DbContext(typeof(OpenReceivePluginDbContext))]
[Migration("20260920000000_MintedInvoices")]
public sealed class MintedInvoices : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql($$"""
            CREATE TABLE IF NOT EXISTS "{{OpenReceivePluginDbContext.Schema}}".openreceive_invoices (
                payment_hash text NOT NULL PRIMARY KEY CHECK (payment_hash ~ '^[0-9a-f]{64}$'),
                bolt11 text NOT NULL,
                amount_msats bigint NOT NULL,
                created_at bigint NOT NULL,
                expires_at bigint NOT NULL
            );
            """);
    }
}
