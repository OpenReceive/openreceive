using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using Microsoft.Extensions.Logging.Abstractions;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Nwc;

/// <summary>
/// The per-connection wallet-history memo: one walk serves every caller, its cadence
/// stretches with the newest minted invoice, and a settled fact is final.
/// </summary>
public sealed class ScanMemoTests
{
    private const long T0 = 1_800_000_000;

    private static string Hash(int n) => n.ToString("x64");

    private static NwcTransaction Pending(string hash, long createdAt = T0) => new()
    {
        Type = "incoming",
        PaymentHash = hash,
        AmountMsats = 1_000,
        TransactionState = "pending",
        CreatedAt = createdAt,
        ExpiresAt = createdAt + 600,
    };

    private static NwcTransaction Settled(string hash, long settledAt = T0) =>
        Pending(hash) with { TransactionState = "settled", SettledAt = settledAt, Preimage = new string('c', 64) };

    /// <summary>A scripted wallet: <c>Rows</c> is what every page request answers; each call is counted and remembered.</summary>
    private sealed class ScriptedWallet
    {
        public List<NwcTransaction> Rows { get; } = new();
        public List<ListTransactionsRequest> Requests { get; } = new();
        public int Calls => Requests.Count;

        public Task<ListTransactionsResult> Page(ListTransactionsRequest request, CancellationToken ct)
        {
            lock (Requests) Requests.Add(request);
            IEnumerable<NwcTransaction> rows = Rows;
            if (request.Unpaid is not true) rows = rows.Where(Settlement.IsSettled);
            var page = rows.Skip(request.Offset ?? 0).Take(request.Limit ?? OpenReceiveTables.TransactionPageLimit).ToList();
            return Task.FromResult(new ListTransactionsResult { Transactions = page });
        }
    }

    private static (ScanMemo Memo, ScriptedWallet Wallet) NewMemo(Func<long> clock)
    {
        var wallet = new ScriptedWallet();
        return (new ScanMemo(wallet.Page, clock, NullLogger.Instance), wallet);
    }

    [Fact]
    public async Task Refresh_twice_within_the_interval_walks_once()
    {
        var (memo, wallet) = NewMemo(() => T0);
        Assert.Null(memo.RefreshedAt);

        await memo.RefreshAsync(force: false, CancellationToken.None);
        await memo.RefreshAsync(force: false, CancellationToken.None);

        // One walk = the settled view + the unpaid view, one short page each.
        Assert.Equal(2, wallet.Calls);
        Assert.Equal(T0, memo.RefreshedAt);
        Assert.True(memo.Complete);
        Assert.Equal(new bool?[] { null, true }, wallet.Requests.Select(r => r.Unpaid));
        Assert.All(wallet.Requests, r =>
        {
            Assert.Equal("incoming", r.Type);
            Assert.Equal(OpenReceiveTables.TransactionPageLimit, r.Limit);
            Assert.Equal(0, r.Offset);
            Assert.Equal(T0 - (long)ScanMemo.Window.TotalSeconds, r.From);
            Assert.Equal(T0 + ScanMemo.OverlapSeconds, r.Until);
        });

        // Forced refreshes always walk; a stale memo walks on its own.
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.Equal(4, wallet.Calls);
    }

    [Fact]
    public async Task Refresh_walks_again_once_the_interval_has_passed()
    {
        var now = T0;
        var (memo, wallet) = NewMemo(() => now);
        memo.NoteInvoiceMinted(T0);
        await memo.RefreshAsync(force: false, CancellationToken.None);
        Assert.Equal(2, wallet.Calls);

        now = T0 + 1;
        await memo.RefreshAsync(force: false, CancellationToken.None);
        Assert.Equal(2, wallet.Calls);

        now = T0 + 2;
        await memo.RefreshAsync(force: false, CancellationToken.None);
        Assert.Equal(4, wallet.Calls);
    }

    [Fact]
    public void Record_then_Lookup_finds_the_pending_row()
    {
        var (memo, _) = NewMemo(() => T0);
        var hash = Hash(1);
        Assert.Null(memo.Lookup(hash));

        memo.Record(Pending(hash));
        var row = memo.Lookup(hash);
        Assert.NotNull(row);
        Assert.Equal("pending", row.TransactionState);
        Assert.Equal(1_000, row.AmountMsats);
        Assert.Empty(memo.DrainNewlySettled());

        // A row without a hash is not a row the memo can key.
        memo.Record(Pending(hash) with { PaymentHash = null });
        Assert.Same(row, memo.Lookup(hash));
    }

    [Fact]
    public async Task A_row_that_settles_is_announced_exactly_once()
    {
        var (memo, wallet) = NewMemo(() => T0);
        var hash = Hash(2);
        memo.Record(Pending(hash));

        memo.Record(Settled(hash));
        var drained = Assert.Single(memo.DrainNewlySettled());
        Assert.Equal(hash, drained.PaymentHash);
        Assert.Empty(memo.DrainNewlySettled());

        // The same settled row seen again — recorded or walked — is not re-announced.
        memo.Record(Settled(hash));
        Assert.Empty(memo.DrainNewlySettled());
        wallet.Rows.Add(Settled(hash));
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.Empty(memo.DrainNewlySettled());
    }

