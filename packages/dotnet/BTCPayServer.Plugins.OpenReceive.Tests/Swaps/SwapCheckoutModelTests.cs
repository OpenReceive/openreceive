using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using Xunit;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

// The checkout's fee line. A payer once asked "50.05 or 50.03?" on a USDC
// checkout: the deposit amount (a token quantity) and the provider's fiat
// valuation of it sat one line apart and looked like the same number with a
// typo. For a stablecoin pegged to the fee currency the line is in the token.
public class SwapCheckoutModelTests
{
    private static readonly SwapFee UsdFee = new("USD", "50.03", "49");

    [Fact]
    public void Pegged_asset_fee_text_is_in_the_token_and_never_shows_the_pay_in_valuation()
    {
        var text = SwapCheckoutModel.FeeTextFor(OpenReceiveTables.SwapAssetInfo["USDC_SOL"], "50.05", UsdFee);

        Assert.Equal("Includes the provider's fee of 1.05 USDC (2.1%): 50.05 USDC sent → 49 USD received", text);
        Assert.DoesNotContain("50.03", text);
    }

    [Fact]
    public void Pegged_asset_fee_text_does_not_depend_on_which_side_of_the_peg_the_feed_is()
    {
        var below = SwapCheckoutModel.FeeTextFor(OpenReceiveTables.SwapAssetInfo["USDT_TRON"], "50.05", new SwapFee("USD", "50.03", "49"));
        var above = SwapCheckoutModel.FeeTextFor(OpenReceiveTables.SwapAssetInfo["USDT_TRON"], "50.05", new SwapFee("USD", "50.07", "49"));

        Assert.Equal(below, above);
        Assert.Contains("1.05 USDT", below);
    }

    [Fact]
    public void Floating_asset_fee_text_keeps_both_fiat_valuations()
    {
        var text = SwapCheckoutModel.FeeTextFor(OpenReceiveTables.SwapAssetInfo["SOL_SOL"], "0.71", UsdFee);

        Assert.Equal("Includes the provider's fee: 50.03 USD sent → 49 USD received", text);
    }

    [Fact]
    public void Pegged_asset_valued_below_the_cart_total_shows_a_zero_fee_not_a_negative_one()
    {
        var text = SwapCheckoutModel.FeeTextFor(OpenReceiveTables.SwapAssetInfo["USDC_ETH"], "48.99", UsdFee);

        Assert.StartsWith("Includes the provider's fee of 0.00 USDC (0.0%): 48.99 USDC sent", text);
    }
}
