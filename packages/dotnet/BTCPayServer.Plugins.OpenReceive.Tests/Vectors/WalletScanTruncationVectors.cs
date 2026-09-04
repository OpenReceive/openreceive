using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>
/// spec/test-vectors/wallet-scan-truncation.json against <see cref="WalletScan.ReconcileAsync"/>.
/// The scripted wallet serves <c>pages</c> (or <c>unpaid_pages</c> for unpaid requests) by
/// offset / page_limit; an <c>ignores_offset</c> wallet serves page 0 for every offset. Filler
/// rows expand to settled incoming rows whose hash is 56 'f' + 8-digit page*10000+index.
/// </summary>
public sealed class WalletScanTruncationVectors
{
    private const string File = "wallet-scan-truncation.json";

    public static TheoryData<string> Names => VectorJson.Names(File);

    [Fact]
    public void PageLimitIsTheKernelPageLimit()
    {
        Assert.Equal(OpenReceiveTables.TransactionPageLimit, TestVectors.Load(File)["page_limit"]!.GetValue<int>());
    }

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Case(string name)
    {
        var c = VectorJson.Case(File, name);
        var wallet = c["wallet"]!.AsObject();
        var pages = Expand(wallet["pages"] as JsonArray);
        var unpaidPages = Expand(wallet["unpaid_pages"] as JsonArray);
        var ignoresOffset = wallet["ignores_offset"]?.GetValue<bool>() ?? false;
        var clock = c["clock"]!.GetValue<long>();
        var maxPages = c["max_pages"]?.GetValue<int>();

        var attempts = c["attempts"]!.AsArray()
            .Select(a => new ReconcileAttempt(a!["payment_hash"]!.GetValue<string>(), a["created_at"]!.GetValue<long>()))
            .ToArray();

        Task<ListTransactionsResult> List(ListTransactionsRequest request, CancellationToken ct)
        {
            var source = request.Unpaid == true ? unpaidPages : pages;
            var index = ignoresOffset ? 0 : (request.Offset ?? 0) / OpenReceiveTables.TransactionPageLimit;
            var rows = index < source.Count ? source[index] : Array.Empty<NwcTransaction>();
            return Task.FromResult(new ListTransactionsResult { Transactions = rows });
        }

        var results = await WalletScan.ReconcileAsync(List, attempts, () => clock, maxPages);

        var expected = c["expected"]!;
        var expectedResults = expected["results"]!.AsArray()
            .Select(r => (r!["payment_hash"]!.GetValue<string>(), r["status"]!.GetValue<string>()))
            .ToArray();
        Assert.Equal(expectedResults, results.Select(r => (r.PaymentHash, r.Status)).ToArray());

        var reported = results.Select(r => r.PaymentHash).ToHashSet();
        var omitted = attempts.Select(a => a.PaymentHash).Where(h => !reported.Contains(h)).ToArray();
        Assert.Equal(VectorJson.Strings(expected["omitted"]), omitted);
    }

    private static List<IReadOnlyList<NwcTransaction>> Expand(JsonArray? pages)
    {
        var expanded = new List<IReadOnlyList<NwcTransaction>>();
        if (pages is null) return expanded;
        for (var pageNumber = 0; pageNumber < pages.Count; pageNumber += 1)
        {
            var page = pages[pageNumber]!.AsObject();
            var rows = new List<NwcTransaction>();
            foreach (var row in page["rows"] as JsonArray ?? new JsonArray()) rows.Add(NwcNormalize.Transaction(row));
            var filler = page["filler_rows"]?.GetValue<int>() ?? 0;
            for (var index = 0; index < filler; index += 1)
            {
                rows.Add(new NwcTransaction
                {
                    Type = "incoming",
                    PaymentHash = new string('f', 56) + (pageNumber * 10000 + index).ToString("D8"),
                    AmountMsats = 1000,
                    TransactionState = "settled",
                    CreatedAt = 1000,
                    SettledAt = 1001,
                });
            }
            expanded.Add(rows);
        }
        return expanded;
    }
}