    [Fact]
    public async Task A_settled_row_never_regresses_to_pending()
    {
        var (memo, wallet) = NewMemo(() => T0);
        var hash = Hash(3);
        memo.Record(Settled(hash, settledAt: T0 - 5));

        memo.Record(Pending(hash));
        Assert.True(Settlement.IsSettled(memo.Lookup(hash)!));
        Assert.Equal(T0 - 5, memo.Lookup(hash)!.SettledAt);

        // A later page that (wrongly) says pending is ignored too: a settled fact is final.
        wallet.Rows.Add(Pending(hash));
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.True(Settlement.IsSettled(memo.Lookup(hash)!));
        Assert.Equal(T0 - 5, memo.Lookup(hash)!.SettledAt);
    }

    [Fact]
    public async Task A_walk_upserts_settled_rows_over_unpaid_view_rows()
    {
        var (memo, wallet) = NewMemo(() => T0);
        var settled = Hash(4);
        var pending = Hash(5);
        wallet.Rows.Add(Settled(settled));
        wallet.Rows.Add(Pending(pending));

        await memo.RefreshAsync(force: false, CancellationToken.None);

        Assert.True(Settlement.IsSettled(memo.Lookup(settled)!));
        Assert.False(Settlement.IsSettled(memo.Lookup(pending)!));
        var announced = Assert.Single(memo.DrainNewlySettled());
        Assert.Equal(settled, announced.PaymentHash);
    }

    [Fact]
    public async Task Concurrent_refreshes_share_one_in_flight_walk()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        ListTransactionsPage page = async (request, ct) =>
        {
            Interlocked.Increment(ref calls);
            await release.Task;
            return new ListTransactionsResult { Transactions = Array.Empty<NwcTransaction>() };
        };
        var memo = new ScanMemo(page, () => T0, NullLogger.Instance);

        var refreshes = Enumerable.Range(0, 5).Select(_ => memo.RefreshAsync(force: true, CancellationToken.None)).ToArray();
        Assert.All(refreshes, r => Assert.False(r.IsCompleted));
        Assert.Equal(1, Volatile.Read(ref calls)); // the first page request is parked on the gate

        release.SetResult();
        await Task.WhenAll(refreshes).WaitAsync(TimeSpan.FromSeconds(20));

        Assert.Equal(2, Volatile.Read(ref calls)); // one walk: settled view + unpaid view
        Assert.Equal(T0, memo.RefreshedAt);
    }

    [Fact]
    public async Task A_truncated_walk_leaves_the_memo_incomplete()
    {
        var pages = 0;
        ListTransactionsPage page = (request, ct) =>
        {
            Interlocked.Increment(ref pages);
            // Every page is full and every row is new, so the walk only stops at its cap.
            var offset = request.Offset ?? 0;
            var rows = Enumerable.Range(offset, OpenReceiveTables.TransactionPageLimit)
                .Select(i => Settled(Hash(1_000 + i)))
                .ToList();
            return Task.FromResult(new ListTransactionsResult { Transactions = rows });
        };
        var memo = new ScanMemo(page, () => T0, NullLogger.Instance);

        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.False(memo.Complete);
        Assert.Equal(2 * ScanMemo.MaxPagesPerView, pages);
        Assert.Equal(ScanMemo.MaxPagesPerView * OpenReceiveTables.TransactionPageLimit, memo.DrainNewlySettled().Count);
        Assert.NotNull(memo.Lookup(Hash(1_000)));
        Assert.NotNull(memo.Lookup(Hash(1_000 + ScanMemo.MaxPagesPerView * OpenReceiveTables.TransactionPageLimit - 1)));
    }

    [Fact]
    public async Task A_wallet_that_ignores_offset_stops_the_walk_and_leaves_it_incomplete()
    {
        var pages = 0;
        ListTransactionsPage page = (request, ct) =>
        {
            Interlocked.Increment(ref pages);
            var rows = Enumerable.Range(0, OpenReceiveTables.TransactionPageLimit).Select(i => Settled(Hash(2_000 + i))).ToList();
            return Task.FromResult(new ListTransactionsResult { Transactions = rows });
        };
        var memo = new ScanMemo(page, () => T0, NullLogger.Instance);

        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.False(memo.Complete);
        Assert.Equal(4, pages); // two identical pages per view, then the repeat is detected
    }

    [Fact]
    public void CurrentInterval_stretches_with_the_age_of_the_newest_minted_invoice()
    {
        var now = T0;
        var (memo, _) = NewMemo(() => now);
        Assert.Equal(TimeSpan.FromSeconds(12), memo.CurrentInterval); // nothing minted yet

        memo.NoteInvoiceMinted(now);
        Assert.Equal(TimeSpan.FromSeconds(2), memo.CurrentInterval);

        now = T0 + 3 * 60;
        Assert.Equal(TimeSpan.FromSeconds(6), memo.CurrentInterval);

        now = T0 + 6 * 60;
        Assert.Equal(TimeSpan.FromSeconds(12), memo.CurrentInterval);

        // An older mint never rewinds the cadence; a newer one does.
        memo.NoteInvoiceMinted(T0 - 3600);
        Assert.Equal(TimeSpan.FromSeconds(12), memo.CurrentInterval);
        memo.NoteInvoiceMinted(now);
        Assert.Equal(TimeSpan.FromSeconds(2), memo.CurrentInterval);
    }

    [Fact]
    public async Task A_failing_page_propagates_and_leaves_the_memo_unrefreshed()
    {
        ListTransactionsPage page = (_, _) => throw new NwcTransportException("relay down");
        var memo = new ScanMemo(page, () => T0, NullLogger.Instance);

        await Assert.ThrowsAsync<NwcTransportException>(() => memo.RefreshAsync(force: false, CancellationToken.None));
        Assert.Null(memo.RefreshedAt);
        Assert.False(memo.Complete);
    }
}
