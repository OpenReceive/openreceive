#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>One page of the wallet's history (the client's <c>list_transactions</c>).</summary>
public delegate Task<ListTransactionsResult> ListTransactionsPage(ListTransactionsRequest request, CancellationToken cancellationToken);

/// <summary>A pending attempt to reconcile: its hash and the exact NIP-47 invoice creation time.</summary>
public sealed record ReconcileAttempt(string PaymentHash, long CreatedAt);

/// <summary>
/// What one scan found for one hash. <see cref="Status"/> is settled, pending, expired, failed,
/// or not_found (proven absent by a complete walk). <see cref="PaymentHash"/> is normalized
/// (trimmed, lowercase). <see cref="Transaction"/> is null only for not_found.
/// </summary>
public sealed record PaymentCheck(string PaymentHash, string Status, long? PaidAt, NwcTransaction? Transaction, long ObservedAt);

/// <summary>
/// The rows one walk saw, keyed by normalized hash. <see cref="Truncated"/> means the walk
/// ended before the wallet ran out of rows — the page cap was hit, or the wallet ignored
/// <c>offset</c> and repeated a page — so a hash it did not see is unproven, never proven absent.
/// </summary>
public sealed record WalletWalk(IReadOnlyDictionary<string, NwcTransaction> ByPaymentHash, bool Truncated);

/// <summary>
/// The truncation-safe wallet-history walk — the C# twin of <c>reconcilePaymentAttempts</c> and
/// <c>listIncomingTransactions</c> in <c>packages/js/core/src/payments.ts</c>.
/// </summary>
public static class WalletScan
{
    private const int DefaultMaxPages = 10_000;
    private static readonly Regex LowerHex64 = new("^[0-9a-f]{64}$", RegexOptions.Compiled);

    /// <summary>
    /// Reconcile many attempts with at most two walks: the settled/default view first, then the
    /// inclusive unpaid view for whatever is still missing. Attempts that normalize to the same
    /// hash collapse into one result, so match results by hash, never by index. A hash a
    /// truncated walk could not decide is OMITTED rather than reported not_found: absence is
    /// unproven, and not_found would let a caller close a paid attempt.
    /// </summary>
    public static async Task<IReadOnlyList<PaymentCheck>> ReconcileAsync(
        ListTransactionsPage list,
        IReadOnlyList<ReconcileAttempt> attempts,
        Func<long> clock,
        int? maxPages = null,
        int overlapSeconds = 60,
        long? until = null,
        Action<(long From, long Until, bool IncludeUnpaid)>? onWalk = null,
        CancellationToken ct = default)
    {
        if (attempts.Count == 0) return Array.Empty<PaymentCheck>();
        if (overlapSeconds < 0) throw new ArgumentOutOfRangeException(nameof(overlapSeconds), "overlapSeconds must be a non-negative integer");

        var expected = new Dictionary<string, long>();
        foreach (var attempt in attempts)
        {
            expected[NormalizePaymentHash(attempt.PaymentHash)] = NormalizeUnix(attempt.CreatedAt, "createdAt");
        }
        var from = Math.Max(0, expected.Values.Min() - overlapSeconds);
        // Both ends of the window are padded: `from` against a wallet clock that lags, `until`
        // against one that runs ahead.
        var untilSeconds = until ?? clock() + overlapSeconds;

        onWalk?.Invoke((from, untilSeconds, false));
        var settled = await WalkAsync(list, from, untilSeconds, includeUnpaid: false, expected.Keys.ToHashSet(), maxPages, ct);
        var byHash = new Dictionary<string, NwcTransaction>(settled.ByPaymentHash);
        var missing = expected.Keys.Where(hash => !byHash.ContainsKey(hash)).ToHashSet();
        var truncated = false;
        if (missing.Count > 0)
        {
            onWalk?.Invoke((from, untilSeconds, true));
            var inclusive = await WalkAsync(list, from, untilSeconds, includeUnpaid: true, missing, maxPages, ct);
            truncated = settled.Truncated || inclusive.Truncated;
            foreach (var (hash, transaction) in inclusive.ByPaymentHash)
            {
                byHash.TryAdd(hash, transaction);
            }
        }

        var observedAt = clock();
        var checks = new List<PaymentCheck>();
        foreach (var hash in expected.Keys)
        {
            if (!byHash.TryGetValue(hash, out var transaction))
            {
                if (truncated) continue;
                checks.Add(new PaymentCheck(hash, "not_found", null, null, observedAt));
                continue;
            }
            checks.Add(CheckFromTransaction(hash, transaction, observedAt));
        }
        return checks;
    }

