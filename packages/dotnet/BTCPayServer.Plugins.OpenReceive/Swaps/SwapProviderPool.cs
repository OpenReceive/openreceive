#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Settings;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Builds and caches one provider per LSC URI (primary + optional backup) per store, with
/// the process-local catalog/rates cache and request weight budget attached. Selection
/// rule: the primary unless it failed within the last minute, then the backup — "backup
/// only while the primary is down". Status refreshes and refunds address a provider by
/// the name persisted on the row.
/// </summary>
public sealed class SwapProviderPool
{
    public const int PrimaryDownSeconds = 60;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ISwapSettingsSource _settings;
    private readonly ILogger<SwapProviderPool> _logger;
    private readonly Func<long> _clock;
    private readonly ConcurrentDictionary<string, Entry> _providers = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _failedAt = new(StringComparer.Ordinal);

    private sealed record Entry(string LscUri, ISwapProvider Provider, LscConnection Connection);

    public SwapProviderPool(IHttpClientFactory httpClientFactory, ISwapSettingsSource settings, ILogger<SwapProviderPool> logger, Func<long>? clock = null)
    {
        _httpClientFactory = httpClientFactory;
        _settings = settings;
        _logger = logger;
        _clock = clock ?? (static () => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    }

    /// <summary>Configured providers for a store in preference order (primary first).</summary>
    public async Task<IReadOnlyList<ISwapProvider>> ProvidersAsync(string storeId, CancellationToken cancellationToken)
    {
        var settings = await _settings.GetAsync(storeId);
        var list = new List<ISwapProvider>(2);
        foreach (var uri in new[] { settings.LscPrimary, settings.LscBackup })
        {
            if (string.IsNullOrWhiteSpace(uri)) continue;
            var provider = Build(uri.Trim());
            if (provider is not null && list.All(p => p.Name != provider.Name)) list.Add(provider);
        }
        return list;
    }

    /// <summary>A provider built from a URI that is not saved yet (settings page "Test provider").</summary>
    public ISwapProvider? Build(string lscUri)
    {
        var entry = _providers.GetOrAdd(lscUri, key =>
        {
            var connection = LscUri.Parse(key);
            var client = _httpClientFactory.CreateClient("openreceive-swap");
            var provider = FixedFloatCompatibleProvider.FromLsc(connection, client, _clock);
            provider.AttachSwapCache(new TransientSwapCache(_clock, (message, error) => _logger.LogWarning("swap.cache.stale provider={Provider} message={Message} error={Error}", provider.Name, message, error)));
            provider.AttachWeightBudget(new SwapProviderWeightBudget(provider.Name, _clock));
            provider.AttachApiRequestLogger(entry => _logger.LogDebug("swap.provider.request provider={Provider} path={Path}", entry.Provider, entry.Path));
            provider.AttachApiResponseLogger(entry => _logger.LogDebug("swap.provider.response provider={Provider} path={Path} status={Status} ok={Ok} code={Code}", entry.Provider, entry.Path, entry.Status, entry.Ok, entry.Code));
            return new Entry(key, provider, connection);
        });
        return entry.Provider;
    }

    /// <summary>The provider to create a new order with: primary unless it is marked down.</summary>
    public async Task<ISwapProvider?> SelectForCreateAsync(string storeId, CancellationToken cancellationToken)
    {
        var providers = await ProvidersAsync(storeId, cancellationToken);
        if (providers.Count == 0) return null;
        var now = _clock();
        foreach (var provider in providers)
        {
            if (_failedAt.TryGetValue(provider.Name, out var failedAt) && now - failedAt < PrimaryDownSeconds) continue;
            return provider;
        }
        return providers[0];
    }

    public async Task<ISwapProvider?> ByNameAsync(string storeId, string name, CancellationToken cancellationToken)
    {
        var providers = await ProvidersAsync(storeId, cancellationToken);
        return providers.FirstOrDefault(p => p.Name == name);
    }

    public void MarkFailed(ISwapProvider provider)
    {
        _failedAt[provider.Name] = _clock();
        _logger.LogWarning("swap.provider.down provider={Provider} for={Seconds}s", provider.Name, PrimaryDownSeconds);
    }

    public void MarkHealthy(ISwapProvider provider) => _failedAt.TryRemove(provider.Name, out _);
}
