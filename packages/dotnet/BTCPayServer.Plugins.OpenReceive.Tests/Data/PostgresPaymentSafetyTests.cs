using BTCPayServer.Abstractions.Models;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Data;

public sealed class PostgresPaymentSafetyTests
{
    [Fact]
    public async Task Shipped_rows_upgrade_without_losing_refund_credentials_or_guessing_wallet_scope()
    {
        var connection = Environment.GetEnvironmentVariable("OPENRECEIVE_DOTNET_POSTGRES");
        Assert.SkipUnless(!string.IsNullOrEmpty(connection), "OPENRECEIVE_DOTNET_POSTGRES is not configured: migration lane skipped.");
        var name = "openreceive_upgrade_" + Guid.NewGuid().ToString("N");
        await using var admin = new NpgsqlConnection(connection);
        await admin.OpenAsync();
        await using (var create = new NpgsqlCommand($"CREATE DATABASE {name}", admin)) await create.ExecuteNonQueryAsync();
        try
        {
            var builder = new NpgsqlConnectionStringBuilder(connection) { Database = name, Pooling = false };
            var factory = new OpenReceiveDbContextFactory(Options.Create(new DatabaseOptions { ConnectionString = builder.ConnectionString }));
            await using (var baseline = factory.CreateContext())
            {
                await baseline.GetService<IMigrator>().MigrateAsync("20260920000000_MintedInvoices");
                await baseline.Database.ExecuteSqlRawAsync("""
                    INSERT INTO "BTCPayServer.Plugins.OpenReceive".openreceive_invoices
                        (payment_hash, bolt11, amount_msats, created_at, expires_at)
                    VALUES (repeat('a',64), 'fixture-bolt', 1000, 100, 1900);
                    INSERT INTO "BTCPayServer.Plugins.OpenReceive".openreceive_swaps
                        (id, store_id, invoice_id, payment_hash, bolt11, invoice_amount_msats, provider, provider_order_id,
                         provider_token, pay_in_asset, deposit_address, deposit_amount, provider_expires_at, state, state_reason,
                         refund_address, created_at, updated_at, state_changed_at)
                    VALUES ('legacy', 'store', 'invoice', repeat('a',64), 'fixture-bolt', 1000, 'fixture', 'order',
                         'invalid-fixture-token', 'USDT_TRON', 'fixture-address', '1', 700, 'expired', 'superseded_near_provider_expiry',
                         'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', 100, 650, 650),
                        ('terminal', 'store', 'invoice', repeat('b',64), 'fixture-bolt', 1000, 'fixture', 'terminal-order',
                         'invalid-terminal-token', 'USDT_TRON', 'fixture-address', '1', 700, 'refunded', NULL,
                         'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', 100, 650, 650);
                    """);
                await baseline.Database.MigrateAsync();
            }
            var rows = await new EfSwapStore(factory).ForInvoiceAsync("invoice", CancellationToken.None);
            var legacy = rows.Single(r => r.Id == "legacy");
            Assert.Equal(650, legacy.RetiredAt);
            Assert.True(legacy.RecoveryRefreshRequired);
            Assert.Equal("invalid-fixture-token", legacy.ProviderToken);
            Assert.NotNull(legacy.RefundAddress);
            Assert.True(SwapService.IsDue(legacy, 1800000000));
            var terminal = rows.Single(r => r.Id == "terminal");
            Assert.False(terminal.RecoveryRefreshRequired);
            Assert.False(SwapService.IsPolled(terminal));
            var mint = await new EfInvoiceStore(factory).FindAsync(new string('a', 64), CancellationToken.None);
            Assert.Null(mint!.ConnectionId);
            Assert.Null(mint.RecoveryClosedAt);
            Assert.False(mint.CreatedAtAuthoritative);
        }
        finally
        {
            await using var drop = new NpgsqlCommand($"DROP DATABASE {name} WITH (FORCE)", admin);
            await drop.ExecuteNonQueryAsync();
        }
    }

