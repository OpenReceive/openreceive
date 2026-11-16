#nullable enable
using System;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// What one provider allows an API key per window, as far as the request guard needs to
/// know it. The guard exists so a busy store stays inside the provider's limits; the
/// provider remains the authority and its 429 always wins.
/// </summary>
/// <param name="Profile">Whose published limits these are.</param>
/// <param name="SoftCap">Weight every call in one window may add up to.</param>
/// <param name="CreateGate">Weight a create may bring the window up to.</param>
/// <param name="CreateLimit">Creates per window, for a provider that counts them on their own.</param>
/// <param name="BackoffSeconds">Stand-off after a 429 that names no wait.</param>
/// <param name="MinBackoffSeconds">Shortest stand-off a 429's own wait is honored for.</param>
/// <param name="MaxBackoffSeconds">Longest stand-off a 429's own wait is honored for.</param>
/// <param name="CreateBackoffOnly">
/// True when the provider counts new swaps apart from its other calls, so a 429 answering
/// a create stops creates only. Status and refund calls for swaps that already exist keep
/// working.
/// </param>
public sealed record SwapProviderLimits(
    string Profile,
    int SoftCap,
    int CreateGate,
    int CreateWeight,
    int DefaultWeight,
    int? CreateLimit,
    int BackoffSeconds,
    int MinBackoffSeconds,
    int MaxBackoffSeconds,
    bool CreateBackoffOnly)
{
    public const string FixedFloatProfile = "fixedfloat";
    public const string LightningSwapProfile = "lightning-swap";

    private const string LightningSwapHost = "lightning-swap.com";

    /// <summary>
    /// FixedFloat: 250 weight a minute per key, a create costs 50, and going over blocks the
    /// key for longer each time. The guard stops well short: three creates a minute, 200
    /// weight in all. Also the default for a provider this plugin does not know, because it
    /// is the stricter of the two.
    /// </summary>
    public static readonly SwapProviderLimits FixedFloat = new(
        FixedFloatProfile,
        SoftCap: SwapProviderWeightBudget.SoftCap,
        CreateGate: SwapProviderWeightBudget.CreateWeightGate,
        CreateWeight: SwapProviderWeightBudget.CreateWeight,
        DefaultWeight: SwapProviderWeightBudget.DefaultWeight,
        CreateLimit: null,
        BackoffSeconds: SwapProviderWeightBudget.BackoffSeconds,
        MinBackoffSeconds: SwapProviderWeightBudget.BackoffSeconds,
        MaxBackoffSeconds: 3_600,
        CreateBackoffOnly: false);

    /// <summary>
    /// Lightning Swap: per account, 30 new swaps and 400 API calls a minute once the account
    /// has completed a swap, every call counting as one. It refuses with a 429 that says how
    /// long to wait and never blocks a key for going over, so the guard sits at the limit
    /// itself. An account on lower limits (one that has not completed a swap yet) is held to
    /// them by the provider's own 429, which this guard then obeys.
    /// </summary>
    public static readonly SwapProviderLimits LightningSwap = new(
        LightningSwapProfile,
        SoftCap: 400,
        CreateGate: 400,
        CreateWeight: 1,
        DefaultWeight: 1,
        CreateLimit: 30,
        BackoffSeconds: 60,
        MinBackoffSeconds: 1,
        MaxBackoffSeconds: 300,
        CreateBackoffOnly: true);

    /// <summary>
    /// The limits to guard a provider API with, chosen by its HTTPS host: Lightning Swap's
    /// own host or a subdomain of it; anything else, an unparsable URL included, gets the
    /// FixedFloat limits.
    /// </summary>
    public static SwapProviderLimits ForBaseUrl(string? baseUrl)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri)) return FixedFloat;
        var host = uri.Host.ToLowerInvariant();
        return host == LightningSwapHost || host.EndsWith("." + LightningSwapHost, StringComparison.Ordinal)
            ? LightningSwap
            : FixedFloat;
    }
}

/// <summary>Why a request was denied by the process-local weight budget.</summary>
/// <param name="Reason"><c>exhausted</c> or <c>backoff</c>.</param>
/// <param name="BackoffUntil">For a <c>backoff</c> denial, the unix second the stand-off ends.</param>
/// <param name="Creates">Creates counted in the window, for a provider that limits them on their own.</param>
/// <param name="CreateLimit">That provider's creates per window.</param>
public sealed record SwapWeightBudgetDenial(
    string Provider,
    string Path,
    string Reason,
    string Message,
    int Used,
    int Cost,
    int Gate,
    long WindowStart,
    long? BackoffUntil,
    int? Creates = null,
    int? CreateLimit = null);

/// <summary>
/// Thrown by <see cref="SwapProviderWeightBudget.Reserve"/> and
/// <see cref="SwapProviderWeightBudget.AssertAvailable"/>; carries its own diagnostics.
/// </summary>
public sealed class SwapWeightBudgetException : Exception
{
    public SwapWeightBudgetDenial Denial { get; }

    public SwapWeightBudgetException(SwapWeightBudgetDenial denial) : base(denial.Message)
    {
        Denial = denial;
    }

    public string Provider => Denial.Provider;
    public string Path => Denial.Path;
    public string Reason => Denial.Reason;
    public int Used => Denial.Used;
    public int Cost => Denial.Cost;
    public int Gate => Denial.Gate;
    public long WindowStart => Denial.WindowStart;
    public long? BackoffUntil => Denial.BackoffUntil;
    public int? Creates => Denial.Creates;
    public int? CreateLimit => Denial.CreateLimit;

