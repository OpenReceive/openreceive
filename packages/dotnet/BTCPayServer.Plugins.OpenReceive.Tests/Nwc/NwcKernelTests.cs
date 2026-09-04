using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Nwc;

/// <summary>The kernel rules the shared vectors do not reach: exception normalization, list-shape failures, notifications, preflight order, the uncapped walk.</summary>
public sealed class NwcKernelTests
{
    private static readonly string Hash = new('d', 64);

    [Fact]
    public void ListTransactionsRefusesAnUnrecognizedNonEmptyShape()
    {
        var error = Assert.Throws<NwcNormalizeException>(() => NwcNormalize.ListTransactions(new JsonObject { ["rows"] = new JsonArray() }));
        Assert.Equal("list_transactions returned an unrecognized result shape", error.Message);
    }

    [Fact]
    public void ListTransactionsTreatsEmptyRepliesAsEmptyScans()
    {
        Assert.Empty(NwcNormalize.ListTransactions(null).Transactions);
        Assert.Empty(NwcNormalize.ListTransactions(new JsonObject()).Transactions);
        Assert.Empty(NwcNormalize.ListTransactions(new JsonObject { ["result"] = new JsonObject() }).Transactions);
    }

    [Fact]
    public void ListTransactionsSkipsOneBadRowButFailsWhenEveryRowIsBad()
    {
        var bad = new JsonObject { ["payment_hash"] = "not-hex" };
        var good = new JsonObject { ["payment_hash"] = Hash, ["amount"] = "1500", ["settled_at"] = 12.9 };

        var mixed = NwcNormalize.ListTransactions(new JsonObject { ["transactions"] = new JsonArray(bad, good) });
        Assert.Equal(1, mixed.SkippedRows);
        var row = Assert.Single(mixed.Transactions);
        Assert.Equal(1500, row.AmountMsats);
        Assert.Equal(12, row.SettledAt);

        var error = Assert.Throws<NwcNormalizeException>(() =>
            NwcNormalize.ListTransactions(new JsonObject { ["transactions"] = new JsonArray(bad.DeepClone()) }));
        Assert.Equal("list_transactions returned no usable rows", error.Message);
    }

    [Fact]
    public void TransactionRejectsPresentButUnusableFields()
    {
        Assert.Throws<NwcNormalizeException>(() => NwcNormalize.Transaction(new JsonObject { ["amount"] = 1.5 }));
        Assert.Throws<NwcNormalizeException>(() => NwcNormalize.Transaction(new JsonObject { ["created_at"] = -1 }));
        Assert.Throws<NwcNormalizeException>(() => NwcNormalize.Transaction(new JsonObject { ["created_at"] = "1000" }));
        var absent = NwcNormalize.Transaction(new JsonObject { ["payment_hash"] = "", ["invoice"] = "", ["type"] = "INCOMING" });
        Assert.Null(absent.PaymentHash);
        Assert.Null(absent.Invoice);
        Assert.Equal("incoming", absent.Type);
    }

    [Fact]
    public void NotificationCarriesTheHashEvenWhenThePayloadIsMalformed()
    {
        var ok = NwcNormalize.Notification(new JsonObject
        {
            ["notification_type"] = "payment_received",
            ["notification"] = new JsonObject { ["payment_hash"] = Hash, ["settled_at"] = 5 },
        });
        Assert.Equal("payment_received", ok.Type);
        Assert.Equal(Hash, ok.PaymentHash);
        Assert.True(Settlement.IsSettled(ok.Transaction!));

        var malformed = NwcNormalize.Notification(new JsonObject
        {
            ["notification"] = new JsonObject { ["payment_hash"] = Hash, ["amount"] = "x" },
        });
        Assert.Equal("unknown", malformed.Type);
        Assert.Equal(Hash, malformed.PaymentHash);
        Assert.Null(malformed.Transaction);
    }

