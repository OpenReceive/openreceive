#nullable enable
using System;
using BTCPayServer.Abstractions.Contracts;
using BTCPayServer.Abstractions.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Options;
using Npgsql.EntityFrameworkCore.PostgreSQL.Infrastructure;

namespace BTCPayServer.Plugins.OpenReceive.Data;

/// <summary>
/// The plugin's own schema inside BTCPay's Postgres. BTCPay (the host) passes its
/// database and runs the migration at startup through its own workflow; the plugin owns
/// the schema — the AGENTS.md persistence model, with BTCPay as the host application.
/// </summary>
public sealed class OpenReceivePluginDbContext : DbContext
{
    public const string Schema = "BTCPayServer.Plugins.OpenReceive";

    public OpenReceivePluginDbContext(DbContextOptions<OpenReceivePluginDbContext> options) : base(options)
    {
    }

    public DbSet<OpenReceiveSwap> Swaps => Set<OpenReceiveSwap>();

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        // The migration is hand-written (no model snapshot ships with the plugin), so
        // EF's snapshot-vs-model comparison has nothing to compare against.
        optionsBuilder.ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning));
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasDefaultSchema(Schema);
        var swap = modelBuilder.Entity<OpenReceiveSwap>();
        swap.ToTable("openreceive_swaps");
        swap.HasKey(s => s.Id);
        swap.Property(s => s.Id).HasColumnName("id");
        swap.Property(s => s.StoreId).HasColumnName("store_id");
        swap.Property(s => s.InvoiceId).HasColumnName("invoice_id");
        swap.Property(s => s.PaymentHash).HasColumnName("payment_hash");
        swap.Property(s => s.Bolt11).HasColumnName("bolt11");
        swap.Property(s => s.InvoiceAmountMsats).HasColumnName("invoice_amount_msats");
        swap.Property(s => s.Provider).HasColumnName("provider");
        swap.Property(s => s.ProviderOrderId).HasColumnName("provider_order_id");
        swap.Property(s => s.ProviderToken).HasColumnName("provider_token");
        swap.Property(s => s.PayInAsset).HasColumnName("pay_in_asset");
        swap.Property(s => s.DepositAddress).HasColumnName("deposit_address");
        swap.Property(s => s.DepositMemo).HasColumnName("deposit_memo");
        swap.Property(s => s.DepositAmount).HasColumnName("deposit_amount");
        swap.Property(s => s.ProviderExpiresAt).HasColumnName("provider_expires_at");
        swap.Property(s => s.State).HasColumnName("state");
        swap.Property(s => s.StateReason).HasColumnName("state_reason");
        swap.Property(s => s.Attention).HasColumnName("attention");
        swap.Property(s => s.AttentionReason).HasColumnName("attention_reason");
        swap.Property(s => s.PluginReason).HasColumnName("plugin_reason");
        swap.Property(s => s.RefundReason).HasColumnName("refund_reason");
        swap.Property(s => s.RefundAddress).HasColumnName("refund_address");
        swap.Property(s => s.RefundTxId).HasColumnName("refund_tx_id");
        swap.Property(s => s.DepositTxId).HasColumnName("deposit_tx_id");
        swap.Property(s => s.PayoutTxId).HasColumnName("payout_tx_id");
        swap.Property(s => s.DepositReceivedAmount).HasColumnName("deposit_received_amount");
        swap.Property(s => s.RefundAmount).HasColumnName("refund_amount");
        swap.Property(s => s.EmergencyRepeat).HasColumnName("emergency_repeat");
        swap.Property(s => s.FeeCurrency).HasColumnName("fee_currency");
        swap.Property(s => s.PayInFiat).HasColumnName("pay_in_fiat");
        swap.Property(s => s.PayoutFiat).HasColumnName("payout_fiat");
        swap.Property(s => s.CreatedAt).HasColumnName("created_at");
        swap.Property(s => s.UpdatedAt).HasColumnName("updated_at");
        swap.Property(s => s.StateChangedAt).HasColumnName("state_changed_at");
        swap.Property(s => s.LastPolledAt).HasColumnName("last_polled_at");
        swap.Property(s => s.WalletSettledAt).HasColumnName("wallet_settled_at");
        // Postgres' system column xmin as the concurrency token: no migration, and every
        // UPDATE is "WHERE xmin = <loaded>" (EfSwapStore turns a miss into SwapConcurrencyException).
        swap.Property(s => s.Version).HasColumnName("xmin").HasColumnType("xid").ValueGeneratedOnAddOrUpdate().IsConcurrencyToken();
        swap.Ignore(s => s.IsTerminal);
        swap.HasIndex(s => s.InvoiceId).HasDatabaseName("ix_openreceive_swaps_invoice_id");
        swap.HasIndex(s => s.StoreId).HasDatabaseName("ix_openreceive_swaps_store_id");
        swap.HasIndex(s => new { s.Provider, s.ProviderOrderId }).IsUnique().HasDatabaseName("ux_openreceive_swaps_provider_order");
        swap.HasIndex(s => s.State).HasDatabaseName("ix_openreceive_swaps_state_live").HasFilter(Migrations.InitialSwaps.LiveStateFilter);
        swap.HasIndex(s => new { s.InvoiceId, s.PayInAsset }).IsUnique().HasDatabaseName("ux_openreceive_swaps_live_invoice_asset").HasFilter(Migrations.InitialSwaps.LiveStateFilter);
    }
}

public sealed class OpenReceiveDbContextFactory : BaseDbContextFactory<OpenReceivePluginDbContext>
{
    public OpenReceiveDbContextFactory(IOptions<DatabaseOptions> options) : base(options, OpenReceivePluginDbContext.Schema)
    {
    }

    public override OpenReceivePluginDbContext CreateContext(Action<NpgsqlDbContextOptionsBuilder>? npgsqlOptionsAction = null)
    {
        var builder = new DbContextOptionsBuilder<OpenReceivePluginDbContext>();
        ConfigureBuilder(builder, npgsqlOptionsAction);
        return new OpenReceivePluginDbContext(builder.Options);
    }
}
