using System.Net;
using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

public class FixedFloatProviderTests
{
    private const string Bolt11 = "lnbc100u1testinvoice";
    private const string DepositAddress = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

    private const string CciesJson = """
        {"code":0,"msg":"OK","data":[
          {"code":"USDTTRC","coin":"USDT","network":"TRC20","recv":true,"send":true},
          {"code":"USDCSOL","coin":"USDC","network":"Solana","recv":true,"send":true},
          {"code":"ETH","coin":"ETH","network":"ETH","recv":false,"send":true},
          {"code":"BTC","coin":"BTC","network":"BTC","recv":true,"send":true},
          {"code":"BTCLN","coin":"BTC","network":"Lightning","recv":true,"send":true}
        ]}
        """;

    private const string PriceJson = """
        {"code":0,"msg":"OK","data":{"from":{"code":"USDTTRC","amount":"10.1","usd":"10.10"},"to":{"code":"BTCLN","amount":"0.0001","usd":"10.00"}}}
        """;

    private const string CreateJson = """
        {"code":0,"msg":"OK","data":{
          "id":"ORD1","type":"fixed","status":"NEW","token":"tok-secret",
          "time":{"reg":1700000000,"expiration":1700000600},
          "from":{"code":"USDTTRC","address":"TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf","amount":"10.1","tag":null},
          "to":{"code":"BTCLN","address":"lnbc100u1testinvoice","amount":"0.0001"}
        }}
        """;

    private sealed class Fixture
    {
        public FakeSwapProviderHandler Handler { get; }
        public FixedFloatCompatibleProvider Provider { get; }
        public string OrderJson { get; set; } = """{"code":0,"msg":"OK","data":{"id":"ORD1"}}""";

        public Fixture()
        {
            Handler = new FakeSwapProviderHandler(request => request.Path switch
            {
                "/api/v2/ccies" => FakeSwapProviderHandler.Json(CciesJson),
                "/rates/fixed.xml" => FakeSwapProviderHandler.Text(FixedFloatRatesTests.SampleXml, "application/xml"),
                "/api/v2/price" => FakeSwapProviderHandler.Json(PriceJson),
                "/api/v2/create" => FakeSwapProviderHandler.Json(CreateJson),
                "/api/v2/order" => FakeSwapProviderHandler.Json(OrderJson),
                "/api/v2/emergency" => FakeSwapProviderHandler.Json("""{"code":0,"msg":"OK","data":true}"""),
                _ => FakeSwapProviderHandler.Json("""{"code":404,"msg":"unknown"}""", HttpStatusCode.NotFound),
            });
            Provider = new FixedFloatCompatibleProvider(
                new FixedFloatCompatibleProvider.Options("ff-test", "key", "secret", "https://ff.test/"),
                new HttpClient(Handler),
                () => 1_700_000_000);
        }

        public JsonObject Body(string path) =>
            (JsonObject)JsonNode.Parse(Handler.Requests.Last(request => request.Path == path).BodyText)!;
    }

    [Fact]
    public async Task Catalog_reports_availability_and_limits_per_pay_in_asset()
    {
        var fixture = new Fixture();

        var supported = await fixture.Provider.SupportedPayInAssetsAsync(CancellationToken.None);
        var catalog = await fixture.Provider.PayInAssetCatalogAsync(CancellationToken.None);

        // ETH is recv=false, USDT on Solana/Ethereum is not listed: only USDT_TRON and USDC_SOL resolve.
        Assert.Equal(new[] { "USDC_SOL", "USDT_TRON" }, supported.OrderBy(asset => asset));
        Assert.Equal(new[] { "USDT_TRON", "USDC_SOL" }, catalog.Select(asset => asset.PayAsset));

        var usdt = catalog[0];
        Assert.Null(usdt.Available);
        Assert.Equal("10.00000000", usdt.MinimumPayAmount);
        Assert.Equal("50000", usdt.MaximumPayAmount);
        Assert.Equal(10_000_000, usdt.MinimumInvoiceAmountMsats);
        Assert.Equal(50_000_000_000, usdt.MaximumInvoiceAmountMsats);

        // USDC on Solana is in /ccies but has no Lightning pair in the rates export.
        var usdc = catalog[1];
        Assert.False(usdc.Available);
        Assert.Equal("pair_temporarily_unavailable", usdc.UnavailableReason);
        Assert.Equal("This payment route is temporarily unavailable.", usdc.UnavailableMessage);
        Assert.Null(usdc.MinimumPayAmount);
    }

