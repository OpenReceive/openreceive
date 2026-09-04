#nullable enable
using System.Collections.Generic;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// One wallet transaction row, normalized at the client boundary (the C# twin of
/// core's <c>NwcTransaction</c>). Absent means absent: a wallet's empty string is
/// "no value", never an empty value. Every timestamp is whole unix seconds; every
/// amount is whole millisatoshis.
/// </summary>
public sealed record NwcTransaction
{
    /// <summary>"incoming" or "outgoing" when the wallet said which.</summary>
    public string? Type { get; init; }
    public string? Invoice { get; init; }
    /// <summary>64 lowercase hex characters when present.</summary>
    public string? PaymentHash { get; init; }
    public long? AmountMsats { get; init; }
    /// <summary>
    /// The normalized state ("pending", "settled", "expired", "failed", "accepted"),
    /// mapped from the wallet's <c>transaction_state</c> / <c>state</c> / boolean flags.
    /// </summary>
    public string? TransactionState { get; init; }
    /// <summary>The wallet's raw <c>state</c> field when it carried one (settlement reads both keys).</summary>
    public string? State { get; init; }
    public long? CreatedAt { get; init; }
    public long? ExpiresAt { get; init; }
    public long? SettledAt { get; init; }
    public string? Preimage { get; init; }
    public string? Description { get; init; }
    public string? DescriptionHash { get; init; }
    public long? FeesPaidMsats { get; init; }
}

public sealed record MakeInvoiceRequest
{
    public required long AmountMsats { get; init; }
    public string? Description { get; init; }
    public string? DescriptionHash { get; init; }
    /// <summary>Requested invoice lifetime in seconds.</summary>
    public int? Expiry { get; init; }
    /// <summary>Serialized JSON object, when the caller attached metadata.</summary>
    public string? MetadataJson { get; init; }
}

public sealed record MakeInvoiceResult
{
    public required string Invoice { get; init; }
    public required string PaymentHash { get; init; }
    public required long AmountMsats { get; init; }
    public long? CreatedAt { get; init; }
    public long? ExpiresAt { get; init; }
}

public sealed record ListTransactionsRequest
{
    public long? From { get; init; }
    public long? Until { get; init; }
    public int? Limit { get; init; }
    public int? Offset { get; init; }
    public bool? Unpaid { get; init; }
    /// <summary>"incoming" or "outgoing".</summary>
    public string? Type { get; init; }
}

public sealed record ListTransactionsResult
{
    public required IReadOnlyList<NwcTransaction> Transactions { get; init; }
    /// <summary>Rows on this page that could not be normalized and were dropped.</summary>
    public int SkippedRows { get; init; }
}

/// <summary>A normalized NWC-02 wallet notification.</summary>
public sealed record NwcWalletNotification
{
    public required string Type { get; init; }
    public string? PaymentHash { get; init; }
    public NwcTransaction? Transaction { get; init; }
}
