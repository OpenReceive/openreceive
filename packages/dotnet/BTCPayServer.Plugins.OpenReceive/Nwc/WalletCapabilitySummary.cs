#nullable enable
using System.Collections.Generic;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// What one NWC connection can do, read from the wallet's own <c>get_info</c> reply and
/// the kind-13194 info event. Never carries the secret.
/// </summary>
public sealed record WalletCapabilitySummary
{
    public required string WalletPubkey { get; init; }
    public required IReadOnlyList<string> Relays { get; init; }
    /// <summary>Normalized snake_case method names.</summary>
    public required IReadOnlyList<string> Methods { get; init; }
    /// <summary>"nip44_v2" or "nip04"; null when the wallet advertises modes and none is one we speak.</summary>
    public string? Encryption { get; init; }
    public required bool SpendCapabilityAdvertised { get; init; }
    public required bool ReceiveCheckoutReady { get; init; }
    public required IReadOnlyList<string> Warnings { get; init; }
    /// <summary>The spend methods found, in the order the wallet listed them.</summary>
    public required IReadOnlyList<string> SpendMethods { get; init; }
    /// <summary>The required receive methods the wallet does not grant (empty when ready).</summary>
    public required IReadOnlyList<string> MissingMethods { get; init; }
    /// <summary>Notification types the wallet advertises (e.g. payment_received).</summary>
    public IReadOnlyList<string> Notifications { get; init; } = System.Array.Empty<string>();
    /// <summary>The wallet's own network word (mainnet, testnet, signet, regtest) when get_info reported one.</summary>
    public string? Network { get; init; }
}

/// <summary>The kind-13194 info event, as the relay handed it over.</summary>
public sealed record NwcServiceInfo(
    IReadOnlyList<string> Methods,
    IReadOnlyList<string> Notifications,
    IReadOnlyList<string> EncryptionSchemes);
