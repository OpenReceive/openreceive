using System.Globalization;

namespace OpenReceive.FakeLsc;

/// <summary>One pay-in asset as the fake provider advertises it: the OpenReceive asset id and its FixedFloat-style currency.</summary>
public sealed record FakeLscAsset(
    string PayInAsset,
    string Code,
    string Coin,
    string Network,
    string DepositAddress,
    string MinAmount,
    string MaxAmount);

/// <summary>
/// The asset table (mirrors the seven pay-in assets of spec/data/kernel-tables.json,
/// copied here because this project must not reference the plugin), the deposit
/// address per chain, and the fixed rate table behind <c>/price</c>, <c>/create</c>
/// and <c>/rates/fixed.xml</c>. All money math is <see cref="decimal"/>.
/// </summary>
public static class FakeLscAssets
{
    public const string LightningCode = "BTCLN";
    public const string LightningCoin = "BTC";
    public const string LightningNetwork = "Lightning";

    private const string TrxAddress = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
    private const string SolAddress = "So11111111111111111111111111111111111111112";
    private const string EthAddress = "0x1111111111111111111111111111111111111111";

    /// <summary>USD value of one unit of each coin. BTC at 100,000 keeps every rate a short exact decimal.</summary>
    private static readonly IReadOnlyDictionary<string, decimal> UsdPerCoin = new Dictionary<string, decimal>(StringComparer.Ordinal)
    {
        ["BTC"] = 100_000m,
        ["USDT"] = 1m,
        ["USDC"] = 1m,
        ["SOL"] = 150m,
        ["ETH"] = 3_000m,
    };

    /// <summary>The provider's cut: the payer sends 1% more than the pure rate.</summary>
    public const decimal Markup = 1.01m;

    public static readonly IReadOnlyList<FakeLscAsset> All = new[]
    {
        new FakeLscAsset("SOL_SOL", "SOL", "SOL", "SOL", SolAddress, "0.1", "100"),
        new FakeLscAsset("USDT_TRON", "USDTTRC", "USDT", "TRC20", TrxAddress, "10", "10000"),
        new FakeLscAsset("USDT_SOL", "USDTSOL", "USDT", "SOL", SolAddress, "10", "10000"),
        new FakeLscAsset("USDC_SOL", "USDCSOL", "USDC", "SOL", SolAddress, "10", "10000"),
        new FakeLscAsset("ETH_ETH", "ETH", "ETH", "ETH", EthAddress, "0.005", "5"),
        new FakeLscAsset("USDT_ETH", "USDTETH", "USDT", "ERC20", EthAddress, "10", "10000"),
        new FakeLscAsset("USDC_ETH", "USDCETH", "USDC", "ERC20", EthAddress, "10", "10000"),
    };

    public static readonly IReadOnlyList<string> PayInAssets = All.Select(a => a.PayInAsset).ToArray();

    public static FakeLscAsset? ByPayInAsset(string payInAsset) =>
        All.FirstOrDefault(a => a.PayInAsset == payInAsset);

    public static FakeLscAsset? ByCode(string code) =>
        All.FirstOrDefault(a => string.Equals(a.Code, code, StringComparison.OrdinalIgnoreCase));

    public static decimal UsdValue(string coin, decimal amount) => amount * UsdPerCoin[coin];

    /// <summary>BTC received per one unit of the coin at the pure (markup-free) rate.</summary>
    public static decimal BtcPerUnit(string coin) => UsdPerCoin[coin] / UsdPerCoin["BTC"];

    /// <summary>
    /// Deposit amount for a Lightning payout of <paramref name="btcAmount"/>: the pure
    /// rate plus <see cref="Markup"/>, rounded up at 8 decimals so the payer never underpays.
    /// </summary>
    public static decimal DepositAmountFor(FakeLscAsset asset, decimal btcAmount)
    {
        var pure = btcAmount * UsdPerCoin["BTC"] / UsdPerCoin[asset.Coin] * Markup;
        return Math.Ceiling(pure * 100_000_000m) / 100_000_000m;
    }

    /// <summary>Plain decimal text: invariant culture, no exponent, no trailing zeros.</summary>
    public static string FormatAmount(decimal value)
    {
        var text = value.ToString(CultureInfo.InvariantCulture);
        return text.Contains('.') ? text.TrimEnd('0').TrimEnd('.') : text;
    }

    public static string FormatUsd(decimal value) =>
        Math.Round(value, 2, MidpointRounding.AwayFromZero).ToString("0.00", CultureInfo.InvariantCulture);

    public static bool TryParseAmount(string? text, out decimal value)
    {
        value = 0m;
        return text is not null
            && decimal.TryParse(text, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out value)
            && value > 0m;
    }
}