    [Fact]
    public async Task Real_xmin_atomic_replacement_poll_claims_and_additive_upgrade()
    {
        var connection = Environment.GetEnvironmentVariable("OPENRECEIVE_DOTNET_POSTGRES");
        Assert.SkipUnless(!string.IsNullOrEmpty(connection), "OPENRECEIVE_DOTNET_POSTGRES is not configured: real PostgreSQL safety lane skipped.");
        var factory = new OpenReceiveDbContextFactory(Options.Create(new DatabaseOptions { ConnectionString = connection! }));
        await using (var db = factory.CreateContext()) await db.Database.MigrateAsync();
        var a = new EfSwapStore(factory);
        var b = new EfSwapStore(factory);
        var unique = Guid.NewGuid().ToString("N");
        var row = new OpenReceiveSwap { PaymentHash = new string('a', 64), InvoiceId = unique, StoreId = unique, Provider = "fixture", ProviderOrderId = unique,
            PayInAsset = "USDT_TRON", State = "awaiting_deposit", ProviderExpiresAt = 1800000900, LastPolledAt = 0 };
        await a.InsertAsync(row, CancellationToken.None);
        var stale = (await a.GetAsync(row.Id, CancellationToken.None))!;
        var fresh = (await b.GetAsync(row.Id, CancellationToken.None))!;
        fresh.RefundAddress = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
        fresh.State = "refund_pending";
        await b.UpdateAsync(fresh, CancellationToken.None);
        stale.State = "expired";
        await Assert.ThrowsAsync<SwapConcurrencyException>(() => a.UpdateAsync(stale, CancellationToken.None));
        Assert.Equal("refund_pending", (await a.GetAsync(row.Id, CancellationToken.None))!.State);
        var claims = await Task.WhenAll(a.ClaimPollAsync(row.Id, 1000, "worker-a", 90, CancellationToken.None), b.ClaimPollAsync(row.Id, 1000, "worker-b", 90, CancellationToken.None));
        Assert.Single(claims, c => c is not null);
        Assert.Null(await a.ClaimPollAsync(row.Id, 1089, "restart", 90, CancellationToken.None));
        var reclaimed = await b.ClaimPollAsync(row.Id, 1090, "restart", 90, CancellationToken.None);
        Assert.NotNull(reclaimed);
        await a.ReleasePollAsync(row.Id, "worker-a", CancellationToken.None);
        Assert.Equal("restart", (await a.GetAsync(row.Id, CancellationToken.None))!.PollLeaseOwner);
        await b.ReleasePollAsync(row.Id, "restart", CancellationToken.None);

        var old = (await a.GetAsync(row.Id, CancellationToken.None))!;
        var replacement = new OpenReceiveSwap { PaymentHash = new string('a', 64), InvoiceId = unique, StoreId = unique, Provider = "fixture", ProviderOrderId = unique + "-new", PayInAsset = "USDT_TRON", State = "awaiting_deposit" };
        await a.ReplaceAsync(old, replacement, 1200, CancellationToken.None);
        Assert.Equal(replacement.Id, (await b.FindLiveAsync(unique, "USDT_TRON", CancellationToken.None))!.Id);
        var retired = (await b.GetAsync(row.Id, CancellationToken.None))!;
        Assert.Equal(1200, retired.RetiredAt);
        Assert.Equal("refund_pending", retired.State);
        Assert.Equal(fresh.RefundAddress, retired.RefundAddress);
        Assert.Contains((await b.DueAsync(2000, 200, CancellationToken.None)), r => r.Id == retired.Id);
        var neverCommitted = new OpenReceiveSwap { PaymentHash = new string('a', 64), InvoiceId = unique, Provider = "fixture", ProviderOrderId = unique + "-never", PayInAsset = "USDT_TRON", State = "awaiting_deposit" };
        await Assert.ThrowsAsync<SwapConcurrencyException>(() => a.ReplaceAsync(stale, neverCommitted, 1300, CancellationToken.None));
        Assert.Null(await b.FindProviderOrderAsync("fixture", unique + "-never", CancellationToken.None));
        Assert.Equal(replacement.Id, (await a.FindLiveAsync(unique, "USDT_TRON", CancellationToken.None))!.Id);
        var offered = (await a.GetAsync(replacement.Id, CancellationToken.None))!;
        var duplicateOrder = new OpenReceiveSwap { PaymentHash = new string('a', 64), InvoiceId = unique, Provider = "fixture", ProviderOrderId = unique, PayInAsset = "USDT_TRON", State = "awaiting_deposit" };
        // Fail the insert AFTER retirement was written inside the transaction. The
        // previously exposed address remains offered when the transaction rolls back.
        await Assert.ThrowsAsync<DbUpdateException>(() => a.ReplaceAsync(offered, duplicateOrder, 1400, CancellationToken.None));
        Assert.Null(await b.GetAsync(duplicateOrder.Id, CancellationToken.None));
        Assert.Null((await b.GetAsync(replacement.Id, CancellationToken.None))!.RetiredAt);
        Assert.Equal(replacement.Id, (await b.FindLiveAsync(unique, "USDT_TRON", CancellationToken.None))!.Id);

        var invoices = new EfInvoiceStore(factory);
        var hash = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        await invoices.InsertAsync(new OpenReceiveInvoice { PaymentHash = hash, Bolt11 = "test-only", AmountMsats = 1000, CreatedAt = 100, ExpiresAt = 700, ConnectionId = "public-wallet:public-client" }, CancellationToken.None);
        var restored = (await invoices.FindAsync(hash, CancellationToken.None))!;
        restored.HostInvoiceId = unique;
        restored.HostUpdateRequired = true;
        restored.NextRecoveryAt = 1500;
        await invoices.UpdateAsync(restored, CancellationToken.None);
        Assert.Contains(await invoices.RecoveryDueAsync(1500, 200, CancellationToken.None), r => r.PaymentHash == hash && r.HostUpdateRequired);
        await using var clean = factory.CreateContext();
        await clean.Swaps.Where(s => s.InvoiceId == unique).ExecuteDeleteAsync();
        await clean.Invoices.Where(i => i.PaymentHash == hash).ExecuteDeleteAsync();
    }
}
