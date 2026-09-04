#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Numerics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// The FixedFloat-compatible <see cref="ISwapProvider"/>: option defaults and validation,
/// the provider id, and the assembly that routes every call through the signed transport,
/// the <c>/ccies</c> resolution and XML rates index held in the transient cache, and the
/// order / quote normalizers beside this file.
/// </summary>
public sealed partial class FixedFloatCompatibleProvider : ISwapProvider
{
    /// <param name="CacheSeconds">TTL for the disposable <c>/ccies</c> currency catalog cache.</param>
    /// <param name="RatesCacheSeconds">TTL for the process-local public XML rates cache (<c>/rates/fixed.xml</c>).</param>
    public sealed record Options(
        string Id,
        string Key,
        string Secret,
        string? BaseUrl = null,
        string? LightningCcy = null,
        int? CacheSeconds = null,
        int? RatesCacheSeconds = null,
        int? RequestTimeoutMs = null,
        int? InvoiceExpirySeconds = null,
        int? DepositWindowSeconds = null,
        int? SettlementSlaSeconds = null,
        int? InvoiceExpiryMarginSeconds = null);

    public const string DefaultBaseUrl = "https://ff.io";
    public const int DefaultCciesCacheSeconds = 24 * 60 * 60;
    public const int DefaultRatesCacheSeconds = TransientSwapCache.RatesRefreshSeconds;
    public const int DefaultRequestTimeoutMs = 10_000;
    public const int DefaultDepositWindowSeconds = 10 * 60;
    public const int DefaultSettlementSlaSeconds = 15 * 60;
    /// <summary>Margin above deposit_window + settlement_sla: keeps the shadow invoice alive through a plausible 30-minute provider order.</summary>
    public const int DefaultInvoiceExpiryMarginSeconds = 5 * 60;

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]{0,63}$")]
    private static partial Regex ProviderIdPattern();

    private readonly string? _lightningCcy;
    private readonly Func<long> _now;
    private readonly int _cacheSeconds;
    private readonly int _ratesCacheSeconds;
    private readonly FixedFloatTransport _transport;
    private TransientSwapCache? _cache;

    public string Name { get; }
    public int InvoiceExpirySeconds { get; }

    public FixedFloatCompatibleProvider(Options options, HttpClient httpClient, Func<long>? now = null)
    {
        Name = ReadProviderId(options.Id);
        if (options.Key.Trim().Length == 0)
        {
            throw new ArgumentException("FixedFloat-compatible API key must not be empty.");
        }
        if (options.Secret.Trim().Length == 0)
        {
            throw new ArgumentException("FixedFloat-compatible API secret must not be empty.");
        }

        var lightningCcy = options.LightningCcy?.Trim();
        _lightningCcy = string.IsNullOrEmpty(lightningCcy) ? null : lightningCcy;
        _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        _cacheSeconds = options.CacheSeconds ?? DefaultCciesCacheSeconds;
        _ratesCacheSeconds = options.RatesCacheSeconds ?? DefaultRatesCacheSeconds;
        if (_ratesCacheSeconds <= 0)
        {
            throw new ArgumentException("FixedFloat ratesCacheSeconds must be a positive safe integer.");
        }
        var requestTimeoutMs = options.RequestTimeoutMs ?? DefaultRequestTimeoutMs;
        if (requestTimeoutMs <= 0)
        {
            throw new ArgumentException("FixedFloat requestTimeoutMs must be a positive safe integer.");
        }
        _transport = new FixedFloatTransport(
            httpClient,
            options.Key,
            options.Secret,
            (options.BaseUrl ?? DefaultBaseUrl).TrimEnd('/'),
            Name,
            TimeSpan.FromMilliseconds(requestTimeoutMs));

        var depositWindowSeconds = options.DepositWindowSeconds ?? DefaultDepositWindowSeconds;
        var settlementSlaSeconds = options.SettlementSlaSeconds ?? DefaultSettlementSlaSeconds;
        var invoiceExpiryMarginSeconds = options.InvoiceExpiryMarginSeconds ?? DefaultInvoiceExpiryMarginSeconds;
        foreach (var (name, value) in new[]
                 {
                     ("FixedFloat depositWindowSeconds", depositWindowSeconds),
                     ("FixedFloat settlementSlaSeconds", settlementSlaSeconds),
                     ("FixedFloat invoiceExpiryMarginSeconds", invoiceExpiryMarginSeconds),
                 })
        {
            if (value < 0)
            {
                throw new ArgumentException($"{name} must be a non-negative safe integer.");
            }
        }
        var minimumInvoiceExpirySeconds = depositWindowSeconds + settlementSlaSeconds + invoiceExpiryMarginSeconds;
        InvoiceExpirySeconds = options.InvoiceExpirySeconds ?? minimumInvoiceExpirySeconds;
        if (InvoiceExpirySeconds < minimumInvoiceExpirySeconds)
        {
            throw new ArgumentException(
                $"FixedFloat provider \"{Name}\": invoice_expiry_seconds " +
                $"({InvoiceExpirySeconds}) must be at least {minimumInvoiceExpirySeconds} = " +
                $"deposit_window({depositWindowSeconds}) + settlement_sla({settlementSlaSeconds}) + " +
                $"margin({invoiceExpiryMarginSeconds}). Omit invoice_expiry_seconds to auto-derive it, " +
                "or raise it above that floor.");
        }
    }

    /// <summary>A provider for one parsed Lightning Swap Connect URI.</summary>
    public static FixedFloatCompatibleProvider FromLsc(LscConnection connection, HttpClient client, Func<long>? now = null) =>
        new(new Options(connection.ProviderId, connection.Key, connection.Secret, connection.BaseUrl), client, now);

    public void AttachSwapCache(TransientSwapCache cache) => _cache = cache;
    public void AttachWeightBudget(ISwapWeightBudget budget) => _transport.AttachWeightBudget(budget);
    public void AttachApiRequestLogger(Action<SwapProviderApiRequestLog> log) => _transport.AttachApiRequestLogger(log);
    public void AttachApiResponseLogger(Action<SwapProviderApiResponseLog> log) => _transport.AttachApiResponseLogger(log);

    public async Task<IReadOnlySet<string>> SupportedPayInAssetsAsync(CancellationToken cancellationToken)
    {
        var resolution = await ResolveCurrenciesAsync(cancellationToken).ConfigureAwait(false);
        return new HashSet<string>(resolution.PayIn.Keys, StringComparer.Ordinal);
    }

    public async Task<IReadOnlyList<SwapProviderAsset>> PayInAssetCatalogAsync(CancellationToken cancellationToken)
    {
        var resolution = await ResolveCurrenciesAsync(cancellationToken).ConfigureAwait(false);
        // /ccies reports only availability and display metadata per currency — it carries
        // no amount limits. Per-pair min/max come from the public XML rates export, cached
        // in this process so the payment-method screen never hits /price.
        var rates = await ResolveRatesIndexAsync(resolution, cancellationToken).ConfigureAwait(false);
        var catalog = new List<SwapProviderAsset>(resolution.PayIn.Count);
        foreach (var payInAsset in OpenReceiveTables.SwapPayInAssets)
        {
            if (!resolution.PayIn.TryGetValue(payInAsset, out var currency)) continue;
            if (!rates.Pairs.TryGetValue(FixedFloatRates.PairKey(currency.Code, resolution.Lightning.Code), out var pair))
            {
                catalog.Add(new SwapProviderAsset
                {
                    PayAsset = payInAsset,
                    Available = false,
                    UnavailableReason = "pair_temporarily_unavailable",
                    UnavailableMessage = FixedFloatQuote.AvailabilityMessage("pair_temporarily_unavailable"),
                });
                continue;
            }
            var limits = FixedFloatRates.InvoiceLimitsFromRate(pair);
            catalog.Add(new SwapProviderAsset
            {
                PayAsset = payInAsset,
                MinimumPayAmount = limits.MinimumPayAmount,
                MaximumPayAmount = limits.MaximumPayAmount,
                MinimumInvoiceAmountMsats = limits.MinimumInvoiceAmountMsats,
                MaximumInvoiceAmountMsats = limits.MaximumInvoiceAmountMsats,
            });
        }
        return catalog;
    }

    public async Task<SwapQuote> QuoteAsync(SwapQuoteInput input, CancellationToken cancellationToken)
    {
        // Indicative quote from the process-local XML rates cache. /create is still the
        // binding rate. Rates refresh failures throw (fail closed) so the service can skip
        // this provider and try the next configured LSC connection.
        var resolution = await ResolveCurrenciesAsync(cancellationToken).ConfigureAwait(false);
        var fromCcy = FixedFloatCurrencies.RequiredCurrency(resolution, input.PayInAsset);
        var rates = await ResolveRatesIndexAsync(resolution, cancellationToken).ConfigureAwait(false);
        rates.Pairs.TryGetValue(FixedFloatRates.PairKey(fromCcy, resolution.Lightning.Code), out var pair);
        return FixedFloatQuote.QuoteFromRatePair(pair, input.PayInAsset, input.InvoiceAmountMsats, Name);
    }

    public async Task<SwapOrder> CreateSwapAsync(CreateSwapInput input, CancellationToken cancellationToken)
    {
        var resolution = await ResolveCurrenciesAsync(cancellationToken).ConfigureAwait(false);
        var fromCcy = FixedFloatCurrencies.RequiredCurrency(resolution, input.PayInAsset);
        var data = await _transport.PostAsync("create", new JsonObject
        {
            ["type"] = "fixed",
            ["fromCcy"] = fromCcy,
            ["toCcy"] = resolution.Lightning.Code,
            ["direction"] = "to",
            ["amount"] = AmountMsatsToBtcString(input.InvoiceAmountMsats),
            ["toAddress"] = input.Bolt11,
        }, cancellationToken).ConfigureAwait(false);
        var order = FixedFloatOrders.NormalizeOrder(data, Name, input.PayInAsset);
        // FixedFloat order objects do not always carry the USD equivalents that explain
        // the swap fee, so backfill them from a best-effort /price lookup for the same
        // trade. A failure just leaves the fee off the deposit panel.
        if (order.Fee is not null) return order;
        var fee = await FetchOrderFeeAsync(fromCcy, resolution.Lightning.Code, input.InvoiceAmountMsats, cancellationToken).ConfigureAwait(false);
        return fee is null ? order : order with { Fee = fee };
    }

    public async Task<SwapOrder> GetStatusAsync(SwapOrder order, CancellationToken cancellationToken)
    {
        var data = await _transport.PostAsync("order", new JsonObject
        {
            ["id"] = order.ProviderOrderId,
            ["token"] = order.ProviderToken,
        }, cancellationToken).ConfigureAwait(false);
        var fresh = FixedFloatOrders.NormalizeOrder(data, Name, order.PayInAsset, order);
        // The fresh normalization wins; any optional field it left unset keeps the
        // persisted value (the JS `{ ...order, ...normalized }` merge).
        return fresh with
        {
            DepositMemo = fresh.DepositMemo ?? order.DepositMemo,
            DepositTxId = fresh.DepositTxId ?? order.DepositTxId,
            PayoutTxId = fresh.PayoutTxId ?? order.PayoutTxId,
            RefundTxId = fresh.RefundTxId ?? order.RefundTxId,
            Attention = fresh.Attention ?? order.Attention,
            AttentionReason = fresh.AttentionReason ?? order.AttentionReason,
            RefundReason = fresh.RefundReason ?? order.RefundReason,
            DepositReceivedAmount = fresh.DepositReceivedAmount ?? order.DepositReceivedAmount,
            RefundAmount = fresh.RefundAmount ?? order.RefundAmount,
            EmergencyRepeat = fresh.EmergencyRepeat ?? order.EmergencyRepeat,
            Fee = fresh.Fee ?? order.Fee,
        };
    }

    public async Task RequestRefundAsync(SwapOrder order, string refundAddress, CancellationToken cancellationToken)
    {
        await _transport.PostAsync("emergency", new JsonObject
        {
            ["id"] = order.ProviderOrderId,
            ["token"] = order.ProviderToken,
            ["choice"] = "REFUND",
            ["address"] = refundAddress,
        }, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Whole-satoshi BTC amount (msats rounded up) as a trimmed decimal string.</summary>
    public static string AmountMsatsToBtcString(long amountMsats)
    {
        if (amountMsats <= 0 || amountMsats > OpenReceiveTables.MaxAmountMsats)
        {
            throw new ArgumentOutOfRangeException(nameof(amountMsats), "invoiceAmountMsats must be a positive safe integer.");
        }
        var sats = DecimalMath.CeilDiv(new BigInteger(amountMsats), DecimalMath.MsatsPerSat);
        var wholeBtc = sats / DecimalMath.SatsPerBtc;
        var fractional = (sats % DecimalMath.SatsPerBtc).ToString(CultureInfo.InvariantCulture).PadLeft(8, '0').TrimEnd('0');
        var whole = wholeBtc.ToString(CultureInfo.InvariantCulture);
        return fractional.Length == 0 ? whole : $"{whole}.{fractional}";
    }

    private async Task<SwapFee?> FetchOrderFeeAsync(string fromCcy, string toCcy, long invoiceAmountMsats, CancellationToken cancellationToken)
    {
        try
        {
            var data = await _transport.PostAsync("price", new JsonObject
            {
                ["type"] = "fixed",
                ["fromCcy"] = fromCcy,
                ["toCcy"] = toCcy,
                ["direction"] = "to",
                ["amount"] = AmountMsatsToBtcString(invoiceAmountMsats),
            }, cancellationToken).ConfigureAwait(false);
            return FixedFloatOrders.ReadOrderFee(FixedFloatFields.ObjectOrEmpty(data));
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
    }

    private Task<FixedFloatCurrencyResolution> ResolveCurrenciesAsync(CancellationToken cancellationToken)
    {
        // No transient cache attached (tests / standalone use): fetch fresh each call.
        if (_cache is null) return FetchCurrencyResolutionAsync(cancellationToken);
        return _cache.ResolveAsync(
            TransientSwapCache.LimitsKey(Name),
            new TransientSwapCache.ResolveOptions<FixedFloatCurrencyResolution>(
                _cacheSeconds,
                Math.Max(TransientSwapCache.LimitsMaxStaleSeconds, _cacheSeconds),
                FetchCurrencyResolutionAsync),
            cancellationToken);
    }

    private Task<FixedFloatRatesIndex> ResolveRatesIndexAsync(FixedFloatCurrencyResolution resolution, CancellationToken cancellationToken)
    {
        if (_cache is null) return FetchRatesIndexAsync(resolution, cancellationToken);
        return _cache.ResolveAsync(
            TransientSwapCache.RatesKey(Name, "fixed"),
            new TransientSwapCache.ResolveOptions<FixedFloatRatesIndex>(
                _ratesCacheSeconds,
                Math.Max(TransientSwapCache.RatesMaxStaleSeconds, _ratesCacheSeconds),
                token => FetchRatesIndexAsync(resolution, token),
                // Crypto rates must not linger after a failed refresh — fail closed so the
                // service can skip this provider and try the next configured LSC connection.
                ServeStaleOnFailure: false),
            cancellationToken);
    }

    private async Task<FixedFloatRatesIndex> FetchRatesIndexAsync(FixedFloatCurrencyResolution resolution, CancellationToken cancellationToken)
    {
        var xmlPath = FixedFloatRates.RatesXmlPath("fixed");
        var path = xmlPath.TrimStart('/');
        _transport.LogApiRequest(path);
        try
        {
            var xml = await _transport.GetTextAsync(xmlPath, cancellationToken).ConfigureAwait(false);
            // Provider dumps include thousands of non-LN market pairs; OpenReceive only
            // ever pays out over Lightning, so drop everything else before caching.
            var fetched = new FixedFloatRatesIndex(_now(), FixedFloatRates.RetainLightningPayoutPairs(FixedFloatRates.ParseRatesXml(xml)));
            var index = FixedFloatRates.RetainPairsForKeys(fetched, FixedFloatCurrencies.RatePairKeys(resolution));
            _transport.LogApiResponse(path, 200, true, null, $"pair_count={index.Pairs.Count}");
            return index;
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _transport.LogApiResponse(path, 0, false, null, error.Message);
            throw;
        }
    }

    private async Task<FixedFloatCurrencyResolution> FetchCurrencyResolutionAsync(CancellationToken cancellationToken)
    {
        var now = _now();
        var data = await _transport.PostAsync("ccies", new JsonObject(), cancellationToken).ConfigureAwait(false);
        return FixedFloatCurrencies.Resolve(data, now, _lightningCcy);
    }

    private static string ReadProviderId(string id)
    {
        var normalized = id.Trim();
        if (!ProviderIdPattern().IsMatch(normalized))
        {
            throw new ArgumentException(
                "FixedFloat-compatible provider id must use lowercase letters, numbers, underscores, or hyphens.");
        }
        return normalized;
    }
}
