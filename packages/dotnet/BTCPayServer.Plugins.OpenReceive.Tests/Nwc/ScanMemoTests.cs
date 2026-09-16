using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using Microsoft.Extensions.Logging.Abstractions;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Nwc;

/// <summary>
/// The per-connection wallet memo: one targeted walk (from the oldest watched invoice,
/// stopping once every watched hash is seen) serves every caller, nothing watched costs
/// nothing, a settled fact is final, and a hash a walk cannot reach is never closed.
/// </summary>
public sealed class ScanMemoTests
{
    private const long T0 = 1_800_000_000;
    private const long WindowSeconds = 24 * 3600;

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

    private static NwcTransaction Settled(string hash, long settledAt = T0, long createdAt = T0) =>
        Pending(hash, createdAt) with { TransactionState = "settled", SettledAt = settledAt, Preimage = new string('c', 64) };

    /// <summary>
    /// A scripted wallet: <c>Rows</c> (newest first, as NWC-05 orders) is what every page
    /// request answers, honouring <c>from</c>/<c>until</c>; each call is remembered.
    /// <c>DropOffset</c> simulates a wallet that serves page 0 forever; <c>LookupScript</c>
    /// answers lookup_invoice.
    /// </summary>
    private sealed class ScriptedWallet
    {
        public List<NwcTransaction> Rows { get; } = new();
        public List<ListTransactionsRequest> Requests { get; } = new();
        public List<string> Lookups { get; } = new();
        public bool DropOffset { get; set; }
        public Func<string, LookupResult>? LookupScript { get; set; }
        public int Calls => Requests.Count;

        public Task<ListTransactionsResult> Page(ListTransactionsRequest request, CancellationToken ct)
        {
            lock (Requests) Requests.Add(request);
            IEnumerable<NwcTransaction> rows = Rows;
            if (request.Unpaid is not true) rows = rows.Where(Settlement.IsSettled);
            if (request.From is { } from) rows = rows.Where(r => r.CreatedAt is null || r.CreatedAt >= from);
            if (request.Until is { } until) rows = rows.Where(r => r.CreatedAt is null || r.CreatedAt <= until);
            var offset = DropOffset ? 0 : request.Offset ?? 0;
            var page = rows.Skip(offset).Take(request.Limit ?? OpenReceiveTables.TransactionPageLimit).ToList();
            return Task.FromResult(new ListTransactionsResult { Transactions = page });
        }

        public Task<LookupResult> Lookup(string paymentHash, CancellationToken ct)
        {
            lock (Lookups) Lookups.Add(paymentHash);
            return Task.FromResult(LookupScript?.Invoke(paymentHash) ?? LookupResult.Unavailable);
        }
    }

    private static (ScanMemo Memo, ScriptedWallet Wallet) NewMemo(Func<long> clock, bool withLookup = false)
    {
        var wallet = new ScriptedWallet();
        return (new ScanMemo(wallet.Page, clock, NullLogger.Instance, withLookup ? wallet.Lookup : null), wallet);
    }

    /// <summary>A minted invoice as the client records it: remembered and watched.</summary>
    private static void Mint(ScanMemo memo, NwcTransaction row)
    {
        memo.Record(row);
        memo.Watch(row.PaymentHash!);
    }

    // ---- Cadence and sharing ----

    [Fact]
    public async Task Refresh_with_nothing_watched_makes_no_requests()
    {
        var (memo, wallet) = NewMemo(() => T0);
        wallet.Rows.Add(Settled(Hash(1)));
        Assert.Null(memo.RefreshedAt);

        Assert.True(await memo.RefreshAsync(force: false, CancellationToken.None));
        Assert.True(await memo.RefreshAsync(force: true, CancellationToken.None));

        Assert.Equal(0, wallet.Calls);
        Assert.Equal(T0, memo.RefreshedAt);
        Assert.True(memo.Complete);
        Assert.Equal(0, memo.WatchedCount);
        Assert.Null(memo.Lookup(Hash(1))); // an unwatched row is nobody's business
    }

