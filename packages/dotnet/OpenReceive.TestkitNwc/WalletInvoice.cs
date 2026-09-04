namespace OpenReceive.TestkitNwc;

/// <summary>NIP-47 invoice states the testkit reports (a subset of the spec's `state` values).</summary>
public static class InvoiceState
{
    public const string Pending = "pending";
    public const string Settled = "settled";
    public const string Expired = "expired";
}

/// <summary>One incoming invoice as the wallet backend knows it. Timestamps are unix seconds.</summary>
public sealed record WalletInvoice
{
    public required string PaymentHash { get; init; }
    public required string Bolt11 { get; init; }
    public required long AmountMsats { get; init; }
    public string? Description { get; init; }
    public string? DescriptionHash { get; init; }
    public string? Preimage { get; init; }
    public required long CreatedAt { get; init; }
    public required long ExpiresAt { get; init; }
    public long? SettledAt { get; init; }
    public required string State { get; init; }

    public bool IsSettled => State == InvoiceState.Settled;
}
