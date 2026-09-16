#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Generated;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>How a <see cref="LookupInvoiceFallback"/> call ended.</summary>
public enum LookupOutcome
{
    /// <summary>The wallet returned the row.</summary>
    Found,
    /// <summary>The wallet answered NOT_FOUND: the hash is not in this wallet.</summary>
    NotFound,
    /// <summary>lookup_invoice is not granted, or the wallet could not answer.</summary>
    Unavailable,
}

public sealed record LookupResult(LookupOutcome Outcome, NwcTransaction? Row)
{
    public static readonly LookupResult NotFound = new(LookupOutcome.NotFound, null);
    public static readonly LookupResult Unavailable = new(LookupOutcome.Unavailable, null);
}

/// <summary>
/// The optional single-hash fast path (<c>lookup_invoice</c>): consulted only for a hash a
/// wallet walk could not reach. Returns <see cref="LookupOutcome.Unavailable"/> when the
/// connection does not grant the method.
/// </summary>
public delegate Task<LookupResult> LookupInvoiceFallback(string paymentHash, CancellationToken cancellationToken);

/// <summary>
/// The per-connection wallet memo: the JS/Ruby reconcile pass (<c>reconcilePaymentAttempts</c>)
/// transplanted into process memory. It WATCHES the hashes BTCPay monitors — every invoice
/// minted here and every hash BTCPay asks <c>GetInvoice</c> about — and one refresh walks
/// <c>list_transactions</c> for exactly those: from the oldest watched pending invoice
/// (minus <see cref="OverlapSeconds"/>), settled view first, then the inclusive unpaid view
/// for whatever is still missing, stopping as soon as every watched hash is seen. A watched
/// hash leaves the set only when the wallet's own row is terminal, when a successful walk at
/// or after its expiry plus <see cref="ExpiryGraceSeconds"/> still shows it unpaid, or when
/// the wallet proves it absent; an empty set makes a refresh free. A hash a truncated walk
/// could not reach is never closed: it is retried through <see cref="LookupInvoiceFallback"/>
/// when the wallet grants <c>lookup_invoice</c>, and stays pending otherwise.
/// One walk serves every concurrent caller (BTCPay's GetInvoice on creation, on startup for
/// each pending invoice, the listeners' sweeps); the refresh cadence stretches with the age
/// of the newest live invoice (2 s / 6 s / 12 s) and IS the NWC scan budget for the
/// connection. It is a cache of wallet truth, not state: two BTCPay workers each hold one.
/// </summary>
public sealed class ScanMemo
{
    /// <summary>
    /// The lower bound of a walk that has no watched row with a creation time (a hash BTCPay
    /// asked about after a restart), and how long an unwatched row stays in memory.
    /// Never a correctness bound on a watched invoice.
    /// </summary>
    public static readonly TimeSpan Window = TimeSpan.FromHours(24);
    public const int OverlapSeconds = 60;
    /// <summary>A sanity cap only: a targeted walk stops as soon as every watched hash is seen.</summary>
    public const int MaxPagesPerView = 10_000;
    /// <summary>A pending row younger than this, seen in a walk, counts as a live checkout for the cadence.</summary>
    public const int FreshInvoiceSeconds = 300;
    /// <summary>Seconds past an invoice's expiry during which it is still walked for (the shared kernel number).</summary>
    public const int ExpiryGraceSeconds = OpenReceiveTables.AttemptExpiryGraceSeconds;

    private sealed class WatchEntry
    {
        public long WatchedAt;
        /// <summary>The one unbounded walk an unknown hash gets when lookup_invoice is unavailable.</summary>
        public bool DeepWalked;
    }

    private readonly ListTransactionsPage _list;
    private readonly LookupInvoiceFallback? _lookup;
    private readonly Func<long> _clock;
    private readonly ILogger _logger;
    private readonly object _gate = new();
    private readonly Dictionary<string, NwcTransaction> _rows = new(StringComparer.Ordinal);
    private readonly Dictionary<string, WatchEntry> _watched = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _touched = new(StringComparer.Ordinal);
    private readonly HashSet<string> _settledAnnounced = new(StringComparer.Ordinal);
    private readonly Queue<NwcTransaction> _newlySettled = new();
    private Task? _inflight;
    private long _refreshedAt = long.MinValue;
    private bool _complete = true;
    private int _unreached;
    private long? _newestMintedAt;