    /// <summary>
    /// The unix second a call refused with this denial can be tried again: the end of the
    /// stand-off, or the moment the window rolls.
    /// </summary>
    public long RetryAt => Reason == SwapProviderWeightBudget.ReasonBackoff && BackoffUntil is { } backoffUntil
        ? backoffUntil
        : WindowStart + SwapProviderWeightBudget.WindowSeconds;
}

/// <summary>Disposable per-process request guard; the provider remains global rate-limit authority.</summary>
public sealed class SwapProviderWeightBudget : ISwapWeightBudget
{
    public const int WindowSeconds = 60;
    // The FixedFloat numbers (SwapProviderLimits.FixedFloat), the default sizing.
    public const int SoftCap = 200;
    public const int CreateWeightGate = 150;
    public const int CreateWeight = 50;
    public const int DefaultWeight = 1;
    public const int BackoffSeconds = 60;

    public const string ReasonExhausted = "exhausted";
    public const string ReasonBackoff = "backoff";

    private const string CreatePath = "create";

    private readonly string _providerId;
    private readonly Func<long> _now;
    private readonly object _gate = new();
    private long _windowStart;
    private int _used;
    private int _creates;
    private long? _backoffUntil;
    private long? _createBackoffUntil;

    /// <param name="limits">The provider's limits; null means the FixedFloat defaults.</param>
    public SwapProviderWeightBudget(string providerId, Func<long> now, SwapProviderLimits? limits = null)
    {
        _providerId = providerId;
        _now = now;
        Limits = limits ?? SwapProviderLimits.FixedFloat;
        _windowStart = now();
    }

    public SwapProviderLimits Limits { get; }

    public int WeightForPath(string path) => path == CreatePath ? Limits.CreateWeight : Limits.DefaultWeight;

    private int GateForPath(string path) => path == CreatePath ? Limits.CreateGate : Limits.SoftCap;

    /// <summary>
    /// Throw the same denial <see cref="Reserve"/> would, without using any budget. Lets a
    /// caller refuse a new swap before it does any other work for it.
    /// </summary>
    public void AssertAvailable(string path)
    {
        lock (_gate)
        {
            Check(path);
        }
    }

    public void Reserve(string path)
    {
        lock (_gate)
        {
            Check(path);
            _used += WeightForPath(path);
            if (path == CreatePath) _creates += 1;
        }
    }

    public void MarkRateLimited(string? path = null, double? retryAfterSeconds = null)
    {
        lock (_gate)
        {
            var until = _now() + BackoffSecondsFor(retryAfterSeconds);
            if (Limits.CreateBackoffOnly && path == CreatePath)
            {
                _createBackoffUntil = Math.Max(_createBackoffUntil ?? 0, until);
                return;
            }
            var backoffUntil = Math.Max(_backoffUntil ?? 0, until);
            _backoffUntil = backoffUntil;
            // The provider's own window is spent until then and fresh after it, so this
            // guard's window restarts when the stand-off ends. Keeping the old count would
            // go on refusing calls the provider has started accepting.
            _windowStart = backoffUntil;
            _used = 0;
            _creates = 0;
        }
    }

    private void Check(string path)
    {
        RollWindow();
        var now = _now();
        var cost = WeightForPath(path);
        var gate = GateForPath(path);
        if (ActiveBackoff(path, now) is { } backoffUntil)
        {
            Deny(path, ReasonBackoff, cost, gate, $"Swap provider API is in backoff until {backoffUntil}.", backoffUntil);
        }
        if (_used + cost > gate)
        {
            Deny(path, ReasonExhausted, cost, gate, $"Swap provider API weight budget exhausted ({_used}+{cost} > {gate}).");
        }
        if (path == CreatePath && Limits.CreateLimit is { } createLimit && _creates + 1 > createLimit)
        {
            Deny(path, ReasonExhausted, cost, gate, $"Swap provider create budget exhausted ({_creates}+1 > {createLimit}).");
        }
    }

    /// <summary>
    /// The provider's own wait, rounded up and kept inside the profile's bounds; the
    /// profile's stand-off when the provider named none.
    /// </summary>
    private int BackoffSecondsFor(double? retryAfterSeconds)
    {
        if (retryAfterSeconds is not { } wait || !double.IsFinite(wait) || wait <= 0) return Limits.BackoffSeconds;
        return (int)Math.Min(Math.Max(Math.Ceiling(wait), Limits.MinBackoffSeconds), Limits.MaxBackoffSeconds);
    }

    private long? ActiveBackoff(string path, long now)
    {
        if (_backoffUntil is { } all && all > now) return all;
        if (path == CreatePath && _createBackoffUntil is { } creates && creates > now) return creates;
        return null;
    }

    // The weight window rolls; the 429 backoff does NOT ride along with it — it
    // expires on its own clock, checked in Check().
    private void RollWindow()
    {
        var now = _now();
        if (now - _windowStart < WindowSeconds) return;
        _windowStart = now;
        _used = 0;
        _creates = 0;
    }

    private void Deny(string path, string reason, int cost, int gate, string message, long? backoffUntil = null) =>
        throw new SwapWeightBudgetException(new SwapWeightBudgetDenial(
            _providerId, path, reason, message, _used, cost, gate, _windowStart, backoffUntil ?? _backoffUntil,
            Limits.CreateLimit is null ? null : _creates, Limits.CreateLimit));
}