    [Fact]
    public void ExceptionsNormalizeThroughKnownTypesThenTheRecordWalk()
    {
        var request = NwcErrors.Normalize(new NwcRequestException("make_invoice", "FORBIDDEN", "Method not permitted"));
        Assert.Equal(("RESTRICTED", "Method not permitted", false), (request.Code, request.Message, request.Retryable));

        var transport = NwcErrors.Normalize(new NwcTransportException("relay closed"));
        Assert.Equal(("WALLET_UNAVAILABLE", "relay closed", true), (transport.Code, transport.Message, transport.Retryable));

        var timeout = NwcErrors.Normalize(new TimeoutException());
        Assert.Equal("TIMEOUT", timeout.Code);
        Assert.True(timeout.Retryable);

        var cancelled = NwcErrors.Normalize(new OperationCanceledException());
        Assert.Equal("TIMEOUT", cancelled.Code);

        var validation = NwcErrors.Normalize(new NwcValidationException("amount_too_small", "amount_msats must be at least 1000"));
        Assert.Equal("INVALID_REQUEST", validation.Code);

        var wrapped = NwcErrors.Normalize(new InvalidOperationException("outer", new NwcRequestException("list_transactions", "RATE_LIMITED", "RATE_LIMITED")));
        Assert.Equal("RATE_LIMITED", wrapped.Code);
        Assert.Equal("outer", wrapped.Message);
        Assert.True(wrapped.Retryable);

        var unknown = NwcErrors.Normalize(new InvalidOperationException("boom"));
        Assert.Equal(("OTHER", "boom", false), (unknown.Code, unknown.Message, unknown.Retryable));
    }

    [Fact]
    public void ErrorMessageFallsBackWhenTheMessageIsJustTheCode()
    {
        var error = NwcErrors.Normalize(new JsonObject { ["code"] = "NOT_FOUND", ["message"] = "not_found", ["retryable"] = true });
        Assert.Equal("NOT_FOUND", error.Code);
        Assert.Equal("NWC wallet service could not find the requested resource.", error.Message);
        Assert.True(error.Retryable);
        Assert.Equal("INSUFFICIENT_BALANCE", NwcErrors.NormalizeCodeText(" insufficient-balance "));
        Assert.Equal("NIP47_NETWORK_ERROR", NwcErrors.NormalizeCodeText("Nip47NetworkError"));
    }

    [Fact]
    public void PreflightChecksMethodsThenEncryptionThenSpend()
    {
        var connection = VectorJson.Connection();
        var missing = WalletPreflight.Evaluate(NwcInfo.Summarize(connection, new JsonObject { ["methods"] = "make_invoice pay_invoice", ["encryption"] = "nip44_v3" }), false);
        Assert.Equal("missing_required_method", missing.Code);
        Assert.Contains("missing list_transactions", missing.Message);

        var encryption = WalletPreflight.Evaluate(NwcInfo.Summarize(connection, new JsonObject { ["methods"] = "make_invoice list_transactions pay_invoice", ["encryption"] = "nip44_v3" }), false);
        Assert.Equal("unsupported_encryption", encryption.Code);

        var spendInfo = NwcInfo.Summarize(connection, new JsonObject { ["methods"] = "make_invoice list_transactions payInvoice", ["notifications"] = "payment_received", ["network"] = "mainnet" });
        Assert.Equal(new[] { "payment_received" }, spendInfo.Notifications);
        Assert.Equal("mainnet", spendInfo.Network);
        var refused = WalletPreflight.Evaluate(spendInfo, false);
        Assert.Equal("spend_capability_advertised", refused.Code);
        Assert.Contains("pay_invoice", refused.Message);
        var overridden = WalletPreflight.Evaluate(spendInfo, true);
        Assert.True(overridden.Ok);
        Assert.Contains("Booting anyway", overridden.Warning);

        var ok = WalletPreflight.Evaluate(NwcInfo.FromServiceInfo(connection, new NwcServiceInfo(new[] { "make_invoice", "list_transactions" }, Array.Empty<string>(), new[] { "nip44_v2" })), false);
        Assert.True(ok.Ok);
        Assert.Null(ok.Warning);
        Assert.Equal("nip44_v2", ok.Summary.Encryption);
    }

