#nullable enable
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Disposable, process-local provider catalog/rate cache (the C# twin of Node's
/// <c>TransientSwapCache</c>). It has no storage adapter: BTCPay workers each hold one,
/// and losing it costs one provider fetch. Failed refreshes serve the stale value for
/// a bounded time unless the caller forbids it (rates fail closed).
/// </summary>
public sealed class TransientSwapCache
{
    public const int LimitsMaxStaleSeconds = 48 * 60 * 60;
    public const int RefreshClaimSeconds = 60;
    public const int RatesRefreshSeconds = 15;
    public const int RatesMaxStaleSeconds = RatesRefreshSeconds;

    private sealed class State
    {
        public object? Value;
        public long? FetchedAt;
        public long? FailedAt;
        public string? Error;
    }

    private readonly Dictionary<string, State> _states = new();
    private readonly Dictionary<string, Task> _inflight = new();
    private readonly object _gate = new();
    private readonly Func<long> _clock;
    private readonly Action<string, string?>? _warn;

    public TransientSwapCache(Func<long> clock, Action<string, string?>? warn = null)
    {
        _clock = clock;
        _warn = warn;
    }

    public static string LimitsKey(string providerName) => $"swap_limits:{providerName}";
    public static string RatesKey(string providerName, string rateType = "fixed") => $"swap_rates:{providerName}:{rateType}";

    public sealed record ResolveOptions<T>(
        int RefreshSeconds,
        int MaxStaleSeconds,
        Func<CancellationToken, Task<T>> Fetch,
        int ClaimSeconds = RefreshClaimSeconds,
        bool ServeStaleOnFailure = true);

    public async Task<T> ResolveAsync<T>(string key, ResolveOptions<T> options, CancellationToken cancellationToken)
        where T : class
    {
        var now = _clock();
        Task<T> work;
        lock (_gate)
        {
            _states.TryGetValue(key, out var state);
            if (state?.Value is T fresh && state.FetchedAt is { } fetchedAt && now - fetchedAt < options.RefreshSeconds)
            {
                return fresh;
            }
            if (state?.FailedAt is { } failedAt && now - failedAt < options.ClaimSeconds)
            {
                return StaleOrThrow(key, state, now, options, null);
            }
            if (_inflight.TryGetValue(key, out var active))
            {
                work = (Task<T>)active;
            }
            else
            {
                work = RefreshAsync(key, state, now, options, cancellationToken);
                _inflight[key] = work;
            }
        }
        try
        {
            return await work.ConfigureAwait(false);
        }
        finally
        {
            lock (_gate)
            {
                if (_inflight.TryGetValue(key, out var current) && ReferenceEquals(current, work))
                {
                    _inflight.Remove(key);
                }
            }
        }
    }

    private async Task<T> RefreshAsync<T>(string key, State? previous, long now, ResolveOptions<T> options, CancellationToken cancellationToken)
        where T : class
    {
        try
        {
            var value = await options.Fetch(cancellationToken).ConfigureAwait(false);
            lock (_gate)
            {
                _states[key] = new State { Value = value, FetchedAt = now };
            }
            return value;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            var failed = new State
            {
                Value = previous?.Value,
                FetchedAt = previous?.FetchedAt,
                FailedAt = now,
                Error = error.Message,
            };
            lock (_gate)
            {
                _states[key] = failed;
            }
            return StaleOrThrow(key, failed, now, options, error);
        }
    }

    private T StaleOrThrow<T>(string key, State state, long now, ResolveOptions<T> options, Exception? cause)
        where T : class
    {
        if (options.ServeStaleOnFailure && state.Value is T stale && state.FetchedAt is { } fetchedAt && now - fetchedAt < options.MaxStaleSeconds)
        {
            _warn?.Invoke($"Serving stale swap provider data after refresh failed ({key}).", state.Error);
            return stale;
        }
        if (cause is not null) throw cause;
        throw new InvalidOperationException(state.Error ?? "Swap provider cache refresh failed.");
    }
}
