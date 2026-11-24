#nullable enable
using System;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// The per-window count the request guard keeps for a provider that needs one. Every call
/// adds its weight to the window; a create may bring the window up to the whole soft cap,
/// and the calls that are not creates (status, refund, catalog) may use only
/// <paramref name="NonCreateCap"/> of it between them, so open swap screens polling their
/// status never starve new swaps.
/// </summary>
/// <param name="SoftCap">Weight every call in one window may add up to.</param>
/// <param name="NonCreateCap">Weight the calls that are not creates may use between them in one window.</param>
public sealed record SwapProviderLocalBudget(int SoftCap, int NonCreateCap, int CreateWeight, int DefaultWeight);

/// <summary>
/// How the request guard treats one provider. The provider remains the authority: its 429
/// always starts a stand-off. Only FixedFloat's own host also gets a local count, because
/// FixedFloat blocks a key for going over; every other provider limits its own accounts and
/// says so with a 429.
/// </summary>
/// <param name="Profile"><c>fixedfloat</c> for FixedFloat's own host; <c>provider-only</c> for every other.</param>
/// <param name="LocalBudget">The per-window count, or null when the guard keeps none and only obeys the provider's 429.</param>
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
    SwapProviderLocalBudget? LocalBudget,
    int BackoffSeconds,
    int MinBackoffSeconds,
    int MaxBackoffSeconds,
    bool CreateBackoffOnly)
{
    public const string FixedFloatProfile = "fixedfloat";
    public const string ProviderOnlyProfile = "provider-only";

    private const string FixedFloatHost = "ff.io";

    /// <summary>
    /// FixedFloat: 250 weight a minute per key, a create costs 50, and going over blocks the
    /// key for longer each time. So the guard counts: 200 weight a minute in all, of which the
    /// calls that are not creates may use 50. At least three creates a minute always fit, four
    /// when nothing else ran. A 429 stops every call for at least a minute.
    /// </summary>
    public static readonly SwapProviderLimits FixedFloat = new(
        FixedFloatProfile,
        LocalBudget: new SwapProviderLocalBudget(SoftCap: 200, NonCreateCap: 50, CreateWeight: 50, DefaultWeight: 1),
        BackoffSeconds: SwapProviderWeightBudget.BackoffSeconds,
        MinBackoffSeconds: SwapProviderWeightBudget.BackoffSeconds,
        MaxBackoffSeconds: 3_600,
        CreateBackoffOnly: false);

    /// <summary>
    /// Every other provider (Lightning Swap, one this plugin does not know, a test fake): no
    /// local count. The provider limits its own accounts and says so with a 429; a count of
    /// this plugin's own could only refuse payers the provider would have accepted. A 429
    /// that answered a create stops creates only, for the wait it names (1 to 300 seconds; a
    /// minute when it names none). Lightning Swap answers this way: it counts new swaps apart
    /// from its other calls, per account, and names the wait in <c>Retry-After</c>.
    /// </summary>
    public static readonly SwapProviderLimits ProviderOnly = new(
        ProviderOnlyProfile,
        LocalBudget: null,
        BackoffSeconds: 60,
        MinBackoffSeconds: 1,
        MaxBackoffSeconds: 300,
        CreateBackoffOnly: true);

    /// <summary>
    /// The limits to guard a provider API with, chosen by its HTTPS host: FixedFloat's own
    /// host or a subdomain of it is counted locally; anything else, an unparsable URL
    /// included, only obeys the provider's 429.
    /// </summary>
    public static SwapProviderLimits ForBaseUrl(string? baseUrl)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri)) return ProviderOnly;
        var host = uri.Host.ToLowerInvariant();
        return host == FixedFloatHost || host.EndsWith("." + FixedFloatHost, StringComparison.Ordinal)
            ? FixedFloat
            : ProviderOnly;
    }
}

