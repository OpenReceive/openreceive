using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Settings;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using BTCPayServer.Plugins.OpenReceive.Tests.Fakes;
using Microsoft.Extensions.Logging.Abstractions;
using OpenReceive.FakeLsc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

/// <summary>
/// The swap rail's service over the fake Lightning Swap Connect provider (signed HTTP
/// in-process), an in-memory store and a controllable clock shared by every party.
/// </summary>
public sealed class SwapServiceTests
{
    private const string LscPrimary = "lightning+swapconnect://fake-lsc.test/?key=test-key&secret=test-secret";
    private const string ProviderName = "fake-lsc-test";
    // The same fake provider account behind Lightning Swap's host, and behind FixedFloat's:
    // only the guard differs, and only FixedFloat's own host is counted locally.
    private const string LscLightningSwap = "lightning+swapconnect://lightning-swap.com/?key=test-key&secret=test-secret";
    private const string LightningSwapProviderName = "lightning-swap-com";
    private const string LscFixedFloat = "lightning+swapconnect://ff.io/?key=test-key&secret=test-secret";
    private const string FixedFloatProviderName = "ff-io";
    private const string StoreId = "store-1";
    private const string InvoiceId = "inv-1";
    private const long InvoiceAmountMsats = 100_000_000; // 0.001 BTC
    private const string ValidTronAddress = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    private const string BadChecksumTronAddress = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg";
    private static readonly string PaymentHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(InvoiceId)));
    private static readonly string Bolt11 = $"lnbcrt{InvoiceAmountMsats * 10}p1{PaymentHash}testkit";

    private sealed class SettingsStub : ISwapSettingsSource
    {
        public OpenReceiveStoreSettings Settings { get; } = new() { SwapsEnabled = true, LscPrimary = LscPrimary };
        public Dictionary<string, OpenReceiveStoreSettings> Overrides { get; } = new();
        public Task<OpenReceiveStoreSettings> GetAsync(string storeId) => Task.FromResult(Overrides.GetValueOrDefault(storeId) ?? Settings);
    }

    private sealed class InvoiceStub : ISwapInvoiceSource
    {
        public Dictionary<string, SwapInvoiceContext> Invoices { get; } = new(StringComparer.Ordinal);
        public Task<SwapInvoiceContext?> LoadAsync(string invoiceId, CancellationToken cancellationToken) =>
            Task.FromResult(Invoices.GetValueOrDefault(invoiceId));
    }

    private sealed class AccountRoutingHandler(FakeLscProviderCore primary, FakeLscProviderCore secondary, Func<string?> retryAfter) : HttpMessageHandler
    {
        private readonly HttpMessageInvoker _primary = new(new FakeLscHttpMessageHandler(primary));
        private readonly HttpMessageInvoker _secondary = new(new FakeLscHttpMessageHandler(secondary));
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = await (request.RequestUri!.Host == "second-lsc.test" ? _secondary : _primary).SendAsync(request, cancellationToken);
            // The fake's 429 names no wait; a test that needs one adds the header a real provider sends.
            if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests && retryAfter() is { } wait)
            {
                response.Headers.TryAddWithoutValidation("Retry-After", wait);
            }
            return response;
        }
    }

    private sealed class Harness
    {
        public long Now = 1_800_000_000;
        public readonly List<string> Paid = new();
        public readonly List<string> Log = new();
        /// <summary>The <c>Retry-After</c> a scripted 429 carries; null for the fake's bare 429.</summary>
        public string? RetryAfter;
        public readonly RecordingLogger<SwapService> Logger = new();
        public readonly FakeLscProviderCore Core;
        public readonly FakeLscProviderCore SecondCore;
        public readonly InMemorySwapStore Store = new();
        public readonly SettingsStub Settings = new();
        public readonly InvoiceStub Invoices = new();
        public readonly SwapProviderPool Pool;
        public readonly SwapService Service;

        public Harness()
        {
            Core = new FakeLscProviderCore(new FakeLscOptions
            {
                Clock = () => Now,
                Log = line => { lock (Log) Log.Add(line); },
                Payer = (bolt11, _) =>
                {
                    lock (Paid) Paid.Add(bolt11);
                    return Task.CompletedTask;
                },
            });
            SecondCore = new FakeLscProviderCore(new FakeLscOptions { Clock = () => Now });
            var factory = new InMemoryHttpClientFactory(new AccountRoutingHandler(Core, SecondCore, () => RetryAfter));
            Pool = new SwapProviderPool(factory, Settings, NullLogger<SwapProviderPool>.Instance, () => Now);
            Service = new SwapService(Store, Pool, Settings, Invoices, Logger, () => Now);
            Invoices.Invoices[InvoiceId] = Invoice();
        }

        public SwapInvoiceContext Invoice(
            bool payable = true,
            bool topUp = false,
            string? bolt11 = "",
            string? paymentHash = null,
            bool partial = false,
            long? expiresAt = null,
            bool openReceive = true) =>
            new(InvoiceId, StoreId, "New", payable, topUp, bolt11 == "" ? Bolt11 : bolt11, paymentHash ?? PaymentHash, InvoiceAmountMsats, partial,
                expiresAt ?? Now + 3600, openReceive);

        public Task<SwapAvailability> Availability(SwapInvoiceContext? invoice = null) =>
            Service.AvailabilityAsync(invoice ?? Invoices.Invoices[InvoiceId], CancellationToken.None);

        public Task<SwapCheckoutModel> Create(string asset = "USDT_TRON") =>
            Service.CreateAsync(InvoiceId, asset, CancellationToken.None);

        /// <summary>A swap for another invoice of the same store (one live order per invoice and asset).</summary>
        public Task<SwapCheckoutModel> CreateFor(string invoiceId, string asset = "USDT_TRON")
        {
            Invoices.Invoices[invoiceId] = Invoice() with { InvoiceId = invoiceId };
            return Service.CreateAsync(invoiceId, asset, CancellationToken.None);
        }

        public int ProviderCalls(string path) =>
            Log.Count(line => line.StartsWith($"POST /api/v2/{path}", StringComparison.Ordinal));

        public async Task<OpenReceiveSwap> Row(string swapId) =>
            (await Store.GetAsync(swapId, CancellationToken.None))!;

        public async Task<OpenReceiveSwap> Poll(string swapId, long advanceSeconds = 6)
        {
            Now += advanceSeconds;
            await Service.PollOnceAsync(CancellationToken.None);
            return await Row(swapId);
        }
    }

    // ---- Availability ----

    [Fact]
    public async Task Availability_offers_every_asset_when_the_provider_is_healthy()
    {
        var h = new Harness();

        var availability = await h.Availability();

        Assert.True(availability.Offered);
        Assert.Null(availability.Reason);
        Assert.Equal(7, availability.Assets.Count);
        Assert.All(availability.Assets, offer =>
        {
            Assert.True(offer.Available, $"{offer.PayInAsset}: {offer.Reason}");
            Assert.Null(offer.Reason);
        });
        Assert.Equal(["SOL_SOL", "USDT_TRON", "USDT_SOL", "USDC_SOL", "ETH_ETH", "USDT_ETH", "USDC_ETH"], availability.Assets.Select(a => a.PayInAsset));
        Assert.Equal(Bolt11, availability.Bolt11);
        Assert.Equal(PaymentHash, availability.PaymentHash);
        Assert.Equal(InvoiceAmountMsats, availability.InvoiceAmountMsats);
        Assert.Equal(FixedFloatCompatibleProvider.DefaultDepositWindowSeconds + FixedFloatCompatibleProvider.DefaultSettlementSlaSeconds + FixedFloatCompatibleProvider.DefaultInvoiceExpiryMarginSeconds,
            availability.MinimumInvoiceSeconds);
    }

    [Fact]
    public async Task An_invoice_below_the_provider_minimum_says_the_minimum_in_the_invoices_currency()
    {
        var h = new Harness();
        // 1 sat priced at 0.01 USD: below every provider minimum; the rate the limit is expressed at is price / msats.
        h.Invoices.Invoices[InvoiceId] = h.Invoice() with { InvoiceAmountMsats = 1_000, InvoicePrice = 0.01m, InvoiceCurrency = "USD" };

        var availability = await h.Availability();

        Assert.True(availability.Offered);
        Assert.All(availability.Assets, offer =>
        {
            Assert.False(offer.Available);
            Assert.Equal("amount_too_small", offer.Reason);
            Assert.Matches(@"^at least \d+\.\d{2} USD$", offer.Limit!.ToString());
            Assert.Equal("USD", offer.Limit.Unit);
        });
        // Without a price the bound falls back to the provider's own figure in the pay asset.
        h.Invoices.Invoices[InvoiceId] = h.Invoice() with { InvoiceAmountMsats = 1_000 };
        var bare = await h.Availability();
        Assert.All(bare.Assets, offer => Assert.Equal("at least", offer.Limit!.Word));
        Assert.Contains(bare.Assets, offer => offer.Limit!.Unit == offer.AssetLabel);
    }

    [Fact]
    public async Task Availability_is_not_offered_with_a_reason_for_each_gate()
    {
        var h = new Harness();

        Assert.Equal("lightning_node_not_openreceive", (await h.Availability(h.Invoice(openReceive: false))).Reason);

        h.Settings.Settings.SwapsEnabled = false;
        Assert.Equal("swaps_disabled", (await h.Availability()).Reason);
        h.Settings.Settings.SwapsEnabled = true;

        h.Settings.Settings.LscPrimary = null;
        Assert.Equal("provider_unconfigured", (await h.Availability()).Reason);
        h.Settings.Settings.LscPrimary = LscPrimary;

        Assert.Equal("invoice_not_payable", (await h.Availability(h.Invoice(payable: false))).Reason);
        Assert.Equal("top_up_invoice", (await h.Availability(h.Invoice(topUp: true))).Reason);
        Assert.Equal("no_lightning_prompt", (await h.Availability(h.Invoice(bolt11: null))).Reason);
        Assert.Equal("partial_payment", (await h.Availability(h.Invoice(partial: true))).Reason);

        var provider = (await h.Pool.ProvidersAsync(StoreId, CancellationToken.None)).Single();
        var tooSoon = await h.Availability(h.Invoice(expiresAt: h.Now + provider.InvoiceExpirySeconds - 1));
        Assert.False(tooSoon.Offered);
        Assert.Equal("invoice_expires_too_soon", tooSoon.Reason);
        Assert.Equal(provider.InvoiceExpirySeconds, tooSoon.MinimumInvoiceSeconds);
        Assert.Empty(tooSoon.Assets);

        Assert.True((await h.Availability(h.Invoice(expiresAt: h.Now + provider.InvoiceExpirySeconds))).Offered);
        Assert.Empty(h.Core.Orders); // availability never creates provider orders
    }

    // ---- Create ----

    [Fact]
    public async Task Create_mints_one_provider_order_and_reserves_it_for_the_invoice()
    {
        var h = new Harness();

        var model = await h.Create("USDT_TRON");

        Assert.Equal("awaiting_deposit", model.State);
        Assert.Equal("awaiting_deposit", model.Phase);
        Assert.False(model.Terminal);
        Assert.Equal(InvoiceId, model.InvoiceId);
        Assert.Equal(ProviderName, model.Provider);
        Assert.Equal("USDT_TRON", model.PayInAsset);
        Assert.Equal("USDT", model.AssetLabel);
        Assert.Equal("Tron", model.NetworkLabel);
        Assert.Matches("^T[1-9A-HJ-NP-Za-km-z]{33}$", model.DepositAddress);
        Assert.Equal(model.DepositAddress, model.DepositUri); // token rail: address only
        Assert.Equal("101", model.DepositAmount); // 0.001 BTC at 100,000 USD/BTC + 1%
        Assert.Equal(h.Now + 900, model.ProviderExpiresAt);
        Assert.Equal(900, model.ExpiresInSeconds);
        Assert.Equal(h.Now + 3600, model.InvoiceExpiresAt);
        Assert.Equal("New", model.InvoiceStatus);
        Assert.False(model.WalletSettled);
        Assert.Equal("asset_only", model.DepositRisk);
        Assert.NotNull(model.Fee);
        Assert.Equal("USD", model.Fee.Currency);
        // USDT is USD-pegged: the fee line is in the token, never "x USD sent".
        Assert.NotNull(model.FeeText);
        Assert.StartsWith("Includes the provider's fee of ", model.FeeText);
        Assert.Contains("101 USDT sent", model.FeeText);
        Assert.DoesNotContain("USD sent", model.FeeText);
        Assert.Equal(26, model.SwapId.Length);

        var order = Assert.Single(h.Core.Orders);
        Assert.Equal(Bolt11, order.Bolt11);
        Assert.Equal(order.Id, model.ProviderOrderId);
        var row = await h.Row(model.SwapId);
        Assert.Equal(order.Token, row.ProviderToken);
        Assert.Equal(PaymentHash, row.PaymentHash);
        Assert.Equal(InvoiceAmountMsats, row.InvoiceAmountMsats);
        Assert.Equal(h.Now, row.CreatedAt);
        Assert.Equal(h.Now, row.LastPolledAt);

        // A second create for the same asset re-serves the live order.
        var again = await h.Create("USDT_TRON");
        Assert.Equal(model.SwapId, again.SwapId);
        Assert.Single(h.Core.Orders);
    }

    [Fact]
    public async Task Concurrent_creates_for_one_asset_share_one_provider_order()
    {
        var h = new Harness();

        var models = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => h.Create("USDT_TRON")));

        Assert.Equal(models[0].SwapId, models[1].SwapId);
        Assert.Single(h.Core.Orders);
        Assert.Single(h.Store.Rows);
    }

    [Fact]
    public async Task Create_puts_the_amount_in_the_uri_for_a_native_rail()
    {
        var h = new Harness();

        var sol = await h.Create("SOL_SOL");

        Assert.StartsWith("solana:", sol.DepositUri);
        Assert.Contains($"?amount={sol.DepositAmount}", sol.DepositUri);
        Assert.Equal("pinned", sol.DepositRisk);
        Assert.Equal("Send exactly this amount", sol.NetworkWarningTitle);

        var eth = await h.Create("ETH_ETH");
        Assert.StartsWith("ethereum:0x", eth.DepositUri);
        Assert.Contains("?value=", eth.DepositUri);
        Assert.Equal("chain_ambiguous", eth.DepositRisk);
    }

    [Fact]
    public async Task Create_rejects_an_unknown_asset_and_an_unknown_invoice()
    {
        var h = new Harness();

        var unknownAsset = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("DOGE_DOGE"));
        Assert.Equal(400, unknownAsset.Status);
        Assert.Equal("invalid_pay_in_asset", unknownAsset.Code);

        var unknownInvoice = await Assert.ThrowsAsync<SwapRequestException>(() => h.Service.CreateAsync("nope", "USDT_TRON", CancellationToken.None));
        Assert.Equal(404, unknownInvoice.Status);
        Assert.Equal("invoice_not_found", unknownInvoice.Code);
        Assert.Empty(h.Core.Orders);
    }

    [Fact]
    public async Task Create_refuses_when_swaps_are_not_offered_for_the_invoice()
    {
        var h = new Harness();
        h.Invoices.Invoices[InvoiceId] = h.Invoice(expiresAt: h.Now + 600);

        var error = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create());
        Assert.Equal(409, error.Status);
        Assert.Equal("invoice_expires_too_soon", error.Code);
        Assert.Contains("expires in 10 minutes", error.Message);
        Assert.Contains("at least 30", error.Message);
    }

    [Fact]
    public async Task Create_near_the_provider_deadline_supersedes_the_old_order()
    {
        var h = new Harness();
        var first = await h.Create("USDT_TRON");

        // Still comfortably inside the deadline: re-served.
        h.Now += 900 - SwapService.ReserveWindowSeconds - 1;
        Assert.Equal(first.SwapId, (await h.Create("USDT_TRON")).SwapId);

        // Inside the reserve window: not worth showing again — close it and mint afresh.
        h.Now += 2;
        var second = await h.Create("USDT_TRON");

        Assert.NotEqual(first.SwapId, second.SwapId);
        Assert.Equal("awaiting_deposit", second.State);
        Assert.Equal(h.Now + 900, second.ProviderExpiresAt);
        Assert.Equal(2, h.Core.Orders.Count);
        var old = await h.Row(first.SwapId);
        Assert.Equal("awaiting_deposit", old.State);
        Assert.Null(old.StateReason);
        Assert.False(old.IsTerminal);
        Assert.Equal(h.Now, old.RetiredAt);
        Assert.Equal(second.SwapId, old.ReplacementId);
        var live = await h.Store.FindLiveAsync(InvoiceId, "USDT_TRON", CancellationToken.None);
        Assert.Equal(second.SwapId, live!.Id);
    }

    [Fact]
    public async Task Unobserved_provider_refund_prevents_replacement_and_recovers_when_creation_disabled()
    {
        var h = new Harness();
        var first = await h.Create();
        h.Core.ForceRefundRequired(first.ProviderOrderId);
        h.Now += 842;
        h.Invoices.Invoices[InvoiceId] = h.Invoice(partial: true, expiresAt: h.Now + 60);
        var recovered = await h.Create();
        Assert.Equal(first.SwapId, recovered.SwapId);
        Assert.Equal("refund_required", recovered.State);
        Assert.Single(h.Core.Orders);
        h.Settings.Settings.SwapsEnabled = false;
        var page = await h.Service.RecoveryAsync(InvoiceId, null, 50, CancellationToken.None);
        Assert.Single(page!.Attempts);
        var refund = await h.Service.RefundAsync(InvoiceId, first.SwapId, ValidTronAddress, CancellationToken.None);
        Assert.Equal("refund_pending", refund.State);
        Assert.False(refund.InstructionsAvailable);
    }

    [Fact]
    public async Task Deposit_after_retirement_remains_polled_and_refundable()
    {
        var h = new Harness();
        var first = await h.Create();
        h.Now += 842;
        var replacement = await h.Create();
        h.Core.ForceRefundRequired(first.ProviderOrderId, "late_deposit");
        await h.Poll(first.SwapId);
        var retired = await h.Service.GetAsync(InvoiceId, first.SwapId, CancellationToken.None);
        Assert.True(retired!.Retired);
        Assert.False(retired.InstructionsAvailable);
        Assert.Equal("refund_required", retired.State);
        Assert.Equal(replacement.SwapId, retired.ReplacementId);
        Assert.Equal("refund_pending", (await h.Service.RefundAsync(InvoiceId, first.SwapId, ValidTronAddress, CancellationToken.None)).State);
        Assert.Equal(2, (await h.Service.RecoveryAsync(InvoiceId, null, 50, CancellationToken.None))!.Attempts.Count);
    }

    [Fact]
    public async Task Real_weight_budget_does_not_starve_denied_cohort_after_restart()
    {
        var h = new Harness();
        // FixedFloat's host, the one the guard counts for: 50 status calls a window, so 100
        // due orders take two windows. Creating each minute avoids consuming the later status
        // budget. All 100 provider orders are real signed fake-provider HTTP calls; retirement
        // keeps half recoverable.
        h.Settings.Settings.LscPrimary = LscFixedFloat;
        for (var n = 0; n < 100; n++)
        {
            h.Now += 60;
            var id = "backlog-" + n;
            h.Invoices.Invoices[id] = h.Invoice(expiresAt: h.Now + 3600) with { InvoiceId = id };
            var created = await h.Service.CreateAsync(id, "USDT_TRON", CancellationToken.None);
            if (n % 2 == 0)
            {
                var row = await h.Row(created.SwapId);
                row.RetiredAt = h.Now;
                await h.Store.UpdateAsync(row, CancellationToken.None);
            }
        }
        h.Core.ForceRefundRequired("USDT_TRON");
        h.Now += 60;
        h.Log.Clear();
        await h.Service.PollOnceAsync(CancellationToken.None);
        Assert.Equal(50, h.Store.Rows.Count(r => r.State == "refund_required"));
        h.Now += 5;
        await h.Service.PollOnceAsync(CancellationToken.None);
        var denied = h.Store.Rows.Where(r => r.State != "refund_required").ToArray();
        Assert.Equal(50, denied.Length);
        Assert.All(denied, r => Assert.True(r.LastObservedAt < h.Now - 5));
        Assert.All(denied, r => Assert.True(r.NextPollAt > h.Now));
        // New service/worker, same durable scheduling. The process budget resets on restart
        // by design, but denied rows retain priority at their eligibility boundary.
        var restarted = new SwapService(h.Store, h.Pool, h.Settings, h.Invoices, NullLogger<SwapService>.Instance, () => h.Now);
        for (var elapsed = 10; elapsed <= 180; elapsed += 5)
        {
            h.Now += 5;
            if (elapsed == 120) h.Core.RateLimitNext(1);
            await restarted.PollOnceAsync(CancellationToken.None);
            if (elapsed == 60)
            {
                Assert.All(h.Store.Rows, r => Assert.Equal("refund_required", r.State));
                Assert.Equal(100, h.Log.Count(line => line.StartsWith("POST /api/v2/order", StringComparison.Ordinal)));
            }
        }
        Assert.All(h.Store.Rows, r => Assert.Equal("refund_required", r.State));
        // 100 observations, the one call the 429 answered, and one window's 50 after the
        // stand-off it started.
        Assert.Equal(151, h.Log.Count(line => line.StartsWith("POST /api/v2/order", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task A_denied_provider_connection_does_not_block_another_account_or_new_arrivals()
    {
        var h = new Harness();
        // The first account is on FixedFloat's host, the one the guard counts for (50 status
        // calls a window); the second account's provider is never counted locally.
        h.Settings.Settings.LscPrimary = LscFixedFloat;
        h.Settings.Overrides["second-store"] = new OpenReceiveStoreSettings
        {
            SwapsEnabled = true, LscPrimary = LscPrimary.Replace("fake-lsc.test", "second-lsc.test"),
        };
        for (var n = 0; n < 120; n++)
        {
            h.Now += 60;
            var id = "account-backlog-" + n;
            h.Invoices.Invoices[id] = h.Invoice(expiresAt: h.Now + 3600) with { InvoiceId = id };
            await h.Service.CreateAsync(id, "USDT_TRON", CancellationToken.None);
        }
        h.Core.ForceRefundRequired("USDT_TRON");
        h.Now += 60;
        await h.Service.PollOnceAsync(CancellationToken.None); // first account consumes its window
        var arrivals = new List<string>();
        for (var n = 0; n < 2; n++)
        {
            h.Now += 5;
            var id = "new-account-arrival-" + n;
            h.Invoices.Invoices[id] = h.Invoice(expiresAt: h.Now + 3600) with { InvoiceId = id, StoreId = "second-store" };
            var created = await h.Service.CreateAsync(id, "USDT_TRON", CancellationToken.None);
            arrivals.Add(created.SwapId);
            h.SecondCore.ForceRefundRequired(created.ProviderOrderId);
            await h.Service.PollOnceAsync(CancellationToken.None);
        }
        h.Now += 5;
        await h.Service.PollOnceAsync(CancellationToken.None);
        Assert.All(h.Store.Rows.Where(r => arrivals.Contains(r.Id)), r => Assert.Equal("refund_required", r.State));
        Assert.Contains(h.Store.Rows, r => r.StoreId == StoreId && r.State == "awaiting_deposit");
        for (var n = 2; n < 6; n++)
        {
            // The first account gets one window's 50 status calls each minute meanwhile.
            h.Now += n % 2 == 0 ? 60 : 5;
            var id = "new-account-arrival-" + n;
            h.Invoices.Invoices[id] = h.Invoice(expiresAt: h.Now + 3600) with { InvoiceId = id, StoreId = "second-store" };
            var created = await h.Service.CreateAsync(id, "USDT_TRON", CancellationToken.None);
            h.SecondCore.ForceRefundRequired(created.ProviderOrderId);
            await h.Service.PollOnceAsync(CancellationToken.None);
        }
        h.Now += 5;
        await h.Service.PollOnceAsync(CancellationToken.None);
        Assert.All(h.Store.Rows, r => Assert.Equal("refund_required", r.State));
        Assert.Empty(h.Paid); // provider observations never credit host invoices
    }

    // ---- Lifecycle ----

    [Fact]
    public async Task Scripted_lifecycle_advances_one_state_per_poll_and_pays_the_invoice_once()
    {
        var h = new Harness();
        h.Core.Script("USDT_TRON", ["confirming", "exchanging", "completed"]);
        var model = await h.Create("USDT_TRON");
        Assert.Equal("awaiting_deposit", model.State);

        // Not due yet: the cadence is 5 s while the deposit can still change the outcome.
        Assert.Equal(0, await h.Service.PollOnceAsync(CancellationToken.None));

        var confirming = await h.Poll(model.SwapId);
        Assert.Equal("confirming", confirming.State);
        Assert.Equal(h.Now, confirming.StateChangedAt);
        Assert.Equal(h.Now, confirming.LastPolledAt);
        Assert.NotNull(confirming.DepositTxId);
        Assert.Equal("101", confirming.DepositReceivedAmount);

        Assert.Equal("exchanging", (await h.Poll(model.SwapId)).State);

        var completed = await h.Poll(model.SwapId);
        Assert.Equal("completed", completed.State);
        Assert.NotNull(completed.PayoutTxId);
        Assert.False(completed.IsTerminal); // provider completion is not wallet settlement
        Assert.False(completed.Attention);

        await h.Core.WaitForPayerAsync();
        Assert.Equal([Bolt11], h.Paid);
        Assert.Null(h.Core.LastPayerError);

        var view = await h.Service.GetAsync(InvoiceId, model.SwapId, CancellationToken.None);
        Assert.Equal("settling", view!.Phase);
        Assert.False(view.WalletSettled);
    }

    [Fact]
    public async Task Completed_without_wallet_settlement_becomes_attention_after_the_window()
    {
        var h = new Harness();
        h.Core.Script("USDT_TRON", ["completed"]);
        var model = await h.Create("USDT_TRON");
        var completed = await h.Poll(model.SwapId);
        Assert.Equal("completed", completed.State);
        var completedAt = completed.StateChangedAt;

        // Just inside the window: still completed.
        var inside = await h.Poll(model.SwapId, SwapService.CompletedWithoutSettlementSeconds - 3);
        Assert.Equal("completed", inside.State);
        Assert.Equal(completedAt, inside.StateChangedAt);
        Assert.Equal(h.Now, inside.LastPolledAt);

        var attention = await h.Poll(model.SwapId, 6);
        Assert.Equal("attention", attention.State);
        Assert.True(attention.Attention);
        Assert.Equal("provider_completed_without_wallet_settlement", attention.AttentionReason);
        Assert.True(attention.IsTerminal);
        Assert.Equal(1, await h.Service.CountAttentionAsync(StoreId, CancellationToken.None));
        Assert.Equal("attention", (await h.Service.GetAsync(InvoiceId, model.SwapId, CancellationToken.None))!.Phase);
    }

    [Fact]
    public async Task Lightning_payment_stamps_the_row_and_slows_the_poll_cadence()
    {
        var h = new Harness();
        h.Core.Script("USDT_TRON", ["paying_invoice", "completed"]);
        var model = await h.Create("USDT_TRON");
        Assert.Equal("paying_invoice", (await h.Poll(model.SwapId)).State);

        await h.Service.OnLightningPaymentAsync(InvoiceId, PaymentHash.ToUpperInvariant(), CancellationToken.None);

        var row = await h.Row(model.SwapId);
        Assert.Equal(h.Now, row.WalletSettledAt);
        Assert.Equal(30, SwapService.PollIntervalSeconds(row));
        Assert.Equal("paying_invoice", row.State);
        Assert.True((await h.Service.GetAsync(InvoiceId, model.SwapId, CancellationToken.None))!.WalletSettled);

        // Cadence: 6 s later the row is not due; 30 s later it is, and the provider reports completed.
        h.Now += 6;
        Assert.Equal(0, await h.Service.PollOnceAsync(CancellationToken.None));
        Assert.Equal("completed", (await h.Poll(model.SwapId, SwapService.SettledPollSeconds)).State);

        // Completed with the Lightning side settled: that swap is done. The row stays as the
        // record, leaves the poll set for good, and never turns into attention.
        Assert.Equal("completed", (await h.Poll(model.SwapId, SwapService.CompletedWithoutSettlementSeconds + 10)).State);
        Assert.False((await h.Row(model.SwapId)).Attention);
        Assert.False(SwapService.IsPolled(await h.Row(model.SwapId)));
        Assert.Empty(await h.Store.DueAsync(h.Now + 3600, SwapService.PollBatchSize, CancellationToken.None));

        // A payment for another hash never stamps this row.
        var other = new Harness();
        var otherModel = await other.Create("SOL_SOL");
        await other.Service.OnLightningPaymentAsync(InvoiceId, new string('0', 64), CancellationToken.None);
        Assert.Null((await other.Row(otherModel.SwapId)).WalletSettledAt);
    }

    // ---- Refunds ----

    [Fact]
    public async Task Refund_flow_validates_the_address_then_records_the_emergency_once()
    {
        var h = new Harness();
        h.Core.ForceRefundRequired("USDT_TRON", "underpaid");
        var model = await h.Create("USDT_TRON");
        Assert.Equal("awaiting_deposit", model.State);

        var required = await h.Poll(model.SwapId);
        Assert.Equal("refund_required", required.State);
        Assert.Equal("underpaid", required.RefundReason);
        Assert.Null(required.RefundAddress);
        Assert.Equal("refund", (await h.Service.GetAsync(InvoiceId, model.SwapId, CancellationToken.None))!.Phase);

        var badChecksum = await Assert.ThrowsAsync<SwapRequestException>(() =>
            h.Service.RefundAsync(InvoiceId, model.SwapId, BadChecksumTronAddress, CancellationToken.None));
        Assert.Equal(400, badChecksum.Status);
        Assert.Equal("invalid_refund_address", badChecksum.Code);
        Assert.Contains("checksum", badChecksum.Message);

        var wrongShape = await Assert.ThrowsAsync<SwapRequestException>(() =>
            h.Service.RefundAsync(InvoiceId, model.SwapId, "0x1111111111111111111111111111111111111111", CancellationToken.None));
        Assert.Equal("invalid_refund_address", wrongShape.Code);
        Assert.Equal("refund_required", (await h.Row(model.SwapId)).State);

        var pending = await h.Service.RefundAsync(InvoiceId, model.SwapId, $"  {ValidTronAddress} ", CancellationToken.None);
        Assert.Equal("refund_pending", pending.State);
        Assert.Equal(ValidTronAddress, pending.RefundAddress);
        Assert.Equal("underpaid", pending.RefundReason);
        Assert.Equal("refund", pending.Phase);
        Assert.Equal("refund_pending", Assert.Single(h.Core.Orders).State);
        Assert.Equal(ValidTronAddress, (await h.Row(model.SwapId)).RefundAddress);

        var again = await Assert.ThrowsAsync<SwapRequestException>(() =>
            h.Service.RefundAsync(InvoiceId, model.SwapId, ValidTronAddress, CancellationToken.None));
        Assert.Equal(409, again.Status);
        Assert.Equal("refund_already_requested", again.Code);

        // The provider eventually pays the refund out; the row turns terminal.
        h.Core.Script(model.ProviderOrderId, ["refunded"]);
        var refunded = await h.Poll(model.SwapId);
        Assert.Equal("refunded", refunded.State);
        Assert.NotNull(refunded.RefundTxId);
        Assert.True(refunded.IsTerminal);
    }

    [Fact]
    public async Task Refund_is_refused_while_the_provider_does_not_require_one()
    {
        var h = new Harness();
        var model = await h.Create("USDT_TRON");

        var error = await Assert.ThrowsAsync<SwapRequestException>(() =>
            h.Service.RefundAsync(InvoiceId, model.SwapId, ValidTronAddress, CancellationToken.None));

        Assert.Equal(409, error.Status);
        Assert.Equal("refund_not_required", error.Code);
        Assert.Contains("awaiting_deposit", error.Message);
        Assert.Equal("awaiting_deposit", Assert.Single(h.Core.Orders).State);
        Assert.Null((await h.Row(model.SwapId)).RefundAddress);

        var wrongInvoice = await Assert.ThrowsAsync<SwapRequestException>(() =>
            h.Service.RefundAsync("other-invoice", model.SwapId, ValidTronAddress, CancellationToken.None));
        Assert.Equal(404, wrongInvoice.Status);
        Assert.Equal("swap_not_found", wrongInvoice.Code);
    }

    // ---- Expiry, remint, reads ----

    [Fact]
    public async Task An_order_with_no_deposit_expires_after_the_provider_deadline_plus_grace()
    {
        var h = new Harness();
        var model = await h.Create("USDT_TRON");

        // At the deadline plus grace exactly: still awaiting (the rule is strictly after).
        var atGrace = await h.Poll(model.SwapId, 900 + SwapService.NoDepositGraceSeconds);
        Assert.Equal("awaiting_deposit", atGrace.State);

        var expired = await h.Poll(model.SwapId, 6);
        Assert.Equal("expired", expired.State);
        Assert.Equal("no_deposit_before_provider_expiry", expired.StateReason);
        Assert.True(expired.IsTerminal);
        Assert.Equal(h.Now, expired.StateChangedAt);
        Assert.Equal(0, (await h.Service.GetAsync(InvoiceId, model.SwapId, CancellationToken.None))!.ExpiresInSeconds);

        // Terminal rows are no longer polled.
        Assert.Equal(0, await h.Service.PollOnceAsync(CancellationToken.None));
    }

    [Fact]
    public async Task A_remint_marks_live_rows_and_stops_offering_swaps()
    {
        var h = new Harness();
        var usdt = await h.Create("USDT_TRON");
        var sol = await h.Create("SOL_SOL");
        Assert.True((await h.Availability()).Offered);

        await h.Service.OnLightningRemintAsync(InvoiceId, CancellationToken.None);

        foreach (var swapId in new[] { usdt.SwapId, sol.SwapId })
        {
            var row = await h.Row(swapId);
            Assert.Equal(SwapService.PluginReasonReminted, row.PluginReason);
            Assert.Equal("awaiting_deposit", row.State); // the old orders keep polling
            Assert.Null(row.AttentionReason);
        }
        var availability = await h.Availability();
        Assert.False(availability.Offered);
        Assert.Equal("invoice_reminted", availability.Reason);
        var refused = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_ETH"));
        Assert.Equal("invoice_reminted", refused.Code);
        Assert.Equal(SwapService.PluginReasonReminted, (await h.Service.GetAsync(InvoiceId, usdt.SwapId, CancellationToken.None))!.PluginReason);
    }

    [Fact]
    public async Task Get_is_scoped_to_the_invoice_and_the_model_never_carries_the_provider_token()
    {
        var h = new Harness();
        var model = await h.Create("USDT_TRON");

        Assert.Null(await h.Service.GetAsync("other-invoice", model.SwapId, CancellationToken.None));
        Assert.Null(await h.Service.GetAsync(InvoiceId, "no-such-swap", CancellationToken.None));
        var read = await h.Service.GetAsync(InvoiceId, model.SwapId, CancellationToken.None);
        Assert.NotNull(read);
        Assert.Equal(model.SwapId, read.SwapId);

        var token = Assert.Single(h.Core.Orders).Token;
        Assert.Equal(32, token.Length);
        foreach (var snapshot in new[] { model, read })
        {
            var json = JsonSerializer.Serialize(snapshot);
            Assert.DoesNotContain("token", json, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(token, json);
            Assert.Contains("\"swap_id\":", json);
            Assert.Contains("\"deposit_uri\":", json);
        }

        var rows = await h.Service.ForInvoiceAsync(InvoiceId, CancellationToken.None);
        Assert.Equal(token, Assert.Single(rows).ProviderToken); // server-side only
        Assert.Single(await h.Service.ForStoreAsync(StoreId, 10, CancellationToken.None));
    }

    // ---- Provider down ----

    [Fact]
    public async Task Create_preserves_the_old_order_when_refresh_fails_before_replacement()
    {
        var h = new Harness();
        h.Invoices.Invoices[InvoiceId] = h.Invoice(expiresAt: h.Now + 7200);
        var first = await h.Create("USDT_TRON");
        var original = await h.Row(first.SwapId);
        h.Now += 900;
        h.Core.RateLimitNext(1);

        var error = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON"));

        Assert.Equal(503, error.Status);
        Assert.Equal("provider_refresh_failed", error.Code);
        var old = await h.Row(first.SwapId);
        Assert.Equal(original.ProviderToken, old.ProviderToken);
        Assert.Equal(original.PaymentHash, old.PaymentHash);
        Assert.Equal("awaiting_deposit", old.State);
        Assert.Single(h.Core.Orders);
        Assert.Equal(first.SwapId, (await h.Store.FindLiveAsync(InvoiceId, "USDT_TRON", CancellationToken.None))!.Id);
    }

    [Fact]
    public async Task Create_keeps_the_old_order_when_the_provider_refuses_the_replacement()
    {
        var h = new Harness();
        h.Invoices.Invoices[InvoiceId] = h.Invoice(expiresAt: h.Now + 7200);
        var first = await h.Create("USDT_TRON");
        h.Now += 900 - SwapService.ReserveWindowSeconds + 1; // inside the reserve window: a replacement is due
        h.Core.ForceCreateError("Fake LSC create failed: pair paused.");

        var error = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON"));

        Assert.Equal(502, error.Status);
        Assert.Equal("provider_refused", error.Code);
        Assert.DoesNotContain("pair paused", error.Message); // the provider's words stay in the log line
        // The provider order comes first, so a refusal leaves the old order live for its last minute.
        var old = await h.Row(first.SwapId);
        Assert.Equal("awaiting_deposit", old.State);
        Assert.Single(h.Core.Orders);
        Assert.Equal(first.SwapId, (await h.Store.FindLiveAsync(InvoiceId, "USDT_TRON", CancellationToken.None))!.Id);
    }

    [Fact]
    public async Task Create_keeps_an_order_the_provider_is_processing_however_close_to_the_deadline()
    {
        var h = new Harness();
        h.Invoices.Invoices[InvoiceId] = h.Invoice(expiresAt: h.Now + 7200);
        h.Core.Script("USDT_TRON", ["confirming"]);
        var first = await h.Create("USDT_TRON");
        Assert.Equal("confirming", (await h.Poll(first.SwapId)).State);
        h.Now += 900; // past the provider's deadline, but the deposit is in and the provider is on it

        var again = await h.Create("USDT_TRON");

        Assert.Equal(first.SwapId, again.SwapId);
        Assert.Equal("confirming", again.State);
        Assert.Single(h.Core.Orders); // no fresh order minted underneath a deposit in flight
    }

    // ---- Concurrency: the row version ----

    [Fact]
    public async Task A_stale_copy_of_a_row_cannot_overwrite_a_refund_that_landed_first()
    {
        var h = new Harness();
        h.Core.ForceRefundRequired("USDT_TRON", "underpaid");
        var model = await h.Create("USDT_TRON");
        Assert.Equal("refund_required", (await h.Poll(model.SwapId)).State);

        // A poller pass loaded its copy before the payer's refund landed.
        var stale = await h.Row(model.SwapId);
        var pending = await h.Service.RefundAsync(InvoiceId, model.SwapId, ValidTronAddress, CancellationToken.None);
        Assert.Equal("refund_pending", pending.State);

        stale.LastPolledAt = h.Now;
        await Assert.ThrowsAsync<SwapConcurrencyException>(() => h.Store.UpdateAsync(stale, CancellationToken.None));

        var row = await h.Row(model.SwapId);
        Assert.Equal(ValidTronAddress, row.RefundAddress);
        Assert.Equal("refund_pending", row.State);
        Assert.Equal(stale.Version + 1, row.Version);

        // The next poll re-reads the row: the refund survives, and a second request is still refused.
        var polled = await h.Poll(model.SwapId);
        Assert.Equal(ValidTronAddress, polled.RefundAddress);
        Assert.Equal("refund_pending", polled.State);
        var again = await Assert.ThrowsAsync<SwapRequestException>(() => h.Service.RefundAsync(InvoiceId, model.SwapId, ValidTronAddress, CancellationToken.None));
        Assert.Equal("refund_already_requested", again.Code);
    }

    [Fact]
    public async Task Every_write_carries_the_version_it_loaded()
    {
        var h = new Harness();
        var model = await h.Create("USDT_TRON");
        var v1 = await h.Row(model.SwapId);
        Assert.Equal(1u, v1.Version);

        await h.Poll(model.SwapId);
        var v2 = await h.Row(model.SwapId);
        Assert.True(v2.Version > v1.Version);

        await h.Service.OnLightningRemintAsync(InvoiceId, CancellationToken.None);
        var v3 = await h.Row(model.SwapId);
        Assert.True(v3.Version > v2.Version);
        Assert.Equal(SwapService.PluginReasonReminted, v3.PluginReason);

        // The copy from before the re-mint is stale; the remint annotation cannot be undone by it.
        v2.PluginReason = null;
        await Assert.ThrowsAsync<SwapConcurrencyException>(() => h.Store.UpdateAsync(v2, CancellationToken.None));
        Assert.Equal(SwapService.PluginReasonReminted, (await h.Row(model.SwapId)).PluginReason);
    }

    [Fact]
    public async Task Provider_rate_limit_during_create_is_a_503_and_backs_the_provider_off()
    {
        var h = new Harness();
        Assert.True((await h.Availability()).Offered); // catalog and rates are cached now
        h.Core.RateLimitNext(1);
        int Creates() => h.Log.Count(line => line.StartsWith("POST /api/v2/create", StringComparison.Ordinal));

        var error = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON"));

        Assert.Contains(error.Status, new[] { 502, 503 });
        Assert.Contains(error.Code, new[] { "provider_rate_limited", "provider_unreachable" });
        Assert.Equal(503, error.Status);
        Assert.Equal("provider_rate_limited", error.Code);
        Assert.Empty(h.Core.Orders);
        Assert.Empty(h.Store.Rows);
        Assert.Equal(1, Creates());

        // The provider is marked down: with no backup, it stays the only choice.
        Assert.Same((await h.Pool.ProvidersAsync(StoreId, CancellationToken.None))[0], await h.Pool.SelectForCreateAsync(StoreId, CancellationToken.None));

        // The 429 put the provider's weight budget into backoff: the next create is refused
        // locally (same 503, no HTTP) even though the fake would now answer.
        var backedOff = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON"));
        Assert.Equal(503, backedOff.Status);
        Assert.Equal("provider_rate_limited", backedOff.Code);
        Assert.Equal(1, Creates());

        // Availability keeps serving the cached catalog meanwhile (the public rates feed is unbudgeted).
        h.Now += TransientSwapCache.RatesRefreshSeconds + 1;
        Assert.All((await h.Availability()).Assets, offer => Assert.True(offer.Available));

        // Once the backoff lapses the order goes through.
        h.Now += SwapProviderWeightBudget.BackoffSeconds;
        var model = await h.Create("USDT_TRON");
        Assert.Equal("awaiting_deposit", model.State);
        Assert.Single(h.Core.Orders);
        Assert.Equal(2, Creates());
    }

    [Fact]
    public async Task Provider_rate_limit_on_a_cold_catalog_makes_the_assets_unavailable_instead_of_throwing()
    {
        var h = new Harness();
        h.Core.RateLimitNext(5);

        var availability = await h.Availability();
        Assert.True(availability.Offered);
        Assert.All(availability.Assets, offer =>
        {
            Assert.False(offer.Available);
            Assert.Contains(offer.Reason, new[] { "provider_rate_limited", "provider_unreachable" });
        });

        // Create runs the same availability gate first, so it refuses the asset rather than reaching /create.
        var error = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON"));
        Assert.Equal(409, error.Status);
        Assert.Contains(error.Code, new[] { "provider_rate_limited", "provider_unreachable" });
        Assert.Empty(h.Core.Orders);
    }

    // ---- The request guard: counts only on FixedFloat, asked before any work, named in the log ----

    [Fact]
    public async Task A_create_the_guard_would_refuse_is_refused_before_any_work_for_the_order()
    {
        var h = new Harness();
        Assert.True((await h.Availability()).Offered); // catalog and rates are cached now
        var provider = (await h.Pool.ProvidersAsync(StoreId, CancellationToken.None)).Single();
        var guard = new SwapProviderWeightBudget(provider.Name, () => h.Now, SwapProviderLimits.FixedFloat);
        var recording = new RecordingWeightBudget(guard);
        provider.AttachWeightBudget(recording);
        for (var n = 0; n < 4; n++) guard.Reserve("create"); // a busy minute on FixedFloat: the window is spent
        var calls = h.Log.Count;

        for (var attempt = 0; attempt < 2; attempt++)
        {
            var error = await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON"));
            Assert.Equal(503, error.Status);
            Assert.Equal("provider_rate_limited", error.Code);
            Assert.Equal("The swap provider is rate limited. Try again in a minute.", error.Message);
        }

        // The guard was asked, and that was all: nothing reserved, nothing sent, nothing stored.
        Assert.Equal(new[] { "create", "create" }, recording.Checked);
        Assert.Empty(recording.Reserved);
        Assert.Equal(calls, h.Log.Count);
        Assert.Empty(h.Core.Orders);
        Assert.Empty(h.Store.Rows);
        // Two refusals, one log line: repeated tries must not bury the log.
        var line = Assert.Single(h.Logger.Event("swap.provider.rate_limited"));
        Assert.Contains($"provider={ProviderName} path=create reason=exhausted used=200 gate=200 ", line);
        Assert.Contains("this process reached the per-minute limit it keeps for FixedFloat", line);

        // The next minute has room again, and the create itself reserves.
        h.Now += SwapProviderWeightBudget.WindowSeconds;
        Assert.Equal("awaiting_deposit", (await h.Create("USDT_TRON")).State);
        Assert.Contains("create", recording.Reserved);
    }

    [Fact]
    public async Task On_any_host_but_FixedFloats_the_guard_never_refuses_a_swap_locally()
    {
        var h = new Harness();
        Assert.Same(SwapProviderLimits.ProviderOnly, (await h.Pool.ProvidersAsync(StoreId, CancellationToken.None)).Single().Limits);
        h.Settings.Settings.LscPrimary = LscLightningSwap;
        var provider = (await h.Pool.ProvidersAsync(StoreId, CancellationToken.None)).Single();
        Assert.Equal(LightningSwapProviderName, provider.Name);
        Assert.Same(SwapProviderLimits.ProviderOnly, provider.Limits);

        // The old local count stopped at three (FixedFloat's numbers) or thirty (Lightning Swap's).
        var created = new List<SwapCheckoutModel>();
        for (var n = 0; n < 40; n++) created.Add(await h.CreateFor("busy-" + n));

        Assert.Equal(40, h.Core.Orders.Count);
        Assert.Equal(40, h.ProviderCalls("create"));
        Assert.Empty(h.Logger.Event("swap.provider.rate_limited"));
        h.Core.ForceRefundRequired(created[0].ProviderOrderId);
        Assert.Equal("refund_required", (await h.Poll(created[0].SwapId)).State);
    }

    [Fact]
    public async Task On_FixedFloats_host_status_polls_leave_room_for_new_swaps()
    {
        var h = new Harness();
        h.Settings.Settings.LscPrimary = LscFixedFloat;
        var provider = (await h.Pool.ProvidersAsync(StoreId, CancellationToken.None)).Single();
        Assert.Equal(FixedFloatProviderName, provider.Name);
        Assert.Same(SwapProviderLimits.FixedFloat, provider.Limits);

        // Two payers start a swap, and their screens poll status: the old 150 create gate
        // refused the third payer at 102 weight.
        var first = await h.CreateFor("payer-1");
        var second = await h.CreateFor("payer-2");
        await h.Poll(first.SwapId);
        await h.Poll(second.SwapId);
        Assert.Equal("awaiting_deposit", (await h.CreateFor("payer-3")).State);
        Assert.Equal(3, h.ProviderCalls("create"));
        Assert.Empty(h.Logger.Event("swap.provider.rate_limited"));
    }

    [Fact]
    public async Task A_Lightning_Swap_429_on_a_create_stands_creates_off_for_the_wait_it_names_while_status_calls_go_on()
    {
        var h = new Harness();
        h.Settings.Settings.LscPrimary = LscLightningSwap;
        var existing = await h.Create("USDT_TRON");
        h.RetryAfter = "7";
        h.Core.RateLimitNext(1);
        var refusedAt = h.Now;

        var refused = await Assert.ThrowsAsync<SwapRequestException>(() => h.CreateFor("next"));

        Assert.Equal(503, refused.Status);
        Assert.Equal("provider_rate_limited", refused.Code);
        Assert.Equal(2, h.ProviderCalls("create"));

        // Creates stand off; the swap that exists is still polled.
        h.Core.ForceRefundRequired(existing.ProviderOrderId);
        Assert.Equal("refund_required", (await h.Poll(existing.SwapId, advanceSeconds: 6)).State);
        var standingOff = await Assert.ThrowsAsync<SwapRequestException>(() => h.CreateFor("next"));
        Assert.Equal("provider_rate_limited", standingOff.Code);
        Assert.Equal(2, h.ProviderCalls("create")); // refused locally: nothing was sent

        // The seven seconds the provider named are over; a bare 429 would have meant a minute.
        h.Now += 1;
        Assert.Equal("awaiting_deposit", (await h.CreateFor("next")).State);
        Assert.Equal(3, h.ProviderCalls("create"));

        // One line for the provider's 429, one for the stand-off this process kept.
        var lines = h.Logger.Event("swap.provider.rate_limited");
        Assert.Equal(2, lines.Count);
        Assert.StartsWith($"swap.provider.rate_limited provider={LightningSwapProviderName} path=create (the provider answered 429", lines[0]);
        Assert.Contains($"provider={LightningSwapProviderName} path=create reason=backoff ", lines[1]);
        Assert.Contains($" backoff_until={refusedAt + 7} ", lines[1]);
    }

    [Fact]
    public async Task Rows_refused_during_a_stand_off_are_polled_again_when_it_ends()
    {
        var h = new Harness();
        await h.Create("USDT_TRON");
        await h.CreateFor("other");
        h.Core.ForceRefundRequired("USDT_TRON");
        h.Now += 6;
        h.RetryAfter = "90"; // the provider's own wait, longer than the minute a bare 429 means
        h.Core.RateLimitNext(1);
        var refusedAt = h.Now;

        await h.Service.PollOnceAsync(CancellationToken.None); // one row meets the 429, the other the stand-off

        Assert.All(h.Store.Rows, row => Assert.Equal("awaiting_deposit", row.State));
        Assert.Equal(1, h.ProviderCalls("order"));
        // The row refused locally comes back when the stand-off ends, not a window later.
        Assert.Equal(new long?[] { refusedAt + 60, refusedAt + 90 }, h.Store.Rows.Select(row => row.NextPollAt).Order());

        h.Now = refusedAt + 60;
        await h.Service.PollOnceAsync(CancellationToken.None); // still standing off: nothing is sent
        Assert.Equal(1, h.ProviderCalls("order"));
        Assert.All(h.Store.Rows, row => Assert.Equal(refusedAt + 90, row.NextPollAt));

        h.Now = refusedAt + 90;
        await h.Service.PollOnceAsync(CancellationToken.None);
        Assert.All(h.Store.Rows, row => Assert.Equal("refund_required", row.State));
        Assert.Equal(3, h.ProviderCalls("order"));
    }

    [Fact]
    public async Task A_refusal_for_rate_is_logged_once_a_minute_per_cause()
    {
        var h = new Harness();
        h.Settings.Settings.LscPrimary = LscFixedFloat;
        Assert.True((await h.Availability()).Offered); // catalog and rates are cached now
        h.RetryAfter = "600";
        h.Core.RateLimitNext(1);
        var refusedAt = h.Now;

        await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON")); // the provider's 429
        for (var n = 0; n < 3; n++)
        {
            h.Now += 10;
            await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON")); // this process standing off
        }
        Assert.Equal(1, h.ProviderCalls("create"));
        var lines = h.Logger.Event("swap.provider.rate_limited");
        Assert.Equal(2, lines.Count);
        Assert.StartsWith($"swap.provider.rate_limited provider={FixedFloatProviderName} path=create (the provider answered 429", lines[0]);
        // FixedFloat's sizes honor a wait longer than their minute.
        Assert.Contains($"provider={FixedFloatProviderName} path=create reason=backoff used=0 gate=200 ", lines[1]);
        Assert.Contains($" backoff_until={refusedAt + 600} ", lines[1]);
        Assert.Contains("standing off after the provider's 429", lines[1]);

        // A minute later the same cause is named again.
        h.Now += SwapService.RateLimitLogIntervalSeconds;
        await Assert.ThrowsAsync<SwapRequestException>(() => h.Create("USDT_TRON"));
        Assert.Equal(3, h.Logger.Event("swap.provider.rate_limited").Count);
        Assert.All(h.Logger.Entries.Where(entry => entry.Line.StartsWith("swap.provider.rate_limited", StringComparison.Ordinal)),
            entry => Assert.Equal(Microsoft.Extensions.Logging.LogLevel.Warning, entry.Level));
    }
}