    public ScanMemo(ListTransactionsPage list, Func<long> clock, ILogger logger, LookupInvoiceFallback? lookup = null)
    {
        _list = list;
        _lookup = lookup;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>When this memo last finished a refresh (unix seconds), or null before the first.</summary>
    public long? RefreshedAt => _refreshedAt == long.MinValue ? null : _refreshedAt;

    /// <summary>False while some watched hash could not be reached by the last walk (truncated, and no lookup).</summary>
    public bool Complete => _complete;

    /// <summary>Watched hashes the last walk could not reach; they stay watched and pending.</summary>
    public int Unreached => _unreached;

    /// <summary>Hashes BTCPay is monitoring through this memo, not yet terminal.</summary>
    public int WatchedCount
    {
        get { lock (_gate) return _watched.Count; }
    }

    /// <summary>
    /// Marks a hash as monitored: it joins every following walk until the wallet's row is
    /// terminal or a walk at or after its expiry plus grace still shows it unpaid.
    /// </summary>
    public void Watch(string paymentHash)
    {
        lock (_gate)
        {
            if (_watched.ContainsKey(paymentHash)) return;
            if (_rows.TryGetValue(paymentHash, out var row) && IsTerminal(row)) return;
            _watched[paymentHash] = new WatchEntry { WatchedAt = _clock() };
        }
    }

    /// <summary>True while the hash is part of the walk set (tests and the doctor).</summary>
    public bool IsWatched(string paymentHash)
    {
        lock (_gate) return _watched.ContainsKey(paymentHash);
    }

    /// <summary>Called by the client after every make_invoice (and by a walk for a fresh pending row) so the cadence tracks live checkouts.</summary>
    public void NoteInvoiceMinted(long createdAt)
    {
        lock (_gate)
        {
            NoteMinted(createdAt);
        }
    }

    /// <summary>
    /// The refresh interval: 2 s while the newest live invoice is under two minutes old,
    /// 6 s under five minutes, else 12 s (settlement-sweeps.md numbers; a cadence
    /// heuristic, never a correctness input).
    /// </summary>
    public TimeSpan CurrentInterval
    {
        get
        {
            long? minted;
            lock (_gate) minted = _newestMintedAt;
            if (minted is null) return TimeSpan.FromSeconds(12);
            var age = _clock() - minted.Value;
            if (age < 120) return TimeSpan.FromSeconds(2);
            if (age < 300) return TimeSpan.FromSeconds(6);
            return TimeSpan.FromSeconds(12);
        }
    }

    /// <summary>Upserts a row learned outside a walk (make_invoice, lookup_invoice, a notification). A settled row never regresses.</summary>
    public void Record(NwcTransaction transaction)
    {
        if (transaction.PaymentHash is null) return;
        lock (_gate)
        {
            Upsert(transaction);
        }
    }

    public NwcTransaction? Lookup(string paymentHash)
    {
        lock (_gate)
        {
            return _rows.TryGetValue(paymentHash, out var row) ? row : null;
        }
    }

    /// <summary>
    /// Refreshes when stale (older than <see cref="CurrentInterval"/>) or forced, and says
    /// whether a walk ran for this call; concurrent
    /// callers share one walk, and a forced refresh that arrives during a walk runs its own
    /// after it (so a hash watched a moment ago is covered). The walk runs on its own
    /// lifetime: a caller that gives up (an aborted checkout request) stops waiting, it does
    /// not cancel the walk under the listener and everyone else sharing it. Each page request
    /// is bounded by the transport.
    /// </summary>
    public Task<bool> RefreshAsync(bool force, CancellationToken cancellationToken)
    {
        Task work;
        lock (_gate)
        {
            if (_inflight is { IsCompleted: false } running)
            {
                work = force ? _inflight = AfterAsyncThenWalk(running) : running;
            }
            else
            {
                var stale = _refreshedAt == long.MinValue || _clock() - _refreshedAt >= (long)CurrentInterval.TotalSeconds;
                if (!force && !stale) return Task.FromResult(false);
                work = _inflight = WalkAsync();
            }
        }
        return AwaitedAsync(work, cancellationToken);
    }

    /// <summary>True: a walk ran (or was shared) for this call. False: the memo was fresh and nothing was requested.</summary>
    private static async Task<bool> AwaitedAsync(Task work, CancellationToken cancellationToken)
    {
        await work.WaitAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    /// <summary>Settled rows observed since the last drain, in the order they were noticed.</summary>
    public IReadOnlyList<NwcTransaction> DrainNewlySettled()
    {
        lock (_gate)
        {
            if (_newlySettled.Count == 0) return Array.Empty<NwcTransaction>();
            var drained = _newlySettled.ToArray();
            _newlySettled.Clear();
            return drained;
        }
    }

    private static async Task AfterAsync(Task running)
    {
        try { await running.ConfigureAwait(false); }
        catch { /* the earlier walk reports to its own callers */ }
    }

    private async Task AfterAsyncThenWalk(Task running)
    {
        await AfterAsync(running).ConfigureAwait(false);
        await WalkAsync().ConfigureAwait(false);
    }

    private async Task WalkAsync()
    {
        var now = _clock();
        var lookups = 0;
        var absent = new HashSet<string>(StringComparer.Ordinal);
        var lookedUp = new HashSet<string>(StringComparer.Ordinal);

        // A hash of unknown age (BTCPay asked about it after a restart) is asked of the wallet's
        // single-hash path first when it is granted: one request, instead of a window walk.
        List<string> unknownNow;
        lock (_gate) unknownNow = _watched.Keys.Where(hash => !_rows.ContainsKey(hash)).ToList();
        if (unknownNow.Count > 0 && _lookup is not null)
        {
            foreach (var hash in unknownNow)
            {
                var result = await _lookup(hash, CancellationToken.None).ConfigureAwait(false);
                if (result.Outcome == LookupOutcome.Unavailable) break; // not granted: the same answer for every hash
                lookups += 1;
                lookedUp.Add(hash);
                if (result.Outcome == LookupOutcome.Found && result.Row is not null)
                {
                    lock (_gate) Upsert(result.Row.PaymentHash is null ? result.Row with { PaymentHash = hash } : result.Row);
                }
                else
                {
                    absent.Add(hash);
                }
            }
        }

        HashSet<string> expected;
        HashSet<string> unknown;
        HashSet<string> deep;
        long? oldest = null;
        lock (_gate)
        {
            expected = new HashSet<string>(StringComparer.Ordinal);
            unknown = new HashSet<string>(StringComparer.Ordinal);
            deep = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (hash, watch) in _watched)
            {
                if (absent.Contains(hash)) continue; // the wallet says it is not there: leaves the set below
                if (_rows.TryGetValue(hash, out var row))
                {
                    if (IsTerminal(row)) continue; // leaves the set at the end of this walk
                    if (row.CreatedAt is { } createdAt) oldest = oldest is { } o ? Math.Min(o, createdAt) : createdAt;
                }
                else
                {
                    unknown.Add(hash);
                    if (!watch.DeepWalked) deep.Add(hash);
                }
                expected.Add(hash);
            }
        }
        if (expected.Count == 0)
        {
            lock (_gate)
            {
                Prune(now, walkComplete: true, provenAbsent: absent);
                _unreached = 0;
                _complete = true;
                _refreshedAt = _clock();
            }
            _logger.LogDebug("nwc.scan.memo watched=0 pages=0 lookups={Lookups}", lookups);
            return;
        }

        // Both ends of the window are padded: `from` against a wallet clock that lags, `until`
        // against one that runs ahead. A hash with no known creation time (asked about after a
        // restart) gets the fallback window here and one unbounded walk below.
        var from = Math.Max(0, (oldest ?? now - (long)Window.TotalSeconds) - OverlapSeconds);
        var until = now + OverlapSeconds;
        var settled = await WalletScan.WalkAsync(_list, from, until, includeUnpaid: false, expected, MaxPagesPerView, CancellationToken.None).ConfigureAwait(false);
        var missing = expected.Where(hash => !settled.ByPaymentHash.ContainsKey(hash)).ToHashSet(StringComparer.Ordinal);
        var pages = settled.Pages;
        var truncated = settled.Truncated;
        WalletWalk? unpaid = null;
        if (missing.Count > 0)
        {
            unpaid = await WalletScan.WalkAsync(_list, from, until, includeUnpaid: true, missing, MaxPagesPerView, CancellationToken.None).ConfigureAwait(false);
            missing.ExceptWith(unpaid.ByPaymentHash.Keys);
            pages += unpaid.Pages;
            truncated |= unpaid.Truncated;
        }
        lock (_gate)
        {
            if (unpaid is not null) foreach (var row in unpaid.ByPaymentHash.Values) Learn(row, now);
            foreach (var row in settled.ByPaymentHash.Values) Upsert(row);
        }

        // Whatever the bounded walk could not reach: the wallet's single-hash path when it is
        // granted (D3), else one unbounded targeted walk for a hash of unknown age (D4).
        if (missing.Count > 0 && _lookup is not null)
        {
            foreach (var hash in missing.Where(hash => !lookedUp.Contains(hash)).ToList())
            {
                var result = await _lookup(hash, CancellationToken.None).ConfigureAwait(false);
                if (result.Outcome == LookupOutcome.Unavailable) break; // not granted: the same answer for every hash
                lookups += 1;
                if (result.Outcome == LookupOutcome.Found && result.Row is not null)
                {
                    lock (_gate) Upsert(result.Row.PaymentHash is null ? result.Row with { PaymentHash = hash } : result.Row);
                }
                else
                {
                    absent.Add(hash);
                }
                missing.Remove(hash);
            }
        }
        deep.IntersectWith(missing);
        if (deep.Count > 0)
        {
            lock (_gate) foreach (var hash in deep) if (_watched.TryGetValue(hash, out var watch)) watch.DeepWalked = true;
            var deepSettled = await WalletScan.WalkAsync(_list, null, until, includeUnpaid: false, deep, MaxPagesPerView, CancellationToken.None).ConfigureAwait(false);
            var deepMissing = deep.Where(hash => !deepSettled.ByPaymentHash.ContainsKey(hash)).ToHashSet(StringComparer.Ordinal);
            var deepTruncated = deepSettled.Truncated;
            pages += deepSettled.Pages;
            lock (_gate) foreach (var row in deepSettled.ByPaymentHash.Values) Upsert(row);
            if (deepMissing.Count > 0)
            {
                var deepUnpaid = await WalletScan.WalkAsync(_list, null, until, includeUnpaid: true, deepMissing, MaxPagesPerView, CancellationToken.None).ConfigureAwait(false);
                deepMissing.ExceptWith(deepUnpaid.ByPaymentHash.Keys);
                deepTruncated |= deepUnpaid.Truncated;
                pages += deepUnpaid.Pages;
                lock (_gate) foreach (var row in deepUnpaid.ByPaymentHash.Values) Learn(row, now);
            }
            missing.ExceptWith(deep);
            if (!deepTruncated) absent.UnionWith(deepMissing); // proven absent from the whole history
            else missing.UnionWith(deepMissing);
            truncated |= deepTruncated;
        }

        // What is still missing was either proven absent from the window by a complete walk (a
        // known pending row the wallet no longer lists — kept as the memo remembers it) or is
        // unreached behind a truncated walk (kept, pending, retried next refresh).
        var unreached = truncated ? missing.Count : 0;
        lock (_gate)
        {
            Prune(now, walkComplete: !truncated, provenAbsent: absent);
            _unreached = unreached;
            _complete = unreached == 0;
            _refreshedAt = _clock();
        }
        if (unreached > 0)
        {
            _logger.LogWarning("nwc.scan.truncated unreached={Unreached} pages={Pages} (still watched; the next refresh retries)", unreached, pages);
        }
        _logger.LogDebug("nwc.scan.memo watched={Watched} from={From} pages={Pages} lookups={Lookups} complete={Complete}",
            expected.Count, from, pages, lookups, unreached == 0);
    }

    /// <summary>A row seen in an inclusive view: remembered, and a fresh pending one drives the cadence.</summary>
    private void Learn(NwcTransaction row, long now)
    {
        Upsert(row);
        if (!Settlement.IsSettled(row) && row.CreatedAt is { } createdAt && now - createdAt < FreshInvoiceSeconds && (row.ExpiresAt is null || row.ExpiresAt > now))
        {
            NoteMinted(createdAt); // a checkout in progress that another process (or this one, before a restart) minted
        }
    }

    /// <summary>
    /// Watched hashes leave the set when terminal, when proven absent, or — only after a
    /// complete walk — when the walk ran at or after their expiry plus grace and still showed
    /// them unpaid (a local clock alone never drops a watched invoice). Rows nobody watches are
    /// forgotten once untouched for <see cref="Window"/>, so a long-lived process does not grow
    /// with the wallet's history.
    /// </summary>
    private void Prune(long now, bool walkComplete, HashSet<string>? provenAbsent)
    {
        foreach (var (hash, watch) in _watched.ToList())
        {
            if (provenAbsent is not null && provenAbsent.Contains(hash) && !_rows.ContainsKey(hash))
            {
                _watched.Remove(hash);
                continue;
            }
            if (_rows.TryGetValue(hash, out var row))
            {
                if (IsTerminal(row))
                {
                    _watched.Remove(hash);
                }
                else if (walkComplete)
                {
                    var closesAt = row.ExpiresAt is { } expiresAt
                        ? expiresAt + ExpiryGraceSeconds
                        : (row.CreatedAt ?? watch.WatchedAt) + (long)Window.TotalSeconds;
                    if (closesAt <= now) _watched.Remove(hash);
                }
            }
            else if (walkComplete && watch.WatchedAt + (long)Window.TotalSeconds <= now)
            {
                _watched.Remove(hash);
            }
        }
        var horizon = now - (long)Window.TotalSeconds;
        foreach (var hash in _rows.Keys.Where(hash => !_watched.ContainsKey(hash) && _touched.GetValueOrDefault(hash, long.MinValue) < horizon).ToList())
        {
            _rows.Remove(hash);
            _touched.Remove(hash);
            _settledAnnounced.Remove(hash);
        }
    }

    private static bool IsTerminal(NwcTransaction row) =>
        Settlement.IsSettled(row) || Settlement.IsExpired(row) || Settlement.IsFailed(row);

    private void NoteMinted(long createdAt)
    {
        _newestMintedAt = _newestMintedAt is { } current ? Math.Max(current, createdAt) : createdAt;
    }

    private void Upsert(NwcTransaction transaction)
    {
        var hash = transaction.PaymentHash!;
        if (_rows.TryGetValue(hash, out var existing))
        {
            if (Settlement.IsSettled(existing) && !Settlement.IsSettled(transaction))
            {
                return; // a settled fact is final
            }
            // A sparse row (a notification without created_at, a lookup without the invoice)
            // never erases what the memo already knows about the same hash.
            transaction = transaction with
            {
                Invoice = transaction.Invoice ?? existing.Invoice,
                AmountMsats = transaction.AmountMsats ?? existing.AmountMsats,
                CreatedAt = transaction.CreatedAt ?? existing.CreatedAt,
                ExpiresAt = transaction.ExpiresAt ?? existing.ExpiresAt,
                Description = transaction.Description ?? existing.Description,
                DescriptionHash = transaction.DescriptionHash ?? existing.DescriptionHash,
            };
        }
        _rows[hash] = transaction;
        _touched[hash] = _clock();
        // Only a watched hash is announced: BTCPay listens for the invoices it asked about, and
        // every other row on a page is somebody else's business.
        if (Settlement.IsSettled(transaction) && _watched.ContainsKey(hash) && _settledAnnounced.Add(hash))
        {
            _newlySettled.Enqueue(transaction);
        }
    }
}
