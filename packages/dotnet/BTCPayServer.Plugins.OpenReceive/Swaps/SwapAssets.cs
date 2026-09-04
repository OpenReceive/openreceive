#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Lookups over the generated pay-in asset table (spec/data/kernel-tables.json) plus
/// the provider network matching layered on top of it. Nothing here retypes the table.
/// </summary>
public static partial class SwapAssets
{
    [GeneratedRegex("[^A-Z0-9]+")]
    private static partial Regex NonAlphanumeric();

    public static bool IsSwapPayInAsset(string? value) =>
        value is not null && OpenReceiveTables.SwapAssetInfo.ContainsKey(value);

    public static OpenReceiveSwapAssetInfo GetInfo(string payInAsset) =>
        OpenReceiveTables.SwapAssetInfo.TryGetValue(payInAsset, out var info)
            ? info
            : throw new ArgumentException($"Unknown swap pay-in asset {payInAsset}.", nameof(payInAsset));

    /// <summary>Every pay-in asset, in the kernel table's order.</summary>
    public static IReadOnlyList<OpenReceiveSwapAssetInfo> List() =>
        OpenReceiveTables.SwapPayInAssets.Select(asset => OpenReceiveTables.SwapAssetInfo[asset]).ToArray();

    public static string NormalizeSwapNetwork(string value) =>
        NonAlphanumeric().Replace(value.ToUpperInvariant(), string.Empty);

    public static bool SwapNetworkMatches(string expected, string actual)
    {
        var normalizedExpected = NormalizeSwapNetwork(expected);
        var normalizedActual = NormalizeSwapNetwork(actual);
        if (normalizedActual == normalizedExpected) return true;
        return normalizedExpected switch
        {
            "TRX" => normalizedActual is "TRON" or "TRC20" or "TRC",
            "ETH" => normalizedActual is "ETHEREUM" or "ERC20" or "ERC",
            "SOL" => normalizedActual == "SOLANA",
            _ => false,
        };
    }

    public static bool IsLightningNetwork(string value) =>
        NormalizeSwapNetwork(value) is "LN" or "LIGHTNING" or "LIGHTNINGNETWORK" or "BTCLN" or "BTCBOLT11";
}
