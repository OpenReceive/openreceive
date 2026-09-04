using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

public class FixedFloatRatesTests
{
    public const string SampleXml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <rates>
          <item>
            <from>USDTTRC</from>
            <to>BTCLN</to>
            <in>1</in>
            <out>0.000010000000</out>
            <amount>1.5 BTC</amount>
            <minamount>10.00000000 USDT</minamount>
            <maxamount>50000 USDT</maxamount>
            <tofee>0.0000010000 BTC</tofee>
          </item>
          <item>
            <from>ETH</from>
            <to>BTCLN</to>
            <in>1</in>
            <out>0.03</out>
            <amount>2 BTC</amount>
            <minamount>0.01 ETH</minamount>
            <maxamount>100 ETH</maxamount>
          </item>
          <item>
            <from>BTC</from>
            <to>ETH</to>
            <in>1</in>
            <out>33.3</out>
            <amount>1000 ETH</amount>
            <minamount>0.001 BTC</minamount>
            <maxamount>10 BTC</maxamount>
          </item>
          <item>
            <from>BROKEN</from>
            <to>BTCLN</to>
            <in>1</in>
          </item>
        </rates>
        """;

    private static readonly FixedFloatRatePair UsdtPair = new(
        "USDTTRC", "BTCLN", "1", "0.000010000000", "1.5", "10.00000000", "50000", "0.0000010000 BTC");

    [Fact]
    public void Parses_items_stripping_currency_suffixes_and_keeping_padded_decimals()
    {
        var pairs = FixedFloatRates.ParseRatesXml(SampleXml);

        Assert.Equal(3, pairs.Count);
        Assert.Equal(UsdtPair, pairs["USDTTRC:BTCLN"]);
        Assert.Null(pairs["ETH:BTCLN"].ToFee);
        Assert.Equal("0.001", pairs["BTC:ETH"].MinAmount);
    }

    [Fact]
    public void Retains_only_lightning_payout_pairs_and_requested_keys()
    {
        var lightning = FixedFloatRates.RetainLightningPayoutPairs(FixedFloatRates.ParseRatesXml(SampleXml));
        Assert.Equal(new[] { "ETH:BTCLN", "USDTTRC:BTCLN" }, lightning.Keys.OrderBy(key => key));

        var index = FixedFloatRates.RetainPairsForKeys(new FixedFloatRatesIndex(42, lightning), new HashSet<string> { "USDTTRC:BTCLN", "MISSING:BTCLN" });
        Assert.Equal(42, index.FetchedAt);
        Assert.Equal(new[] { "USDTTRC:BTCLN" }, index.Pairs.Keys);
        Assert.Empty(FixedFloatRates.RetainPairsForKeys(index, new HashSet<string>()).Pairs);
    }

    [Fact]
    public void Quote_folds_the_btc_network_fee_into_the_pay_amount()
    {
        // 1 USDT buys 0.00001 BTC (1000 sats); 10,000 sats + 100 sats of tofee = 10.1 USDT.
        Assert.Equal("10.1", FixedFloatRates.QuotePayAmountFromRate(UsdtPair, 10_000_000));
        // Sub-satoshi msats round up to the next satoshi before pricing.
        Assert.Equal("10.101", FixedFloatRates.QuotePayAmountFromRate(UsdtPair, 10_000_001));
        Assert.Null(FixedFloatRates.QuotePayAmountFromRate(UsdtPair, 0));
    }

    [Fact]
    public void Quote_rounds_up_at_eight_decimals()
    {
        var pair = new FixedFloatRatePair("X", "BTCLN", "1", "0.00003", "1", "0.0001", "100");

        // 1000 sats / 3000 sats-per-X = 0.333333333… → rounded up.
        Assert.Equal("0.33333334", FixedFloatRates.QuotePayAmountFromRate(pair, 1_000_000));
    }

    [Fact]
    public void Invoice_limits_round_the_minimum_up_and_the_maximum_down()
    {
        var limits = FixedFloatRates.InvoiceLimitsFromRate(UsdtPair);
        Assert.Equal("10.00000000", limits.MinimumPayAmount);
        Assert.Equal("50000", limits.MaximumPayAmount);
        Assert.Equal(10_000_000, limits.MinimumInvoiceAmountMsats);
        Assert.Equal(50_000_000_000, limits.MaximumInvoiceAmountMsats);

        // 0.0001 USDT = 0.1 sats → minimum rounds up to 1 sat; 0.0019 USDT = 1.9 sats → maximum rounds down to 1 sat.
        var fractional = UsdtPair with { MinAmount = "0.0001", MaxAmount = "0.0019" };
        var fractionalLimits = FixedFloatRates.InvoiceLimitsFromRate(fractional);
        Assert.Equal(1_000, fractionalLimits.MinimumInvoiceAmountMsats);
        Assert.Equal(1_000, fractionalLimits.MaximumInvoiceAmountMsats);
    }

    [Fact]
    public void Garbage_rate_amounts_make_the_quote_unavailable_not_a_throw()
    {
        var garbage = UsdtPair with { In = "n/a" };

        Assert.Null(FixedFloatRates.QuotePayAmountFromRate(garbage, 10_000_000));
        var limits = FixedFloatRates.InvoiceLimitsFromRate(garbage);
        Assert.Null(limits.MinimumInvoiceAmountMsats);
        Assert.Null(limits.MaximumInvoiceAmountMsats);

        var quote = FixedFloatQuote.QuoteFromRatePair(garbage, "USDT_TRON", 10_000_000, "ff");
        Assert.False(quote.Available);
        Assert.Equal("pair_temporarily_unavailable", quote.UnavailableReason);
        Assert.Equal("This payment route is temporarily unavailable.", quote.UnavailableMessage);
        Assert.Null(quote.PayAmount);
        Assert.Equal("10.00000000", quote.MinimumPayAmount);
        Assert.Equal("ff", quote.Provider);
    }

    [Fact]
    public void Quote_flags_amounts_outside_the_pair_limits()
    {
        var small = FixedFloatQuote.QuoteFromRatePair(UsdtPair, "USDT_TRON", 1_000_000, "ff");
        Assert.False(small.Available);
        Assert.Equal("amount_too_small", small.UnavailableReason);
        Assert.Equal("This invoice is below the provider minimum.", small.UnavailableMessage);

        var large = FixedFloatQuote.QuoteFromRatePair(UsdtPair, "USDT_TRON", 60_000_000_000, "ff");
        Assert.Equal("amount_too_large", large.UnavailableReason);

        var missing = FixedFloatQuote.QuoteFromRatePair(null, "USDT_TRON", 10_000_000, "ff");
        Assert.Equal("pair_temporarily_unavailable", missing.UnavailableReason);
        Assert.Null(missing.MinimumPayAmount);

        var ok = FixedFloatQuote.QuoteFromRatePair(UsdtPair, "USDT_TRON", 10_000_000, "ff");
        Assert.True(ok.Available);
        Assert.Equal("10.1", ok.PayAmount);
        Assert.Null(ok.UnavailableReason);
        Assert.Equal(10_000_000, ok.MinimumInvoiceAmountMsats);
    }

    [Fact]
    public void Compares_decimal_strings_exactly()
    {
        Assert.Equal(0, FixedFloatRates.CompareDecimalAmounts("10.1", "10.10000000"));
        Assert.Equal(-1, FixedFloatRates.CompareDecimalAmounts("9.99999999", "10"));
        Assert.Equal(1, FixedFloatRates.CompareDecimalAmounts("10.00000001", "10"));
        Assert.Null(FixedFloatRates.CompareDecimalAmounts("0", "10"));
        Assert.Null(FixedFloatRates.CompareDecimalAmounts("ten", "10"));
    }
}
