using System.ComponentModel.DataAnnotations;
using BTCPayServer.Lightning;
using BTCPayServer.Payments;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using BTCPayServer.Plugins.OpenReceive.Tests.Fakes;
using Microsoft.Extensions.Logging.Abstractions;
using NBitcoin;
using OpenReceive.TestkitNwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Nwc;

/// <summary>
/// The receive-only NWC Lightning backend, driven the way BTCPay drives it, over the
/// testkit wallet with real NIP-47 events (no relay). Every wallet answer here went
/// through the same sign / encrypt / decrypt path the relay transport uses.
/// </summary>
public sealed class ReceiveOnlyNwcClientTests
{
    private static readonly TimeSpan WaitBound = TimeSpan.FromSeconds(20);

    /// <summary>
    /// One wallet + one client sharing a real-time clock (the poll cadence must advance on
    /// its own; the memo's cadence rules are pinned by ScanMemoTests with a fake clock).
    /// </summary>
    private sealed class Harness : IAsyncDisposable
    {
        public readonly InMemoryWalletBackend Backend;
        public readonly TestkitWalletService Service;
        public readonly TestkitNwcTransport Transport;
        public readonly NwcConnectionState State;
        public readonly ReceiveOnlyNwcClient Client;

        public Harness(TestkitWalletOptions? options = null, string walletNetwork = "regtest", bool allowSpend = false, Network? btcpayNetwork = null)
        {
            Backend = new InMemoryWalletBackend(walletNetwork) { Clock = Now };
            Service = new TestkitWalletService(Backend, options ?? new TestkitWalletOptions(), clock: Now);
            Transport = new TestkitNwcTransport(Service);
            var uri = NwcUri.Parse(Service.NwcUri(new Uri("wss://relay.test")));
            State = new NwcConnectionState(uri, allowSpend, Transport, Now, NullLogger.Instance);
            Client = new ReceiveOnlyNwcClient(State, btcpayNetwork ?? Network.RegTest, NullLogger.Instance);
        }

        public string Secret => Service.ConnectionSecretHex;

        public long Now() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        public Task<LightningInvoice> Mint(long sats = 1_000, string description = "desc", int minutes = 10) =>
            Client.CreateInvoice(LightMoney.Satoshis(sats), description, TimeSpan.FromMinutes(minutes), CancellationToken.None);

        public void AssertNoSecret(string? text)
        {
            if (text is null) return;
            Assert.DoesNotContain(Secret, text, StringComparison.OrdinalIgnoreCase);
        }

        public ValueTask DisposeAsync() => Transport.DisposeAsync();
    }

    private static CancellationToken Bounded() => new CancellationTokenSource(WaitBound).Token;

    // ---- Validate / preflight ----

    [Fact]
    public async Task Validate_succeeds_and_records_the_wallets_capabilities()
    {
        await using var h = new Harness();

        Assert.Equal(ValidationResult.Success, await h.Client.Validate());

        var capabilities = h.State.Capabilities;
        Assert.NotNull(capabilities);
        Assert.Contains("make_invoice", capabilities.Methods);
        Assert.Contains("list_transactions", capabilities.Methods);
        Assert.Contains("get_balance", capabilities.Methods);
        Assert.Equal("nip44_v2", capabilities.Encryption);
        Assert.Contains("payment_received", capabilities.Notifications);
        Assert.Equal("regtest", capabilities.Network);
        Assert.True(capabilities.ReceiveCheckoutReady);
        Assert.False(capabilities.SpendCapabilityAdvertised);
        Assert.Equal(h.Service.WalletPubKeyHex, capabilities.WalletPubkey);
        Assert.Equal(1, h.Transport.Count("get_info"));
        Assert.Equal("nip44_v2", h.Service.LastUsedScheme);
        Assert.True(h.State.LookupInvoiceGranted);

        var report = await h.Client.PreflightAsync(CancellationToken.None);
        Assert.True(report.Ok);
        Assert.Null(report.Warning);
        Assert.NotNull(report.RelayRoundTrip);
    }

    [Fact]
    public async Task Validate_negotiates_nip04_when_that_is_all_the_wallet_speaks()
    {
        await using var h = new Harness(new TestkitWalletOptions { EncryptionSchemes = ["nip04"] });

        Assert.Equal(ValidationResult.Success, await h.Client.Validate());
        Assert.Equal("nip04", h.State.Capabilities!.Encryption);
        Assert.Equal("nip04", h.Service.LastUsedScheme);

        // The whole receive path still works over the fallback scheme.
        var invoice = await h.Mint();
        Assert.Equal(LightningInvoiceStatus.Unpaid, (await h.Client.GetInvoice(invoice.Id)).Status);
    }

