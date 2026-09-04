#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>One entry of a FixedFloat <c>/ccies</c> body.</summary>
public sealed record FixedFloatCurrency(string Code, string Coin, string Network, bool? Recv = null, bool? Send = null);

/// <summary>
/// Which provider currency codes stand for OpenReceive's pay-in assets (keyed by
/// pay_in_asset) and for the BTC Lightning payout.
/// </summary>
public sealed record FixedFloatCurrencyResolution(
    long FetchedAt,
    IReadOnlyDictionary<string, FixedFloatCurrency> PayIn,
    FixedFloatCurrency Lightning);

/// <summary>
/// FixedFloat <c>/ccies</c> discovery. <c>/ccies</c> carries availability and display
/// metadata only — never limits.
/// </summary>
public static class FixedFloatCurrencies
{
    /// <summary>
    /// Match a <c>/ccies</c> body against OpenReceive's pay-in asset list and pick the
    /// Lightning payout currency: <paramref name="lightningCcy"/> when configured,
    /// otherwise the first sendable BTC Lightning entry.
    /// </summary>
    public static FixedFloatCurrencyResolution Resolve(JsonNode? data, long fetchedAt, string? lightningCcy)
    {
        var currencies = ReadCurrencies(data);
        var payIn = new Dictionary<string, FixedFloatCurrency>(StringComparer.Ordinal);
        foreach (var asset in SwapAssets.List())
        {
            var found = currencies.FirstOrDefault(currency =>
                currency.Coin.ToUpperInvariant() == asset.Coin &&
                SwapAssets.SwapNetworkMatches(asset.Network, currency.Network) &&
                // /ccies recv=false means FixedFloat will not accept deposits for this
                // currency — omit it from the catalog rather than failing at /create.
                currency.Recv != false);
            if (found is not null) payIn[asset.PayInAsset] = found;
        }

        var lightning = lightningCcy is null
            ? currencies.FirstOrDefault(currency =>
                currency.Coin.ToUpperInvariant() == "BTC" &&
                SwapAssets.IsLightningNetwork(currency.Network) &&
                // Payout side must be sendable to the merchant's bolt11.
                currency.Send != false)
            : currencies.FirstOrDefault(currency => currency.Code == lightningCcy && currency.Send != false);
        if (lightning is null)
        {
            throw new InvalidOperationException("FixedFloat /ccies did not include a BTC Lightning payout currency.");
        }

        return new FixedFloatCurrencyResolution(fetchedAt, payIn, lightning);
    }

    /// <summary>The provider code for a pay-in asset, or the payer-facing "not supported" error.</summary>
    public static string RequiredCurrency(FixedFloatCurrencyResolution resolution, string payInAsset)
    {
        if (resolution.PayIn.TryGetValue(payInAsset, out var currency)) return currency.Code;
        var label = SwapAssets.GetInfo(payInAsset).PayInAsset;
        throw new InvalidOperationException($"FixedFloat does not currently support {label}.");
    }

    public static IReadOnlySet<string> RatePairKeys(FixedFloatCurrencyResolution resolution)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var currency in resolution.PayIn.Values)
        {
            keys.Add(FixedFloatRates.PairKey(currency.Code, resolution.Lightning.Code));
        }
        return keys;
    }

    private static List<FixedFloatCurrency> ReadCurrencies(JsonNode? data)
    {
        var record = FixedFloatFields.ObjectOrEmpty(data);
        var items = data as JsonArray
                    ?? record["ccies"] as JsonArray
                    ?? record["currencies"] as JsonArray
                    ?? new JsonArray();
        var currencies = new List<FixedFloatCurrency>();
        foreach (var item in items)
        {
            var entry = FixedFloatFields.ObjectOrEmpty(item);
            var code = FixedFloatFields.OptionalStringField(entry, "code") ?? FixedFloatFields.OptionalStringField(entry, "ticker");
            var coin = FixedFloatFields.OptionalStringField(entry, "coin")
                       ?? FixedFloatFields.OptionalStringField(entry, "currency")
                       ?? FixedFloatFields.OptionalStringField(entry, "symbol");
            var network = FixedFloatFields.OptionalStringField(entry, "network")
                          ?? FixedFloatFields.OptionalStringField(entry, "chain")
                          ?? FixedFloatFields.OptionalStringField(entry, "networkName")
                          ?? FixedFloatFields.OptionalStringField(entry, "name");
            if (code is not null && coin is not null && network is not null)
            {
                currencies.Add(new FixedFloatCurrency(
                    code,
                    coin.ToUpperInvariant(),
                    network,
                    FixedFloatFields.OptionalBoolean(entry, "recv"),
                    FixedFloatFields.OptionalBoolean(entry, "send")));
            }
        }
        return currencies;
    }
}