    [Fact]
    public void ServiceInfoEncryptionWinsOverGetInfo()
    {
        var summary = NwcInfo.Summarize(VectorJson.Connection(),
            new JsonObject { ["result"] = new JsonObject { ["methods"] = new JsonArray("make_invoice"), ["encryption"] = "nip04" } },
            new JsonObject { ["encryption"] = "nip44_v2 nip04" });
        Assert.Equal("nip44_v2", summary.Encryption);
        Assert.Null(NwcInfo.ChooseEncryptionMode(new[] { "nip44_v3" }));
        Assert.Equal("nip04", NwcInfo.ChooseEncryptionMode(Array.Empty<string>()));
        Assert.Equal("nip44_v2", NwcInfo.ChooseEncryptionMode(new[] { "NIP-44" }));
    }

    [Fact]
    public async Task UncappedWalkRunsUntilTheWalletRunsOut()
    {
        var pages = new[] { 20, 20, 3 };
        var requests = new List<ListTransactionsRequest>();
        Task<ListTransactionsResult> List(ListTransactionsRequest request, CancellationToken ct)
        {
            requests.Add(request);
            var page = (request.Offset ?? 0) / 20;
            var count = page < pages.Length ? pages[page] : 0;
            var rows = Enumerable.Range(0, count)
                .Select(i => new NwcTransaction { PaymentHash = new string('e', 56) + (page * 10000 + i).ToString("D8"), SettledAt = 1 })
                .ToArray();
            return Task.FromResult(new ListTransactionsResult { Transactions = rows });
        }

        var walk = await WalletScan.WalkAsync(List, null, null, false, null, null, CancellationToken.None);
        Assert.False(walk.Truncated);
        Assert.Equal(43, walk.ByPaymentHash.Count);
        Assert.Equal(3, requests.Count);
        Assert.All(requests, r => Assert.Equal("incoming", r.Type));
        Assert.All(requests, r => Assert.Null(r.Unpaid));

        var capped = await WalletScan.WalkAsync(List, 0, 100, true, null, 1, CancellationToken.None);
        Assert.True(capped.Truncated);
        Assert.Equal(20, capped.ByPaymentHash.Count);
    }

    [Fact]
    public async Task ReconcileCollapsesDuplicateHashesAndSkipsOutgoingRows()
    {
        var hash = new string('A', 64);
        Task<ListTransactionsResult> List(ListTransactionsRequest request, CancellationToken ct) =>
            Task.FromResult(new ListTransactionsResult
            {
                Transactions = new[]
                {
                    new NwcTransaction { Type = "outgoing", PaymentHash = hash.ToLowerInvariant(), SettledAt = 50 },
                    new NwcTransaction { Type = "incoming", PaymentHash = hash.ToLowerInvariant(), TransactionState = "pending" },
                },
            });

        var walks = new List<(long From, long Until, bool IncludeUnpaid)>();
        var results = await WalletScan.ReconcileAsync(List,
            new[] { new ReconcileAttempt(hash, 1000), new ReconcileAttempt(hash.ToLowerInvariant(), 1000) },
            () => 2000, onWalk: w => walks.Add(w));

        var check = Assert.Single(results);
        Assert.Equal(hash.ToLowerInvariant(), check.PaymentHash);
        Assert.Equal("pending", check.Status);
        Assert.Null(check.PaidAt);
        Assert.Equal(2000, check.ObservedAt);
        Assert.Equal("Unpaid", WalletScan.LightningStatusFor(check));
        Assert.Single(walks);
        Assert.Equal((940L, 2060L, false), walks[0]);
    }
}