    [Fact]
    public async Task Validate_refuses_a_spend_capable_wallet_unless_the_override_is_set()
    {
        await using var refused = new Harness(new TestkitWalletOptions { ExtraGrantedMethods = ["pay_invoice"] });
        var result = await refused.Client.Validate();
        Assert.NotNull(result);
        Assert.NotNull(result.ErrorMessage);
        Assert.Contains("pay_invoice", result.ErrorMessage);
        Assert.Contains(NwcUri.CodeHelpUrl, result.ErrorMessage);
        Assert.Contains(";allow-spend=true", result.ErrorMessage);
        refused.AssertNoSecret(result.ErrorMessage);

        var report = await refused.Client.PreflightAsync(CancellationToken.None);
        Assert.False(report.Ok);
        Assert.Equal("spend_capability_advertised", report.Code);
        Assert.Equal(["pay_invoice"], report.Summary!.SpendMethods);
        refused.AssertNoSecret(report.Message);

        await using var allowed = new Harness(new TestkitWalletOptions { ExtraGrantedMethods = ["pay_invoice"] }, allowSpend: true);
        Assert.Equal(ValidationResult.Success, await allowed.Client.Validate());
        var warned = await allowed.Client.PreflightAsync(CancellationToken.None);
        Assert.True(warned.Ok);
        Assert.Contains("NOT receive-only", warned.Warning);
        allowed.AssertNoSecret(warned.Warning);
        Assert.Equal(0, allowed.Transport.Count("pay_invoice"));
    }

    [Fact]
    public async Task Validate_refuses_a_wallet_on_another_network()
    {
        await using var h = new Harness(walletNetwork: "mainnet", btcpayNetwork: Network.RegTest);

        var result = await h.Client.Validate();
        Assert.NotNull(result);
        Assert.Contains("mainnet", result.ErrorMessage);
        Assert.Contains("regtest", result.ErrorMessage);
        h.AssertNoSecret(result.ErrorMessage);

        var report = await h.Client.PreflightAsync(CancellationToken.None);
        Assert.Equal("network_mismatch", report.Code);
        Assert.Equal("mainnet", report.Summary!.Network);
    }

    [Fact]
    public async Task Validate_refuses_a_wallet_missing_a_required_receive_method()
    {
        await using var h = new Harness(new TestkitWalletOptions { Methods = ["get_info", "make_invoice", "get_balance"] });

        var report = await h.Client.PreflightAsync(CancellationToken.None);
        Assert.False(report.Ok);
        Assert.Equal("missing_required_method", report.Code);
        Assert.Contains("list_transactions", report.Message);
        h.AssertNoSecret(report.Message);
    }

    // ---- CreateInvoice ----

    [Fact]
    public async Task CreateInvoice_mints_through_the_wallet_and_seeds_the_memo()
    {
        await using var h = new Harness();
        var before = h.Now();

        var invoice = await h.Mint(sats: 1_000, description: "desc", minutes: 10);

        Assert.Equal(64, invoice.Id.Length);
        Assert.Matches("^[0-9a-f]{64}$", invoice.Id);
        Assert.Equal(invoice.Id, invoice.PaymentHash);
        Assert.Equal(LightningInvoiceStatus.Unpaid, invoice.Status);
        Assert.False(string.IsNullOrEmpty(invoice.BOLT11));
        Assert.StartsWith("lnbcrt", invoice.BOLT11);
        Assert.Equal(LightMoney.Satoshis(1_000), invoice.Amount);
        Assert.Null(invoice.AmountReceived);
        Assert.Null(invoice.PaidAt);
        Assert.InRange(invoice.ExpiresAt.ToUnixTimeSeconds(), before + 600, h.Now() + 600);

        var row = h.State.Memo.Lookup(invoice.Id);
        Assert.NotNull(row);
        Assert.Equal("pending", row.TransactionState);
        Assert.Equal(1_000_000, row.AmountMsats);
        Assert.Equal(TimeSpan.FromSeconds(2), h.State.Memo.CurrentInterval);
        Assert.Equal(1, h.Transport.Count("make_invoice"));

        var stored = await h.Backend.LookupAsync(invoice.Id, null, CancellationToken.None);
        Assert.NotNull(stored);
        Assert.Equal("desc", stored.Description);
        Assert.Null(stored.DescriptionHash);
        Assert.Equal(1_000_000, stored.AmountMsats);
    }