    [Fact]
    public async Task Refresh_twice_within_the_interval_walks_once()
    {
        var (memo, wallet) = NewMemo(() => T0);
        Mint(memo, Pending(Hash(1), createdAt: T0 - 30));
        wallet.Rows.Add(Pending(Hash(1), createdAt: T0 - 30));

        Assert.True(await memo.RefreshAsync(force: false, CancellationToken.None));
        Assert.False(await memo.RefreshAsync(force: false, CancellationToken.None));

        // One walk = the settled view (a miss), then the unpaid view for the hash still missing.
        Assert.Equal(2, wallet.Calls);
        Assert.Equal(T0, memo.RefreshedAt);
        Assert.True(memo.Complete);
        Assert.Equal(new bool?[] { null, true }, wallet.Requests.Select(r => r.Unpaid));
        Assert.All(wallet.Requests, r =>
        {
            Assert.Equal("incoming", r.Type);
            Assert.Equal(OpenReceiveTables.TransactionPageLimit, r.Limit);
            Assert.Equal(0, r.Offset);
            Assert.Equal(T0 - 30 - ScanMemo.OverlapSeconds, r.From); // the oldest watched invoice, padded
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
        Mint(memo, Pending(Hash(1)));
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
        Mint(memo, Pending(Hash(1)));

        var refreshes = Enumerable.Range(0, 5).Select(_ => memo.RefreshAsync(force: false, CancellationToken.None)).ToArray();
        Assert.All(refreshes, r => Assert.False(r.IsCompleted));
        Assert.Equal(1, Volatile.Read(ref calls)); // the first page request is parked on the gate

        release.SetResult();
        await Task.WhenAll(refreshes).WaitAsync(TimeSpan.FromSeconds(20));

        Assert.Equal(2, Volatile.Read(ref calls)); // one walk: settled view + unpaid view
        Assert.Equal(T0, memo.RefreshedAt);
    }

    [Fact]
    public async Task A_forced_refresh_during_a_walk_runs_its_own_afterwards()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var wallet = new ScriptedWallet();
        ListTransactionsPage page = async (request, ct) =>
        {
            await release.Task;
            return await wallet.Page(request, ct);
        };
        var memo = new ScanMemo(page, () => T0, NullLogger.Instance);
        Mint(memo, Pending(Hash(1)));
        wallet.Rows.Add(Settled(Hash(2)));

        var first = memo.RefreshAsync(force: false, CancellationToken.None);
        Mint(memo, Pending(Hash(2))); // watched while the first walk is already under way
        var forced = memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.False(forced.IsCompleted);

        release.SetResult();
        await Task.WhenAll(first, forced).WaitAsync(TimeSpan.FromSeconds(20));

        Assert.True(Settlement.IsSettled(memo.Lookup(Hash(2))!)); // the second walk covered it
        Assert.Equal(Hash(2), Assert.Single(memo.DrainNewlySettled()).PaymentHash);
        Assert.Equal(4, wallet.Calls); // two walks, two views each
    }

    [Fact]
    public async Task A_caller_that_gives_up_does_not_cancel_the_shared_walk()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var seen = new List<CancellationToken>();
        ListTransactionsPage page = async (request, ct) =>
        {
            lock (seen) seen.Add(ct);
            await release.Task;
            return new ListTransactionsResult { Transactions = Array.Empty<NwcTransaction>() };
        };
        var memo = new ScanMemo(page, () => T0, NullLogger.Instance);
        Mint(memo, Pending(Hash(1)));
        using var aborted = new CancellationTokenSource();

        var checkout = memo.RefreshAsync(force: true, aborted.Token); // an HTTP request that is about to abort
        var listener = memo.RefreshAsync(force: false, CancellationToken.None); // the listener sharing that walk
        aborted.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => checkout);
        Assert.False(listener.IsCompleted);

        release.SetResult();
        await listener.WaitAsync(TimeSpan.FromSeconds(20));