    [Fact]
    public async Task Quote_comes_from_the_rates_export_without_touching_price()
    {
        var fixture = new Fixture();

        var quote = await fixture.Provider.QuoteAsync(new SwapQuoteInput("USDT_TRON", 10_000_000), CancellationToken.None);

        Assert.True(quote.Available);
        Assert.Equal("10.1", quote.PayAmount);
        Assert.Equal("USDT_TRON", quote.PayAsset);
        Assert.Equal("ff-test", quote.Provider);
        Assert.Equal(10_000_000, quote.MinimumInvoiceAmountMsats);
        Assert.DoesNotContain(fixture.Handler.Requests, request => request.Path == "/api/v2/price");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.Provider.QuoteAsync(new SwapQuoteInput("USDT_ETH", 10_000_000), CancellationToken.None));
        Assert.Equal("FixedFloat does not currently support USDT_ETH.", error.Message);
    }

    [Fact]
    public async Task Create_posts_a_fixed_order_and_normalizes_the_body()
    {
        var fixture = new Fixture();

        var order = await fixture.Provider.CreateSwapAsync(new CreateSwapInput("USDT_TRON", Bolt11, 10_000_000), CancellationToken.None);

        var body = fixture.Body("/api/v2/create");
        Assert.Equal("fixed", body["type"]!.GetValue<string>());
        Assert.Equal("USDTTRC", body["fromCcy"]!.GetValue<string>());
        Assert.Equal("BTCLN", body["toCcy"]!.GetValue<string>());
        Assert.Equal("to", body["direction"]!.GetValue<string>());
        Assert.Equal("0.0001", body["amount"]!.GetValue<string>());
        Assert.Equal(Bolt11, body["toAddress"]!.GetValue<string>());

        Assert.Equal("ff-test", order.Provider);
        Assert.Equal("ORD1", order.ProviderOrderId);
        Assert.Equal("tok-secret", order.ProviderToken);
        Assert.Equal("USDT_TRON", order.PayInAsset);
        Assert.Equal(DepositAddress, order.DepositAddress);
        Assert.Null(order.DepositMemo);
        Assert.Equal("10.1", order.DepositAmount);
        Assert.Equal(1_700_000_600, order.ExpiresAt);
        Assert.Equal("awaiting_deposit", order.State);
        Assert.Null(order.Attention);
        Assert.Null(order.RefundReason);

        // The create body carried no USD equivalents, so the fee was backfilled from /price.
        Assert.Equal(new SwapFee("USD", "10.10", "10.00"), order.Fee);
        var price = fixture.Body("/api/v2/price");
        Assert.Equal("0.0001", price["amount"]!.GetValue<string>());
        Assert.Equal("USDTTRC", price["fromCcy"]!.GetValue<string>());
    }

    [Fact]
    public async Task Thin_status_body_keeps_every_persisted_field()
    {
        var fixture = new Fixture();
        var created = await fixture.Provider.CreateSwapAsync(new CreateSwapInput("USDT_TRON", Bolt11, 10_000_000), CancellationToken.None);

        var polled = await fixture.Provider.GetStatusAsync(created, CancellationToken.None);

        var body = fixture.Body("/api/v2/order");
        Assert.Equal("ORD1", body["id"]!.GetValue<string>());
        Assert.Equal("tok-secret", body["token"]!.GetValue<string>());
        Assert.Equal(created, polled);
    }

    [Fact]
    public async Task Status_body_with_progress_updates_state_and_transaction_fields()
    {
        var fixture = new Fixture();
        var created = await fixture.Provider.CreateSwapAsync(new CreateSwapInput("USDT_TRON", Bolt11, 10_000_000), CancellationToken.None);
        fixture.OrderJson = """
            {"code":0,"msg":"OK","data":{"id":"ORD1","status":"PENDING","from":{"tx":{"id":"deposit-tx","amount":"10.1"}}}}
            """;

        var polled = await fixture.Provider.GetStatusAsync(created, CancellationToken.None);

        Assert.Equal("confirming", polled.State);
        Assert.Equal("deposit-tx", polled.DepositTxId);
        Assert.Equal("10.1", polled.DepositReceivedAmount);
        Assert.Equal(created.ProviderToken, polled.ProviderToken);
        Assert.Equal(created.DepositAddress, polled.DepositAddress);
        Assert.Equal(created.ExpiresAt, polled.ExpiresAt);
        Assert.Equal(created.Fee, polled.Fee);

        fixture.OrderJson = """
            {"code":0,"msg":"OK","data":{"id":"ORD1","status":"EMERGENCY","emergency":{"status":["LESS"],"choice":"NONE","repeat":0}}}
            """;
        var emergency = await fixture.Provider.GetStatusAsync(polled, CancellationToken.None);
        Assert.Equal("refund_required", emergency.State);
        Assert.Equal("underpaid", emergency.RefundReason);
        Assert.False(emergency.EmergencyRepeat);
        Assert.Equal("deposit-tx", emergency.DepositTxId);
    }

    [Fact]
    public async Task Refund_posts_the_refund_choice_with_the_payer_address()
    {
        var fixture = new Fixture();
        var created = await fixture.Provider.CreateSwapAsync(new CreateSwapInput("USDT_TRON", Bolt11, 10_000_000), CancellationToken.None);

        await fixture.Provider.RequestRefundAsync(created, DepositAddress, CancellationToken.None);

        var body = fixture.Body("/api/v2/emergency");
        Assert.Equal("ORD1", body["id"]!.GetValue<string>());
        Assert.Equal("tok-secret", body["token"]!.GetValue<string>());
        Assert.Equal("REFUND", body["choice"]!.GetValue<string>());
        Assert.Equal(DepositAddress, body["address"]!.GetValue<string>());
    }

    [Fact]
    public async Task Transient_cache_serves_ccies_and_rates_without_refetching()
    {
        var fixture = new Fixture();
        fixture.Provider.AttachSwapCache(new TransientSwapCache(() => 1_700_000_000));

        await fixture.Provider.PayInAssetCatalogAsync(CancellationToken.None);
        await fixture.Provider.QuoteAsync(new SwapQuoteInput("USDT_TRON", 10_000_000), CancellationToken.None);

        Assert.Equal(1, fixture.Handler.Requests.Count(request => request.Path == "/api/v2/ccies"));
        Assert.Equal(1, fixture.Handler.Requests.Count(request => request.Path == "/rates/fixed.xml"));
    }

    [Fact]
    public void Options_are_validated_with_the_ported_messages()
    {
        var client = new HttpClient(new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("{}")));

        Assert.Equal(
            "FixedFloat-compatible provider id must use lowercase letters, numbers, underscores, or hyphens.",
            Assert.Throws<ArgumentException>(() => new FixedFloatCompatibleProvider(new("Bad Id", "k", "s"), client)).Message);
        Assert.Equal(
            "FixedFloat-compatible API key must not be empty.",
            Assert.Throws<ArgumentException>(() => new FixedFloatCompatibleProvider(new("ff", " ", "s"), client)).Message);
        Assert.Equal(
            "FixedFloat ratesCacheSeconds must be a positive safe integer.",
            Assert.Throws<ArgumentException>(() => new FixedFloatCompatibleProvider(new("ff", "k", "s", RatesCacheSeconds: 0), client)).Message);
        Assert.Equal(
            "FixedFloat depositWindowSeconds must be a non-negative safe integer.",
            Assert.Throws<ArgumentException>(() => new FixedFloatCompatibleProvider(new("ff", "k", "s", DepositWindowSeconds: -1), client)).Message);
        Assert.Equal(
            "FixedFloat provider \"ff\": invoice_expiry_seconds (100) must be at least 1800 = deposit_window(600) + settlement_sla(900) + margin(300). Omit invoice_expiry_seconds to auto-derive it, or raise it above that floor.",
            Assert.Throws<ArgumentException>(() => new FixedFloatCompatibleProvider(new("ff", "k", "s", InvoiceExpirySeconds: 100), client)).Message);

        var provider = new FixedFloatCompatibleProvider(new("ff", "k", "s"), client);
        Assert.Equal(1800, provider.InvoiceExpirySeconds);
        Assert.Equal(3600, new FixedFloatCompatibleProvider(new("ff", "k", "s", InvoiceExpirySeconds: 3600), client).InvoiceExpirySeconds);
    }

    [Fact]
    public void From_lsc_names_the_provider_after_the_uri()
    {
        var connection = LscUri.Parse("lightning+swapconnect://swap.example/v1?key=k&secret=s");
        var client = new HttpClient(new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("{}")));

        var provider = FixedFloatCompatibleProvider.FromLsc(connection, client);

        Assert.Equal("swap-example-v1", provider.Name);
    }

    [Theory]
    [InlineData(10_000_000, "0.0001")]
    [InlineData(100_000_000_000, "1")]
    [InlineData(1, "0.00000001")]
    [InlineData(1_001, "0.00000002")]
    [InlineData(123_456_789_000, "1.23456789")]
    public void Msats_render_as_whole_satoshi_btc_strings(long msats, string expected)
    {
        Assert.Equal(expected, FixedFloatCompatibleProvider.AmountMsatsToBtcString(msats));
    }

    [Fact]
    public void Non_positive_msats_are_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => FixedFloatCompatibleProvider.AmountMsatsToBtcString(0));
    }
}
