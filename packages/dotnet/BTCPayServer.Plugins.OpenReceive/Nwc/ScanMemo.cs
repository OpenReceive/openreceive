#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Generated;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// The per-connection wallet-history memo: the JS/Ruby <c>openreceive_meta</c> scan
/// gate transplanted into process memory. One <c>list_transactions</c> walk over a fixed
/// window (<see cref="Window"/>, settled view then unpaid view, pages of
/// <see cref="OpenReceiveTables.TransactionPageLimit"/>, deduped by hash,
/// truncation-safe) refreshes it for EVERY caller: BTCPay's GetInvoice on creation,
/// on startup for each pending invoice and after a re-mint all read the same memo, and
/// a cold or stale memo pays one walk, never one per hash. The refresh cadence stretches
/// with the age of the newest invoice this process minted (2 s / 6 s / 12 s) and IS the
/// NWC scan budget for the connection, exactly as the durable gate is for the other
/// engines. It is a cache of wallet truth, not state: two BTCPay workers each hold one.
/// </summary>
public sealed class ScanMemo
{
    public static readonly TimeSpan Window = TimeSpan.FromHours(24);
    public const int OverlapSeconds = 60;
    public const int MaxPagesPerView = 25;

    private readonly ListTransactionsPage _list;
    private readonly Func<long> _clock;
    private readonly ILogger _logger;
    private readonly object _gate = new();
    private readonly Dictionary<string, NwcTransaction> _rows = new(StringComparer.Ordinal);
    private readonly HashSet<string> _settledAnnounced = new(StringComparer.Ordinal);
    private readonly Queue<NwcTransaction> _newlySettled = new();
    private Task? _inflight;
    private long _refreshedAt = long.MinValue;
    private bool _complete;
    private long? _newestMintedAt;

    public ScanMemo(ListTransactionsPage list, Func<long> clock, ILogger logger)
    {
        _list = list;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>When this memo last finished a walk (unix seconds), or null before the first.</summary>
    public long? RefreshedAt => _refreshedAt == long.MinValue ? null : _refreshedAt;

    /// <summary>False while the last walk hit its page cap or a wallet that ignores offset.</summary>
    public bool Complete => _complete;

    /// <summary>Called by the client after every make_invoice so the cadence tracks live checkouts.</summary>
    public void NoteInvoiceMinted(long createdAt)
    {
        lock (_gate)
        {
            _newestMintedAt = _newestMintedAt is { } current ? Math.Max(current, createdAt) : createdAt;
        }
    }

    /// <summary>
    /// The refresh interval: 2 s while the newest invoice this process minted is under
    /// two minutes old, 6 s under five minutes, else 12 s (settlement-sweeps.md numbers;
    /// a cadence heuristic, never a correctness input).
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

    /// <summary>Refreshes when stale (older than <see cref="CurrentInterval"/>) or forced; concurrent callers share one walk.</summary>
    public Task RefreshAsync(bool force, CancellationToken cancellationToken)
    {
        Task work;
        lock (_gate)
        {
            if (_inflight is { IsCompleted: false } running)
            {
                work = running;
            }
            else
            {
                var stale = _refreshedAt == long.MinValue || _clock() - _refreshedAt >= (long)CurrentInterval.TotalSeconds;
                if (!force && !stale) return Task.CompletedTask;
                work = _inflight = WalkAsync(cancellationToken);
            }
        }
        return work;
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

    private async Task WalkAsync(CancellationToken cancellationToken)
    {
        var now = _clock();
        var from = Math.Max(0, now - (long)Window.TotalSeconds);
        var until = now + OverlapSeconds;
        var settled = await WalletScan.WalkAsync(_list, from, until, includeUnpaid: false, expected: null, MaxPagesPerView, cancellationToken).ConfigureAwait(false);
        var unpaid = await WalletScan.WalkAsync(_list, from, until, includeUnpaid: true, expected: null, MaxPagesPerView, cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            foreach (var row in unpaid.ByPaymentHash.Values) Upsert(row);
            foreach (var row in settled.ByPaymentHash.Values) Upsert(row);
            _complete = !settled.Truncated && !unpaid.Truncated;
            _refreshedAt = _clock();
        }
        _logger.LogDebug("nwc.scan.memo settled_rows={Settled} unpaid_rows={Unpaid} complete={Complete}",
            settled.ByPaymentHash.Count, unpaid.ByPaymentHash.Count, _complete);
    }

    private void Upsert(NwcTransaction transaction)
    {
        var hash = transaction.PaymentHash!;
        if (_rows.TryGetValue(hash, out var existing) && Settlement.IsSettled(existing) && !Settlement.IsSettled(transaction))
        {
            return; // a settled fact is final
        }
        _rows[hash] = transaction;
        if (Settlement.IsSettled(transaction) && _settledAnnounced.Add(hash))
        {
            _newlySettled.Enqueue(transaction);
        }
    }
}