/// <summary>Why a request was denied by the process-local weight budget.</summary>
/// <param name="Reason"><c>exhausted</c> or <c>backoff</c>.</param>
/// <param name="Used">Weight already used against <paramref name="Gate"/>; null for a guard that counts nothing.</param>
/// <param name="Gate">The cap that refused (or would refuse) the call; null for a guard that counts nothing.</param>
/// <param name="WindowStart">The counting window's start; null for a guard that counts nothing.</param>
/// <param name="BackoffUntil">For a <c>backoff</c> denial, the unix second the stand-off ends.</param>
public sealed record SwapWeightBudgetDenial(
    string Provider,
    string Path,
    string Reason,
    string Message,
    int? Used,
    int? Cost,
    int? Gate,
    long? WindowStart,
    long? BackoffUntil);

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
    public int? Used => Denial.Used;
    public int? Cost => Denial.Cost;
    public int? Gate => Denial.Gate;
    public long? WindowStart => Denial.WindowStart;
    public long? BackoffUntil => Denial.BackoffUntil;

    /// <summary>
    /// The unix second a call refused with this denial can be tried again: the end of the
    /// stand-off, or the moment the window rolls.
    /// </summary>
    public long RetryAt => Reason == SwapProviderWeightBudget.ReasonBackoff && BackoffUntil is { } backoffUntil
        ? backoffUntil
        : WindowStart.GetValueOrDefault() + SwapProviderWeightBudget.WindowSeconds;
}

/// <summary>Disposable per-process request guard; the provider remains global rate-limit authority.</summary>
public sealed class SwapProviderWeightBudget : ISwapWeightBudget
{
    public const int WindowSeconds = 60;
    public const int BackoffSeconds = 60;

    public const string ReasonExhausted = "exhausted";
    public const string ReasonBackoff = "backoff";

    private const string CreatePath = "create";

    private readonly string _providerId;
    private readonly Func<long> _now;
    private readonly object _gate = new();
    private long _windowStart;
    private int _used;
    private int _nonCreateUsed;
    private long? _backoffUntil;
    private long? _createBackoffUntil;

    /// <param name="limits">The provider's limits; null means no local count, only the provider's 429.</param>
    public SwapProviderWeightBudget(string providerId, Func<long> now, SwapProviderLimits? limits = null)
    {
        _providerId = providerId;
        _now = now;
        Limits = limits ?? SwapProviderLimits.ProviderOnly;
        _windowStart = now();
    }

    public SwapProviderLimits Limits { get; }

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
            if (Check(path) is not { } cost) return;
            _used += cost;
            if (path != CreatePath) _nonCreateUsed += cost;
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
            _nonCreateUsed = 0;
        }
    }

    /// <summary>Deny <paramref name="path"/>, or return what reserving it costs (null: nothing is counted).</summary>
    private int? Check(string path)
    {
        RollWindow();
        var budget = Limits.LocalBudget;
        if (ActiveBackoff(path, _now()) is { } backoffUntil)
        {
            Deny(path, ReasonBackoff, $"Swap provider API is in backoff until {backoffUntil}.",
                budget is null ? null : Weigh(path, budget), backoffUntil);
        }
        if (budget is null) return null;
        var cost = path == CreatePath ? budget.CreateWeight : budget.DefaultWeight;
        if (_used + cost > budget.SoftCap)
        {
            Deny(path, ReasonExhausted, $"Swap provider API weight budget exhausted ({_used}+{cost} > {budget.SoftCap}).",
                (_used, cost, budget.SoftCap));
        }
        if (path != CreatePath && _nonCreateUsed + cost > budget.NonCreateCap)
        {
            Deny(path, ReasonExhausted,
                $"Swap provider API weight budget for calls other than creates exhausted ({_nonCreateUsed}+{cost} > {budget.NonCreateCap}).",
                (_nonCreateUsed, cost, budget.NonCreateCap));
        }
        return cost;
    }

    /// <summary>Used, cost and gate for the cap <paramref name="path"/> is counted against.</summary>
    private (int Used, int Cost, int Gate) Weigh(string path, SwapProviderLocalBudget budget) =>
        path == CreatePath
            ? (_used, budget.CreateWeight, budget.SoftCap)
            : (_nonCreateUsed, budget.DefaultWeight, budget.NonCreateCap);

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
        _nonCreateUsed = 0;
    }

    private void Deny(string path, string reason, string message, (int Used, int Cost, int Gate)? weight = null, long? backoffUntil = null) =>
        throw new SwapWeightBudgetException(new SwapWeightBudgetDenial(
            _providerId, path, reason, message, weight?.Used, weight?.Cost, weight?.Gate,
            Limits.LocalBudget is null ? null : _windowStart, backoffUntil ?? _backoffUntil));
}
