#nullable enable
using System;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>What one wallet row says about its invoice: the C# twin of core's <c>TransactionSettlementDetection</c>.</summary>
/// <param name="Status">pending, settled, expired or failed.</param>
/// <param name="FinalitySignal">settled_at, transaction_state or state — the field that decided settlement.</param>
public sealed record SettlementDetection(bool Settled, string Status, string? FinalitySignal, bool PreimagePresent, long? SettledAt);

/// <summary>
/// The settlement rule — the C# twin of <c>isTransactionSettled</c> (core/nwc/client.ts) and
/// <c>classifyTransactionSettlement</c> (core/settlement/index.ts). A row is settled iff
/// <c>settled_at &gt; 0</c> or either state key says settled (case-insensitively); a preimage
/// alone never settles.
/// </summary>
public static class Settlement
{
    public static bool IsState(string? value, string expected) =>
        value is not null && string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);

    public static bool IsSettled(NwcTransaction transaction) =>
        transaction.SettledAt is > 0
        || IsState(transaction.TransactionState, "settled")
        || IsState(transaction.State, "settled");

    /// <summary>Same field precedence as <see cref="IsSettled"/>, so the reported signal is the one that fired.</summary>
    public static string? FinalitySignal(NwcTransaction transaction)
    {
        if (!IsSettled(transaction)) return null;
        if (transaction.SettledAt is > 0) return "settled_at";
        if (IsState(transaction.TransactionState, "settled")) return "transaction_state";
        if (IsState(transaction.State, "settled")) return "state";
        return null;
    }

    public static bool IsExpired(NwcTransaction transaction) =>
        IsState(transaction.State, "expired") || IsState(transaction.TransactionState, "expired");

    public static bool IsFailed(NwcTransaction transaction) =>
        IsState(transaction.State, "failed") || IsState(transaction.TransactionState, "failed");

    public static SettlementDetection Classify(NwcTransaction transaction)
    {
        var signal = FinalitySignal(transaction);
        var status = signal is not null ? "settled"
            : IsExpired(transaction) ? "expired"
            : IsFailed(transaction) ? "failed"
            : "pending";
        return new SettlementDetection(
            Settled: status == "settled",
            Status: status,
            FinalitySignal: signal,
            PreimagePresent: transaction.Preimage is not null,
            SettledAt: transaction.SettledAt);
    }
}