    /// <summary>
    /// Walk incoming rows in the window, <see cref="OpenReceiveTables.TransactionPageLimit"/> at a
    /// time. With <paramref name="expected"/> the walk stops once every hash is seen; with null it
    /// runs until the wallet runs out of rows or the page cap (the plugin's scan memo uses this).
    /// </summary>
    public static async Task<WalletWalk> WalkAsync(
        ListTransactionsPage list,
        long? from,
        long? until,
        bool includeUnpaid,
        IReadOnlySet<string>? expected,
        int? maxPages,
        CancellationToken ct)
    {
        var pageCap = maxPages ?? DefaultMaxPages;
        if (pageCap <= 0) throw new ArgumentOutOfRangeException(nameof(maxPages), "maxPages must be a positive integer");
        var byPaymentHash = new Dictionary<string, NwcTransaction>();
        var outstanding = expected is null ? null : new HashSet<string>(expected);
        var offset = 0;
        string? previousPage = null;
        // Proven false the moment the wallet runs out of rows or every expected hash is accounted
        // for; otherwise the walk hit its cap with rows still to come.
        var truncated = true;

        for (var pageNumber = 0; pageNumber < pageCap; pageNumber += 1)
        {
            var request = new ListTransactionsRequest
            {
                Type = "incoming",
                Limit = OpenReceiveTables.TransactionPageLimit,
                Offset = offset,
                Unpaid = includeUnpaid ? true : null,
                From = from is { } f ? NormalizeUnix(f, "from") : null,
                Until = until is { } u ? NormalizeUnix(u, "until") : null,
            };
            var page = await list(request, ct);
            foreach (var transaction in page.Transactions)
            {
                if (transaction.Type is not null && transaction.Type != "incoming") continue;
                var hash = NormalizedTransactionHash(transaction);
                if (hash is null) continue;
                byPaymentHash[hash] = transaction;
                outstanding?.Remove(hash);
            }
            if (outstanding is { Count: 0 })
            {
                truncated = false;
                break;
            }
            if (page.Transactions.Count < OpenReceiveTables.TransactionPageLimit)
            {
                truncated = false;
                break;
            }
            // A wallet that ignores `offset` serves the same page forever; stop instead of paging
            // to the cap, and keep the scan marked incomplete.
            var pageKey = string.Join(",", page.Transactions.Select(t => t.PaymentHash ?? ""));
            if (pageKey == previousPage) break;
            previousPage = pageKey;
            offset += OpenReceiveTables.TransactionPageLimit;
        }
        return new WalletWalk(byPaymentHash, truncated);
    }

    /// <summary>
    /// The BTCPay <c>LightningInvoiceStatus</c> word for one check. "Paid" when the wallet settled
    /// it; "Expired" ONLY when the wallet's own row says expired or failed; "Unpaid" otherwise.
    /// BTCPay owns invoice expiry: it stops watching a hash the moment a listener returns null or
    /// Expired, so not_found and pending — even long after expiry plus grace — never map to
    /// Expired here. Closing an attempt on time alone is BTCPay's decision, made on its own clock.
    /// </summary>
    public static string LightningStatusFor(PaymentCheck check) => check.Status switch
    {
        "settled" => "Paid",
        "expired" or "failed" => "Expired",
        _ => "Unpaid",
    };

    private static PaymentCheck CheckFromTransaction(string hash, NwcTransaction transaction, long observedAt)
    {
        var status = Settlement.Classify(transaction).Status;
        var paidAt = status == "settled" ? transaction.SettledAt ?? observedAt : (long?)null;
        return new PaymentCheck(hash, status, paidAt, transaction, observedAt);
    }

    private static string NormalizePaymentHash(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        if (!LowerHex64.IsMatch(normalized)) throw new ArgumentException("paymentHash must be 64 hexadecimal characters");
        return normalized;
    }

    /// <summary>The scan key for one wallet row, or null when the row can never match an attempt.</summary>
    private static string? NormalizedTransactionHash(NwcTransaction transaction)
    {
        if (transaction.PaymentHash is null) return null;
        var hash = transaction.PaymentHash.Trim().ToLowerInvariant();
        return LowerHex64.IsMatch(hash) ? hash : null;
    }

    private static long NormalizeUnix(long value, string field)
    {
        if (value < 0) throw new ArgumentOutOfRangeException(field, $"{field} must be a non-negative integer");
        return value;
    }
}
