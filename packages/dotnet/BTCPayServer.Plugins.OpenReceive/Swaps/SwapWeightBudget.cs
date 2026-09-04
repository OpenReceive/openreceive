#nullable enable
using System;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>Why a request was denied by the process-local weight budget.</summary>
/// <param name="Reason"><c>exhausted</c> or <c>backoff</c>.</param>
public sealed record SwapWeightBudgetDenial(
    string Provider,
    string Path,
    string Reason,
    string Message,
    int Used,
    int Cost,
    int Gate,
    long WindowStart,
    long? BackoffUntil);

/// <summary>Thrown by <see cref="SwapProviderWeightBudget.Reserve"/>; carries its own diagnostics.</summary>
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
}

/// <summary>Disposable per-process request guard; the provider remains global rate-limit authority.</summary>
public sealed class SwapProviderWeightBudget : ISwapWeightBudget
{
    public const int WindowSeconds = 60;
    public const int SoftCap = 200;
    public const int CreateWeightGate = 150;
    public const int CreateWeight = 50;
    public const int DefaultWeight = 1;
    public const int BackoffSeconds = 60;

    public const string ReasonExhausted = "exhausted";
    public const string ReasonBackoff = "backoff";

    private readonly string _providerId;
    private readonly Func<long> _now;
    private readonly object _gate = new();
    private long _windowStart;
    private int _used;
    private long? _backoffUntil;

    public SwapProviderWeightBudget(string providerId, Func<long> now)
    {
        _providerId = providerId;
        _now = now;
        _windowStart = now();
    }

    public static int WeightForPath(string path) => path == "create" ? CreateWeight : DefaultWeight;

    private static int GateForPath(string path) => path == "create" ? CreateWeightGate : SoftCap;

    public void Reserve(string path)
    {
        lock (_gate)
        {
            RollWindow();
            var now = _now();
            var cost = WeightForPath(path);
            var gate = GateForPath(path);
            if (_backoffUntil is { } backoffUntil && backoffUntil > now)
            {
                Deny(path, ReasonBackoff, cost, gate, $"Swap provider API is in backoff until {backoffUntil}.");
            }
            if (_used + cost > gate)
            {
                Deny(path, ReasonExhausted, cost, gate, $"Swap provider API weight budget exhausted ({_used}+{cost} > {gate}).");
            }
            _used += cost;
        }
    }

    public void MarkRateLimited()
    {
        lock (_gate)
        {
            var now = _now();
            _used = Math.Max(_used, SoftCap);
            _backoffUntil = now + BackoffSeconds;
        }
    }

    // The weight window rolls; the 429 backoff does NOT ride along with it — it
    // expires on its own clock, checked in Reserve().
    private void RollWindow()
    {
        var now = _now();
        if (now - _windowStart < WindowSeconds) return;
        _windowStart = now;
        _used = 0;
    }

    private void Deny(string path, string reason, int cost, int gate, string message) =>
        throw new SwapWeightBudgetException(new SwapWeightBudgetDenial(
            _providerId, path, reason, message, _used, cost, gate, _windowStart, _backoffUntil));
}
