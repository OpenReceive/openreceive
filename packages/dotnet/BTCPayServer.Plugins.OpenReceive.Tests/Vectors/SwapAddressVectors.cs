using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Vectors;

/// <summary>spec/test-vectors/swap-address.json through the production checksum validator.</summary>
public class SwapAddressVectors
{
    private const string Family = "swap-address.json";

    public static TheoryData<string> Cases()
    {
        var data = new TheoryData<string>();
        foreach (var testCase in TestVectors.Cases(Family))
        {
            data.Add(testCase["name"]!.GetValue<string>());
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Address_validity_matches_the_vector(string name)
    {
        var testCase = TestVectors.Cases(Family).Single(item => item["name"]!.GetValue<string>() == name);
        var network = testCase["network"]!.GetValue<string>();
        var address = testCase["address"]!.GetValue<string>();
        var expected = ((JsonObject)testCase["expected"]!)["valid"]!.GetValue<bool>();

        Assert.Equal(expected, SwapAddress.IsValidAddressForSwapNetwork(network, address));
    }

    [Fact]
    public void Pay_in_asset_codes_resolve_to_their_checksum_network()
    {
        Assert.Equal("TRX", SwapAddress.NetworkForPayInAsset("USDT_TRON"));
        Assert.Equal("ETH", SwapAddress.NetworkForPayInAsset("USDC_ETH"));
        Assert.Equal("SOL", SwapAddress.NetworkForPayInAsset("SOL_SOL"));
        Assert.Null(SwapAddress.NetworkForPayInAsset("lightning"));
        Assert.Equal("LIGHTNING", SwapAddress.PayInAssetNetwork("lightning"));
        Assert.Null(SwapAddress.PayInAssetNetwork(string.Empty));
    }

    [Fact]
    public void Refund_address_errors_use_the_network_label()
    {
        Assert.Null(SwapAddress.RefundAddressError("USDT_TRON", "  ", "Tron"));
        Assert.Null(SwapAddress.RefundAddressError("USDT_TRON", " TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf ", "Tron"));
        Assert.Equal(
            "That Tron address failed its checksum. Copy it again from your wallet.",
            SwapAddress.RefundAddressError("USDT_TRON", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg", "Tron"));
        Assert.Equal(
            "That doesn't look like a Tron address. Use an address starting with T.",
            SwapAddress.RefundAddressError("USDT_TRON", "0x2222222222222222222222222222222222222222", "Tron"));
        Assert.Equal(
            "That Ethereum address failed its checksum. Copy it again from your wallet.",
            SwapAddress.RefundAddressError("USDT_ETH", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Beaed", "Ethereum"));
        Assert.Equal(
            "That doesn't look like an Ethereum address. Use a 0x address.",
            SwapAddress.RefundAddressError("USDT_ETH", "nope", "Ethereum"));
        Assert.Equal(
            "That doesn't look like a Solana address. Check you pasted the full address.",
            SwapAddress.RefundAddressError("SOL_SOL", "So1111111111111111111111111111111111111", "Solana"));
    }
}
