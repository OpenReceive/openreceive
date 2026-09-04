namespace OpenReceive.TestkitNwc;

/// <summary>What the wallet service advertises and which wallet quirks it simulates.</summary>
public sealed record TestkitWalletOptions
{
    public static readonly IReadOnlyList<string> DefaultMethods =
        ["get_info", "make_invoice", "lookup_invoice", "list_transactions", "get_balance", "notifications"];

    public static readonly IReadOnlyList<string> DefaultEncryptionSchemes = ["nip44_v2", "nip04"];

    /// <summary>Methods the testkit really serves.</summary>
    public IReadOnlyList<string> Methods { get; init; } = DefaultMethods;

    /// <summary>
    /// Methods advertised (info event, get_info) but never executed — every call answers
    /// NOT_IMPLEMENTED. Use ["pay_invoice"] to exercise a client's spend-capable fail-closed path.
    /// </summary>
    public IReadOnlyList<string> ExtraGrantedMethods { get; init; } = [];

    /// <summary>
    /// Schemes in the info event's `encryption` tag. ["nip04"] forces clients to the fallback;
    /// an empty list omits the tag entirely (a pre-NIP-44 wallet).
    /// </summary>
    public IReadOnlyList<string> EncryptionSchemes { get; init; } = DefaultEncryptionSchemes;

    /// <summary>Advertise and push `payment_received` notifications.</summary>
    public bool Notifications { get; init; } = true;

    /// <summary>Simulate a wallet that ignores list_transactions `offset`: every page is page 0.</summary>
    public bool DropOffset { get; init; }

    /// <summary>Upper bound applied to list_transactions `limit` (and its default).</summary>
    public int PageLimitCap { get; init; } = 20;

    public string? Lud16 { get; init; }

    /// <summary>Seconds added to the requested make_invoice expiry, to provoke a client's expiry check.</summary>
    public int? ExpirySecondsDelta { get; init; }

    /// <summary>Every method a connection may call: the served ones plus the never-executed grants.</summary>
    public IReadOnlyList<string> GrantedMethods => Methods.Concat(ExtraGrantedMethods).Distinct().ToList();
}