        Assert.Equal(T0, memo.RefreshedAt);
        Assert.Equal(2, seen.Count); // one walk: settled view + unpaid view
        Assert.All(seen, ct => Assert.False(ct.IsCancellationRequested)); // the walk ran on its own lifetime
    }

    [Fact]
    public async Task A_walk_notes_a_fresh_pending_invoice_for_the_cadence()
    {
        var (memo, wallet) = NewMemo(() => T0);
        Mint(memo, Pending(Hash(1), createdAt: T0 - 400));
        Assert.Equal(TimeSpan.FromSeconds(12), memo.CurrentInterval);
        wallet.Rows.Add(Pending(Hash(2), createdAt: T0 - 30)); // minted by another process, seen on the same page
        wallet.Rows.Add(Pending(Hash(1), createdAt: T0 - 400));

        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.Equal(TimeSpan.FromSeconds(2), memo.CurrentInterval);

        // A pending row older than the freshness window (a stale, unpaid invoice) does not count.
        var (cold, coldWallet) = NewMemo(() => T0);
        Mint(cold, Pending(Hash(1), createdAt: T0 - 400));
        coldWallet.Rows.Add(Pending(Hash(3), createdAt: T0 - ScanMemo.FreshInvoiceSeconds - 1));
        coldWallet.Rows.Add(Pending(Hash(1), createdAt: T0 - 400));
        await cold.RefreshAsync(force: true, CancellationToken.None);
        Assert.Equal(TimeSpan.FromSeconds(12), cold.CurrentInterval);
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

    // ---- Rows: settled facts, announcements, merging ----

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
        Mint(memo, Pending(hash));

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
        memo.Watch(hash); // ignored: the row is terminal
        Assert.False(memo.IsWatched(hash));
        wallet.Rows.Add(Pending(hash));
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.True(Settlement.IsSettled(memo.Lookup(hash)!));
        Assert.Equal(T0 - 5, memo.Lookup(hash)!.SettledAt);
    }

    [Fact]
    public void A_sparse_row_never_erases_what_the_memo_knows()
    {
        var (memo, _) = NewMemo(() => T0);
        var hash = Hash(4);
        memo.Record(Pending(hash) with { Invoice = "lnbcrt1minted", Description = "desc" });

        // A notification without created_at or the invoice text, as some wallets push them.
        memo.Record(new NwcTransaction { PaymentHash = hash, TransactionState = "settled", SettledAt = T0 + 5, Preimage = new string('d', 64) });

        var row = memo.Lookup(hash)!;
        Assert.True(Settlement.IsSettled(row));
        Assert.Equal("lnbcrt1minted", row.Invoice);
        Assert.Equal(1_000, row.AmountMsats);
        Assert.Equal(T0, row.CreatedAt);
        Assert.Equal(T0 + 600, row.ExpiresAt);
        Assert.Equal("desc", row.Description);
        Assert.Equal(new string('d', 64), row.Preimage);
    }

    // ---- The watched set ----

    [Fact]
    public async Task A_walk_covers_the_watched_hashes_and_the_settled_one_leaves_the_set()
    {
        var (memo, wallet) = NewMemo(() => T0);
        var settled = Hash(4);
        var pending = Hash(5);
        Mint(memo, Pending(settled));
        Mint(memo, Pending(pending));
        wallet.Rows.Add(Settled(settled));
        wallet.Rows.Add(Pending(pending));

        await memo.RefreshAsync(force: false, CancellationToken.None);

        Assert.True(Settlement.IsSettled(memo.Lookup(settled)!));
        Assert.False(Settlement.IsSettled(memo.Lookup(pending)!));
        var announced = Assert.Single(memo.DrainNewlySettled());
        Assert.Equal(settled, announced.PaymentHash);
        Assert.False(memo.IsWatched(settled));
        Assert.True(memo.IsWatched(pending));
        Assert.Equal(1, memo.WatchedCount);
    }

    [Fact]
    public async Task A_walk_starts_at_the_oldest_watched_invoice_not_a_fixed_window()
    {
        // A two-day invoice minted 30 hours ago: outside the old 24-hour window, still live.
        var createdAt = T0 - 30 * 3600;
        var (memo, wallet) = NewMemo(() => T0);
        Mint(memo, Pending(Hash(1), createdAt) with { ExpiresAt = createdAt + 48 * 3600 });
        Mint(memo, Pending(Hash(2), T0 - 30));
        wallet.Rows.Add(Pending(Hash(2), T0 - 30));
        wallet.Rows.Add(Settled(Hash(1), settledAt: T0 - 10, createdAt: createdAt));

        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.All(wallet.Requests, r => Assert.Equal(createdAt - ScanMemo.OverlapSeconds, r.From));
        Assert.True(Settlement.IsSettled(memo.Lookup(Hash(1))!));
        Assert.Equal(Hash(1), Assert.Single(memo.DrainNewlySettled()).PaymentHash);
        Assert.True(memo.Complete);
    }

    [Fact]
    public async Task A_watched_row_is_never_forgotten_while_unwatched_stale_rows_are()
    {
        var old = T0 - WindowSeconds - 10;
        var now = old;
        var (memo, wallet) = NewMemo(() => now);
        Mint(memo, Pending(Hash(1), old));
        memo.Record(Settled(Hash(1), settledAt: old, createdAt: old)); // settled a day ago: announced, then nobody's business
        Assert.Equal(Hash(1), Assert.Single(memo.DrainNewlySettled()).PaymentHash);
        Mint(memo, Pending(Hash(2), old) with { ExpiresAt = T0 + 3600 }); // a long invoice still live
        wallet.Rows.Add(Pending(Hash(2), old) with { ExpiresAt = T0 + 3600 });

        now = T0;
        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.Null(memo.Lookup(Hash(1)));
        Assert.NotNull(memo.Lookup(Hash(2)));
        Assert.True(memo.IsWatched(Hash(2)));
    }

    [Fact]
    public async Task A_pending_row_leaves_the_set_only_after_a_complete_walk_past_expiry_plus_grace()
    {
        var now = T0;
        var (memo, wallet) = NewMemo(() => now);
        Mint(memo, Pending(Hash(1))); // expires at T0 + 600
        wallet.Rows.Add(Pending(Hash(1)));

        now = T0 + 600 + ScanMemo.ExpiryGraceSeconds - 1;
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.True(memo.IsWatched(Hash(1))); // not yet

        now = T0 + 600 + ScanMemo.ExpiryGraceSeconds;
        wallet.DropOffset = true; // this walk is truncated: the wallet repeats its page
        for (var n = 10; n < 40; n++) wallet.Rows.Insert(0, Pending(Hash(n), now)); // enough newer rows for a full page
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.True(memo.IsWatched(Hash(1))); // a truncated walk never drops a watched hash
        Assert.False(memo.Complete);

        wallet.DropOffset = false;
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.False(memo.IsWatched(Hash(1))); // a complete walk at expiry + grace still showed it unpaid
        Assert.True(memo.Complete);
        Assert.False(Settlement.IsSettled(memo.Lookup(Hash(1))!)); // the row itself is untouched: BTCPay owns expiry
    }

    // ---- Truncation and the single-hash fallback ----

    private static (ScanMemo Memo, ScriptedWallet Wallet) BuriedBehindAWalletThatIgnoresOffset(bool withLookup)
    {
        var (memo, wallet) = NewMemo(() => T0, withLookup);
        Mint(memo, Pending(Hash(1), T0 - 100));
        for (var n = 2; n < 42; n++) wallet.Rows.Add(n % 2 == 0 ? Settled(Hash(n)) : Pending(Hash(n))); // 40 newer rows: full pages
        wallet.Rows.Add(Settled(Hash(1), settledAt: T0 - 5, createdAt: T0 - 100)); // paid, and last
        wallet.DropOffset = true;
        return (memo, wallet);
    }

    [Fact]
    public async Task A_truncated_walk_keeps_the_hash_watched_and_pending_until_a_walk_reaches_it()
    {
        var (memo, wallet) = BuriedBehindAWalletThatIgnoresOffset(withLookup: false);

        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.False(memo.Complete);
        Assert.Equal(1, memo.Unreached);
        Assert.True(memo.IsWatched(Hash(1)));
        Assert.False(Settlement.IsSettled(memo.Lookup(Hash(1))!)); // still what the memo knew: pending, never closed
        Assert.Equal(4, wallet.Calls); // two identical pages per view, then the repeat is detected
        Assert.Empty(memo.DrainNewlySettled());

        wallet.DropOffset = false; // the wallet starts honouring offset
        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.True(memo.Complete);
        Assert.Equal(0, memo.Unreached);
        Assert.True(Settlement.IsSettled(memo.Lookup(Hash(1))!));
        Assert.Equal(Hash(1), Assert.Single(memo.DrainNewlySettled()).PaymentHash);
        Assert.False(memo.IsWatched(Hash(1)));
    }

    [Fact]
    public async Task A_truncated_walk_falls_back_to_lookup_invoice_only_when_granted()
    {
        var (found, foundWallet) = BuriedBehindAWalletThatIgnoresOffset(withLookup: true);
        foundWallet.LookupScript = hash => new LookupResult(LookupOutcome.Found, Settled(hash, settledAt: T0 - 5, createdAt: T0 - 100));
        await found.RefreshAsync(force: true, CancellationToken.None);
        Assert.Equal([Hash(1)], foundWallet.Lookups); // spent only because the walk provably could not reach it
        Assert.True(found.Complete);
        Assert.True(Settlement.IsSettled(found.Lookup(Hash(1))!));
        Assert.Equal(Hash(1), Assert.Single(found.DrainNewlySettled()).PaymentHash);

        var (unavailable, unavailableWallet) = BuriedBehindAWalletThatIgnoresOffset(withLookup: true);
        unavailableWallet.LookupScript = _ => LookupResult.Unavailable; // the code does not grant lookup_invoice
        await unavailable.RefreshAsync(force: true, CancellationToken.None);
        Assert.Single(unavailableWallet.Lookups);
        Assert.False(unavailable.Complete);
        Assert.Equal(1, unavailable.Unreached);
        Assert.True(unavailable.IsWatched(Hash(1)));

        var (missing, missingWallet) = BuriedBehindAWalletThatIgnoresOffset(withLookup: true);
        missingWallet.LookupScript = _ => LookupResult.NotFound; // the wallet lost a row it minted: stay pending, keep watching
        await missing.RefreshAsync(force: true, CancellationToken.None);
        Assert.True(missing.IsWatched(Hash(1)));
        Assert.False(Settlement.IsSettled(missing.Lookup(Hash(1))!));
    }

    // ---- A hash of unknown age (asked about after a restart) ----

    [Fact]
    public async Task An_unknown_hash_is_looked_up_first_when_granted()
    {
        var (memo, wallet) = NewMemo(() => T0, withLookup: true);
        var old = T0 - 3 * 86_400;
        wallet.LookupScript = hash => hash == Hash(1)
            ? new LookupResult(LookupOutcome.Found, Settled(Hash(1), settledAt: old + 30, createdAt: old))
            : LookupResult.NotFound;
        memo.Watch(Hash(1));
        memo.Watch(Hash(2));

        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.Equal(0, wallet.Calls); // both decided without a single page
        Assert.Equal(2, wallet.Lookups.Count);
        Assert.True(Settlement.IsSettled(memo.Lookup(Hash(1))!));
        Assert.Equal(Hash(1), Assert.Single(memo.DrainNewlySettled()).PaymentHash);
        Assert.False(memo.IsWatched(Hash(1))); // terminal
        Assert.False(memo.IsWatched(Hash(2))); // the wallet says it is not there
        Assert.True(memo.Complete);
    }

    [Fact]
    public async Task An_unknown_hash_gets_one_unbounded_walk_when_lookup_is_unavailable()
    {
        var (memo, wallet) = NewMemo(() => T0);
        var old = T0 - 3 * 86_400; // far outside the fallback window
        wallet.Rows.Add(Settled(Hash(1), settledAt: old + 30, createdAt: old));
        memo.Watch(Hash(1));

        await memo.RefreshAsync(force: true, CancellationToken.None);

        // The window (two views, nothing there), then one walk with no lower bound.
        Assert.Equal(new long?[] { T0 - WindowSeconds - ScanMemo.OverlapSeconds, T0 - WindowSeconds - ScanMemo.OverlapSeconds, null }, wallet.Requests.Select(r => r.From));
        Assert.True(Settlement.IsSettled(memo.Lookup(Hash(1))!));
        Assert.Equal(Hash(1), Assert.Single(memo.DrainNewlySettled()).PaymentHash);
        Assert.False(memo.IsWatched(Hash(1)));
        Assert.True(memo.Complete);

        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.Equal(3, wallet.Calls); // nothing left to watch
    }

    [Fact]
    public async Task An_unknown_hash_proven_absent_by_complete_walks_leaves_the_set()
    {
        var (memo, wallet) = NewMemo(() => T0);
        wallet.Rows.Add(Settled(Hash(9)));
        memo.Watch(Hash(1));

        await memo.RefreshAsync(force: true, CancellationToken.None);

        Assert.Equal(4, wallet.Calls); // window: two views; unbounded: two views — all complete, nothing found
        Assert.False(memo.IsWatched(Hash(1)));
        Assert.Null(memo.Lookup(Hash(1)));
        Assert.True(memo.Complete);

        // Asked about again: watched again, but the unbounded walk is not repeated for a hash of unknown age.
        memo.Watch(Hash(1));
        await memo.RefreshAsync(force: true, CancellationToken.None);
        Assert.Equal(8, wallet.Calls);
    }

    // ---- Failures ----

    [Fact]
    public async Task A_failing_page_propagates_and_leaves_the_memo_unrefreshed()
    {
        ListTransactionsPage page = (_, _) => throw new NwcTransportException("relay down");
        var memo = new ScanMemo(page, () => T0, NullLogger.Instance);
        Mint(memo, Pending(Hash(1)));

        await Assert.ThrowsAsync<NwcTransportException>(() => memo.RefreshAsync(force: false, CancellationToken.None));
        Assert.Null(memo.RefreshedAt);
        Assert.True(memo.IsWatched(Hash(1)));
    }
}