    [Fact]
    public async Task CreateInvoice_rejects_top_up_and_dust_amounts_before_the_wallet()
    {
        await using var h = new Harness();

        var topUp = await Assert.ThrowsAsync<PaymentMethodUnavailableException>(() =>
            h.Client.CreateInvoice(LightMoney.Zero, "top-up", TimeSpan.FromMinutes(10)));
        Assert.Contains("top-up", topUp.Message);
        h.AssertNoSecret(topUp.Message);

        var dust = await Assert.ThrowsAsync<PaymentMethodUnavailableException>(() =>
            h.Client.CreateInvoice(LightMoney.MilliSatoshis(999), "dust", TimeSpan.FromMinutes(10)));
        Assert.Contains("cannot mint", dust.Message);
        h.AssertNoSecret(dust.Message);

        Assert.Equal(0, h.Transport.Count("make_invoice"));
    }

    [Fact]
    public async Task CreateInvoice_sends_only_the_description_hash_when_asked()
    {
        await using var h = new Harness();
        // BTCPay's params derive DescriptionHash = sha256(Description) when DescriptionHashOnly is set.
        var descriptionHash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("hidden description")));

        var invoice = await h.Client.CreateInvoice(
            new CreateInvoiceParams(LightMoney.Satoshis(2_000), "hidden description", TimeSpan.FromMinutes(10)) { DescriptionHashOnly = true });

        var stored = await h.Backend.LookupAsync(invoice.Id, null, CancellationToken.None);
        Assert.NotNull(stored);
        Assert.Equal(descriptionHash, stored.DescriptionHash);
        Assert.Null(stored.Description);
        Assert.Equal(descriptionHash, h.State.Memo.Lookup(invoice.Id)!.DescriptionHash);
    }

    [Fact]
    public async Task CreateInvoice_refuses_a_wallet_expiry_outside_the_tolerance()
    {
        await using var h = new Harness(new TestkitWalletOptions { ExpirySecondsDelta = 120 });

        var error = await Assert.ThrowsAsync<PaymentMethodUnavailableException>(() => h.Mint());
        Assert.Contains("±60 s", error.Message);
        h.AssertNoSecret(error.Message);
        Assert.Equal(1, h.Transport.Count("make_invoice"));

        // Inside the tolerance the wallet's own expiry is kept.
        await using var close = new Harness(new TestkitWalletOptions { ExpirySecondsDelta = 30 });
        var invoice = await close.Mint(minutes: 10);
        Assert.Equal(close.Now() + 600 + 30, invoice.ExpiresAt.ToUnixTimeSeconds());
    }

    [Fact]
    public async Task CreateInvoice_surfaces_a_wallet_refusal_as_unavailable()
    {
        await using var h = new Harness();
        h.Transport.Intercept = (method, result) => method == "make_invoice" ? throw new NwcRequestException(method, "RESTRICTED", "no more invoices today") : result;

        var error = await Assert.ThrowsAsync<PaymentMethodUnavailableException>(() => h.Mint());
        Assert.Contains("RESTRICTED", error.Message);
        Assert.Contains("no more invoices today", error.Message);
        h.AssertNoSecret(error.Message);
    }

    // ---- GetInvoice ----

    [Fact]
    public async Task GetInvoice_reads_the_memo_with_at_most_one_walk_and_reports_settlement()
    {
        await using var h = new Harness();
        await h.Client.Validate();
        var invoice = await h.Mint(sats: 1_000);

        var pending = await h.Client.GetInvoice(invoice.Id);
        Assert.Equal(LightningInvoiceStatus.Unpaid, pending.Status);
        Assert.Equal(invoice.Id, pending.Id);
        Assert.Equal(invoice.BOLT11, pending.BOLT11);
        Assert.InRange(h.Transport.Count("list_transactions"), 0, 2); // at most one walk (settled + unpaid views)
        Assert.Equal(0, h.Transport.Count("lookup_invoice")); // the memo already knew the row

        await h.Backend.SettleAsync(invoice.Id);
        await h.State.Memo.RefreshAsync(force: true, CancellationToken.None);

        var paid = await h.Client.GetInvoice(new uint256(invoice.Id));
        Assert.Equal(LightningInvoiceStatus.Paid, paid.Status);
        Assert.Equal(LightMoney.Satoshis(1_000), paid.AmountReceived);
        Assert.Equal(LightMoney.Satoshis(1_000), paid.Amount);
        Assert.NotNull(paid.PaidAt);
        Assert.InRange(paid.PaidAt!.Value.ToUnixTimeSeconds(), h.Now() - 5, h.Now() + 1);
        Assert.NotNull(paid.Preimage);
        Assert.Equal(invoice.Id, paid.PaymentHash);
    }

    [Fact]
    public async Task GetInvoice_for_an_unknown_hash_is_Unpaid_never_null_or_Expired()
    {
        await using var withLookup = new Harness();
        await withLookup.Client.Validate(); // lookup_invoice granted: the fast path answers NOT_FOUND
        var unknown = new string('7', 64);

        var invoice = await withLookup.Client.GetInvoice(unknown);
        Assert.NotNull(invoice);
        Assert.Equal(LightningInvoiceStatus.Unpaid, invoice.Status);
        Assert.Equal(unknown, invoice.Id);
        Assert.Equal(unknown, invoice.PaymentHash);
        Assert.Equal(1, withLookup.Transport.Count("lookup_invoice"));

        await using var withoutLookup = new Harness(new TestkitWalletOptions { Methods = ["get_info", "make_invoice", "list_transactions"] });
        await withoutLookup.Client.Validate();
        Assert.False(withoutLookup.State.LookupInvoiceGranted);
        var walked = await withoutLookup.Client.GetInvoice(unknown.ToUpperInvariant());
        Assert.Equal(LightningInvoiceStatus.Unpaid, walked.Status);
        Assert.Equal(unknown, walked.Id);
        Assert.Equal(0, withoutLookup.Transport.Count("lookup_invoice"));
        Assert.Equal(4, withoutLookup.Transport.Count("list_transactions")); // the cadence walk, then one forced walk for the hash
    }

    [Fact]
    public async Task GetInvoice_is_Expired_only_when_the_wallet_says_so()
    {
        await using var h = new Harness();
        var invoice = await h.Mint(minutes: 10);
        await h.State.Memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.Equal(LightningInvoiceStatus.Unpaid, (await h.Client.GetInvoice(invoice.Id)).Status);

        await h.Backend.ExpireAsync(invoice.Id);
        await h.State.Memo.RefreshAsync(force: true, CancellationToken.None);

        var expired = await h.Client.GetInvoice(invoice.Id);
        Assert.Equal(LightningInvoiceStatus.Expired, expired.Status);
        Assert.Null(expired.PaidAt);
    }

    [Fact]
    public async Task ListInvoices_walks_the_window_and_filters_pending()
    {
        await using var h = new Harness();
        var a = await h.Mint(sats: 1_000);
        var b = await h.Mint(sats: 2_000);
        await h.Backend.SettleAsync(b.Id);

        var settled = await h.Client.ListInvoices();
        Assert.Equal([b.Id], settled.Select(i => i.Id));
        Assert.Equal(LightningInvoiceStatus.Paid, settled[0].Status);

        var pending = await h.Client.ListInvoices(new ListInvoicesParams { PendingOnly = true });
        Assert.Equal([a.Id], pending.Select(i => i.Id));
    }

    // ---- Listen: notifications ----

    [Fact]
    public async Task Listen_settles_directly_from_a_full_payment_received_payload()
    {
        await using var h = new Harness();
        await h.Client.Validate();
        var invoice = await h.Mint(sats: 1_000);

        using var listener = await h.Client.Listen(Bounded());
        Assert.IsType<NwcNotificationListener>(listener);
        var walksBefore = h.Transport.Count("list_transactions");
        var lookupsBefore = h.Transport.Count("lookup_invoice");

        var waiting = listener.WaitInvoice(Bounded());
        await h.Backend.SettleAsync(invoice.Id);
        var paid = await waiting.WaitAsync(WaitBound);

        Assert.Equal(LightningInvoiceStatus.Paid, paid.Status);
        Assert.Equal(invoice.Id, paid.Id);
        Assert.Equal(invoice.Id, paid.PaymentHash);
        Assert.Equal(LightMoney.Satoshis(1_000), paid.AmountReceived);
        Assert.NotNull(paid.PaidAt);
        Assert.NotNull(paid.Preimage);
        // Authenticated wallet data with finality and an amount: no redundant wallet scan.
        Assert.Equal(walksBefore, h.Transport.Count("list_transactions"));
        Assert.Equal(lookupsBefore, h.Transport.Count("lookup_invoice"));
        Assert.True(Settlement.IsSettled(h.State.Memo.Lookup(invoice.Id)!));
    }

    [Fact]
    public async Task Listen_refreshes_the_hash_first_when_the_notification_carries_no_amount()
    {
        await using var h = new Harness();
        await h.Client.Validate();
        var invoice = await h.Mint(sats: 1_000);
        h.Transport.Intercept = (kind, envelope) =>
        {
            if (kind == "notification") envelope["notification"]!.AsObject().Remove("amount");
            return envelope;
        };

        using var listener = await h.Client.Listen(Bounded());
        var waiting = listener.WaitInvoice(Bounded());
        await h.Backend.SettleAsync(invoice.Id);
        var paid = await waiting.WaitAsync(WaitBound);

        Assert.Equal(LightningInvoiceStatus.Paid, paid.Status);
        Assert.Equal(invoice.Id, paid.Id);
        Assert.Equal(LightMoney.Satoshis(1_000), paid.AmountReceived); // recovered through lookup_invoice
        Assert.Equal(1, h.Transport.Count("lookup_invoice"));
    }

    [Fact]
    public async Task Listen_only_refreshes_the_memo_when_the_notification_lacks_finality()
    {
        await using var h = new Harness();
        await h.Client.Validate();
        var invoice = await h.Mint(sats: 1_000);
        await h.Client.GetInvoice(invoice.Id); // the cadence walk is done; every later walk is one the listener forced
        var walksBefore = h.Transport.Count("list_transactions");
        h.Transport.Intercept = (kind, envelope) =>
        {
            if (kind != "notification") return envelope;
            var payload = envelope["notification"]!.AsObject();
            payload.Remove("settled_at");
            payload.Remove("state");
            return envelope;
        };

        using var listener = await h.Client.Listen(Bounded());
        var waiting = listener.WaitInvoice(Bounded());
        await Task.Delay(200);
        Assert.False(waiting.IsCompleted);

        await h.Backend.SettleAsync(invoice.Id);
        var paid = await waiting.WaitAsync(WaitBound);

        Assert.Equal(LightningInvoiceStatus.Paid, paid.Status);
        Assert.Equal(invoice.Id, paid.Id);
        Assert.Equal(LightMoney.Satoshis(1_000), paid.AmountReceived);
        // Not settled directly: one bounded memo refresh (settled + unpaid views) found the settlement.
        Assert.Equal(walksBefore + 2, h.Transport.Count("list_transactions"));
        Assert.Equal(0, h.Transport.Count("lookup_invoice"));
    }

    [Fact]
    public async Task Listen_ignores_pushes_for_other_notification_types_and_dropped_pushes()
    {
        await using var h = new Harness();
        await h.Client.Validate();
        var invoice = await h.Mint(sats: 1_000);
        var walksBefore = h.Transport.Count("list_transactions");
        h.Transport.Intercept = (kind, envelope) =>
        {
            if (kind == "notification") envelope["notification_type"] = "payment_sent";
            return envelope;
        };

        var listener = await h.Client.Listen(Bounded());
        var waiting = listener.WaitInvoice(Bounded());
        await h.Backend.SettleAsync(invoice.Id);
        await Task.Delay(300);

        Assert.False(waiting.IsCompleted);
        Assert.Equal(walksBefore, h.Transport.Count("list_transactions"));
        // Disposing the listener ends the wait (disposed exactly once: Dispose is not idempotent).
        listener.Dispose();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
    }

    // ---- Listen: polling ----

    [Fact]
    public async Task Listen_polls_the_memo_when_the_wallet_has_no_notifications()
    {
        await using var h = new Harness(new TestkitWalletOptions { Notifications = false });
        await h.Client.Validate();
        Assert.Empty(h.State.Capabilities!.Notifications);
        var invoice = await h.Mint(sats: 1_000); // minted first: the poll cadence is 2 s while it is fresh

        using var listener = await h.Client.Listen(Bounded());
        Assert.IsType<NwcPollListener>(listener);

        // Let the first tick's walk (settled + unpaid views) see the invoice still pending
        // before settling, so the settlement is found by the 2 s cadence, not the first walk.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (h.Transport.Count("list_transactions") < 2 && DateTime.UtcNow < deadline) await Task.Delay(20);
        Assert.Equal(2, h.Transport.Count("list_transactions"));

        await h.Backend.SettleAsync(invoice.Id);
        var paid = await listener.WaitInvoice(new CancellationTokenSource(TimeSpan.FromSeconds(15)).Token);

        Assert.Equal(LightningInvoiceStatus.Paid, paid.Status);
        Assert.Equal(invoice.Id, paid.Id);
        Assert.Equal(LightMoney.Satoshis(1_000), paid.AmountReceived);
        Assert.NotNull(paid.PaidAt);
        Assert.True(h.Transport.Count("list_transactions") >= 4); // the first tick plus the one that saw the settlement
        Assert.Equal(0, h.Transport.Count("lookup_invoice"));
    }

    // ---- Receive-only surface ----

    [Fact]
    public async Task Every_send_side_member_throws_and_never_reaches_the_wallet()
    {
        await using var h = new Harness(new TestkitWalletOptions { ExtraGrantedMethods = ["pay_invoice", "pay_keysend"] }, allowSpend: true);
        await h.Client.Validate();
        var client = h.Client;

        var calls = new Func<Task>[]
        {
            () => client.Pay((PayInvoiceParams)null!),
            () => client.Pay("lnbcrt1dummy", (PayInvoiceParams)null!),
            () => client.Pay("lnbcrt1dummy"),
            () => client.OpenChannel(null!),
            () => client.GetDepositAddress(),
            () => client.ConnectTo(null!),
            () => client.CancelInvoice("0000"),
            () => client.ListChannels(),
            () => client.GetPayment(new string('0', 64)),
            () => client.ListPayments(),
            () => client.ListPayments(null!),
        };
        foreach (var call in calls)
        {
            var error = await Assert.ThrowsAsync<NotSupportedException>(call);
            Assert.Equal(ReceiveOnlyNwcClient.ReceiveOnlyMessage, error.Message);
        }

        Assert.False(h.Transport.RequestCount.ContainsKey("pay_invoice"));
        Assert.False(h.Transport.RequestCount.ContainsKey("pay_keysend"));
        Assert.False(h.Transport.RequestCount.ContainsKey("multi_pay_invoice"));
        Assert.False(h.Transport.RequestCount.ContainsKey("multi_pay_keysend"));
        Assert.Equal(["get_info"], h.Transport.RequestCount.Keys);
    }

    [Fact]
    public async Task GetInfo_is_not_supported_and_GetBalance_works_when_granted()
    {
        await using var h = new Harness();
        await h.Client.Validate();
        await Assert.ThrowsAsync<NotSupportedException>(() => h.Client.GetInfo());

        var invoice = await h.Mint(sats: 1_500);
        await h.Backend.SettleAsync(invoice.Id);
        var balance = await h.Client.GetBalance();
        Assert.Equal(LightMoney.Satoshis(1_500), balance.OffchainBalance.Local);
        Assert.Equal(1, h.Transport.Count("get_balance"));

        await using var ungranted = new Harness(new TestkitWalletOptions { Methods = ["get_info", "make_invoice", "list_transactions"] });
        await ungranted.Client.Validate();
        await Assert.ThrowsAsync<NotSupportedException>(() => ungranted.Client.GetBalance());
        Assert.Equal(0, ungranted.Transport.Count("get_balance"));
    }

    // ---- Secret hygiene ----

    [Fact]
    public async Task Nothing_the_client_shows_or_throws_carries_the_connection_secret()
    {
        await using var h = new Harness(new TestkitWalletOptions { ExtraGrantedMethods = ["pay_invoice"], Lud16 = "shop@example.org" });

        Assert.Equal("OpenReceive (receive-only NWC) wss://relay.test shop@example.org", h.Client.DisplayName);
        h.AssertNoSecret(h.Client.DisplayName);
        Assert.Equal(new Uri("wss://relay.test"), h.Client.ServerUri);
        h.AssertNoSecret(h.Client.ServerUri?.ToString());
        h.AssertNoSecret(h.Client.Uri.Redacted);
        Assert.Contains(NwcUri.RedactedSecret, h.Client.Uri.Redacted);

        var report = await h.Client.PreflightAsync(CancellationToken.None);
        Assert.False(report.Ok);
        h.AssertNoSecret(report.Message);
        h.AssertNoSecret(report.Code);

        var validation = await h.Client.Validate();
        h.AssertNoSecret(validation?.ErrorMessage);

        // Only ToString() carries it, by design: it is what BTCPay persists.
        Assert.Contains(h.Secret, h.Client.ToString());
    }
}
