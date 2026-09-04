namespace OpenReceive.FakeLsc;

/// <summary>
/// Configuration for the fake Lightning Swap Connect provider. Every member has a
/// working default so <c>new FakeLscProviderCore(new FakeLscOptions())</c> is a
/// complete provider; hosts override the credentials, the clock and the payer.
/// </summary>
public sealed class FakeLscOptions
{
    /// <summary>The API key every signed request must carry in <c>X-API-KEY</c>.</summary>
    public string Key { get; init; } = "test-key";

    /// <summary>The HMAC-SHA256 secret behind <c>X-API-SIGN</c>.</summary>
    public string Secret { get; init; } = "test-secret";

    /// <summary>
    /// The OpenReceive pay-in assets this provider lists in <c>/ccies</c> and accepts at
    /// <c>/create</c>. Defaults to all seven.
    /// </summary>
    public IReadOnlyList<string> SupportedAssets { get; init; } = FakeLscAssets.PayInAssets;

    /// <summary>Unix-seconds clock behind order timestamps and expiry.</summary>
    public Func<long> Clock { get; init; } = static () => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    /// <summary>How long after <c>/create</c> an order's deposit window stays open.</summary>
    public int DepositWindowSeconds { get; init; } = 900;

    /// <summary>
    /// Per-asset deposit amount overrides keyed by OpenReceive pay-in asset (e.g.
    /// <c>USDT_TRON</c>). An asset without an entry derives its deposit amount from
    /// the fixed rate table in <see cref="FakeLscAssets"/>.
    /// </summary>
    public IReadOnlyDictionary<string, string> PayAmounts { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>
    /// Invoked once with the order's bolt11 when the order reaches <c>completed</c>.
    /// Runs fire-and-forget; a failure is logged and surfaced through
    /// <see cref="FakeLscProviderCore.LastPayerError"/>.
    /// </summary>
    public Func<string, CancellationToken, Task>? Payer { get; init; }

    /// <summary>
    /// When true (the default) every <c>/api/v2</c> call must carry the right key and
    /// signature; when false the headers are ignored.
    /// </summary>
    public bool VerifySignature { get; init; } = true;

    /// <summary>One line per API call and lifecycle event. Never receives the secret or an order token.</summary>
    public Action<string> Log { get; init; } = static _ => { };
}
