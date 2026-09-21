using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using Microsoft.Extensions.Logging.Abstractions;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Nwc;

public sealed class PaymentSafetyTests
{
    [Fact]
    public void Mixed_case_memo_inputs_share_identity_and_settlement_never_regresses()
    {
        var hash = new string('a', 64);
        var memo = new ScanMemo((_, _) => Task.FromResult(new ListTransactionsResult { Transactions = Array.Empty<NwcTransaction>() }), () => 1800000000, NullLogger.Instance);
        memo.Record(new NwcTransaction { PaymentHash = hash, Invoice = "known-invoice", AmountMsats = 1000, TransactionState = "pending" });
        memo.Watch(hash.ToUpperInvariant());
        memo.Record(new NwcTransaction { PaymentHash = hash.ToUpperInvariant(), TransactionState = "settled", SettledAt = 1800000000 });
        memo.Record(new NwcTransaction { PaymentHash = hash, TransactionState = "pending" });
        var row = memo.Lookup(hash.ToUpperInvariant())!;
        Assert.Equal(hash, row.PaymentHash);
        Assert.Equal("known-invoice", row.Invoice);
        Assert.Equal(1000, row.AmountMsats);
        Assert.True(Settlement.IsSettled(row));
        Assert.Single(memo.DrainNewlySettled());
        memo.Record(row with { PaymentHash = hash.ToUpperInvariant() });
        Assert.Empty(memo.DrainNewlySettled());
    }

    [Theory]
    [InlineData("[null]")]
    [InlineData("[1,\"hello\",false]")]
    [InlineData("[[]]")]
    public void All_non_object_rows_fail_the_actual_adapter(string rows) =>
        Assert.Throws<NwcNormalizeException>(() => NwcNormalize.ListTransactions(JsonNode.Parse(rows)));

    [Fact]
    public async Task Short_mixed_pages_advance_by_physical_rows_and_find_later_payment()
    {
        var hash = new string('b', 64);
        var requests = new List<int>();
        Task<ListTransactionsResult> List(ListTransactionsRequest r, CancellationToken ct)
        {
            requests.Add(r.Offset ?? 0);
            var raw = r.Offset == 0 ? "[{}, null, {}, 42, {}]" : "[{\"payment_hash\":\"" + hash.ToUpperInvariant() + "\",\"state\":\"settled\",\"amount\":1000}]";
            return Task.FromResult(NwcNormalize.ListTransactions(JsonNode.Parse(raw)));
        }
        var walk = await WalletScan.WalkAsync(List, 0, 1800000000, true, new HashSet<string> { hash }, 3, CancellationToken.None);
        Assert.Equal(new[] { 0, 5 }, requests);
        Assert.False(walk.Truncated);
        Assert.Equal(hash, walk.ByPaymentHash[hash].PaymentHash);
    }

    [Fact]
    public void Notifications_and_mints_use_canonical_hashes()
    {
        var hash = new string('c', 64);
        var raw = JsonNode.Parse("{\"notification_type\":\"payment_received\",\"notification\":{\"payment_hash\":\"" + hash.ToUpperInvariant() + "\",\"state\":\"settled\"}}");
        var notification = NwcNormalize.Notification(raw);
        Assert.Equal(hash, notification.PaymentHash);
        Assert.Equal(hash, notification.Transaction!.PaymentHash);
        Assert.Equal(hash, NwcNormalize.MakeInvoice(JsonNode.Parse("{\"invoice\":\"invoice\",\"amount\":1000,\"payment_hash\":\"" + hash.ToUpperInvariant() + "\"}")).PaymentHash);
    }
}
