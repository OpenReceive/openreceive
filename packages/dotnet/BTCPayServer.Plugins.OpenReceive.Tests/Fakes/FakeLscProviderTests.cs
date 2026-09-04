using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OpenReceive.FakeLsc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Fakes;

/// <summary>
/// The fake Lightning Swap Connect provider seen the way the OpenReceive client sees it:
/// signed <c>/api/v2</c> POSTs and the public rates XML over an in-process HttpClient.
/// </summary>
public sealed class FakeLscProviderTests
{
    private const string Bolt11 = "lnbcrt10u1fakeinvoice";
    private const long Now = 1_800_000_000;

    private static (FakeLscProviderCore Core, HttpClient Http) Build(FakeLscOptions? options = null)
    {
        var core = new FakeLscProviderCore(options ?? new FakeLscOptions { Clock = () => Now });
        var http = new HttpClient(new FakeLscHttpMessageHandler(core)) { BaseAddress = new Uri("https://fake-lsc.test/") };
        return (core, http);
    }

    private static async Task<(HttpStatusCode Status, JsonObject Envelope)> Post(
        HttpClient http, string path, string body, string key = "test-key", string secret = "test-secret", string? signOverride = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"api/v2/{path}")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-API-KEY", key);
        request.Headers.Add("X-API-SIGN", signOverride ?? FakeLscProviderCore.Sign(secret, body));
        using var response = await http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        return (response.StatusCode, (JsonObject)JsonNode.Parse(text)!);
    }

    private static async Task<JsonObject> Create(HttpClient http, string fromCcy = "USDTTRC", string amount = "0.0001")
    {
        var (status, envelope) = await Post(http, "create",
            $$"""{"type":"fixed","fromCcy":"{{fromCcy}}","toCcy":"BTCLN","direction":"to","amount":"{{amount}}","toAddress":"{{Bolt11}}"}""");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(0, (int)envelope["code"]!);
        return (JsonObject)envelope["data"]!;
    }

    private static Task<(HttpStatusCode Status, JsonObject Envelope)> Poll(HttpClient http, JsonObject order) =>
        Post(http, "order", $$"""{"id":"{{order["id"]}}","token":"{{order["token"]}}"}""");

    [Fact]
    public async Task Signature_is_required_on_api_calls()
    {
        var (_, http) = Build();

        var wrong = await Post(http, "ccies", "{}", signOverride: "deadbeef");
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.Status);
        Assert.Equal(1, (int)wrong.Envelope["code"]!);
        Assert.Equal("Invalid signature", (string)wrong.Envelope["msg"]!);

        var wrongKey = await Post(http, "ccies", "{}", key: "someone-else");
        Assert.Equal(HttpStatusCode.Unauthorized, wrongKey.Status);

        var right = await Post(http, "ccies", "{}");
        Assert.Equal(HttpStatusCode.OK, right.Status);
        Assert.Equal(0, (int)right.Envelope["code"]!);
        Assert.Equal("OK", (string)right.Envelope["msg"]!);
    }

    [Fact]
    public async Task Ccies_lists_the_seven_pay_in_assets_and_lightning()
    {
        var (_, http) = Build();
        var (_, envelope) = await Post(http, "ccies", "{}");
        var items = (JsonArray)envelope["data"]!;

        var codes = items.Select(i => (string)i!["code"]!).ToArray();
        Assert.Equal(new[] { "SOL", "USDTTRC", "USDTSOL", "USDCSOL", "ETH", "USDTETH", "USDCETH", "BTCLN" }, codes);
        Assert.All(items, i =>
        {
            Assert.True((bool)i!["recv"]!);
            Assert.True((bool)i["send"]!);
        });
        var usdtTrc = items.Single(i => (string)i!["code"]! == "USDTTRC")!;
        Assert.Equal("USDT", (string)usdtTrc["coin"]!);
        Assert.Equal("TRC20", (string)usdtTrc["network"]!);
        var ln = items.Single(i => (string)i!["code"]! == "BTCLN")!;
        Assert.Equal("BTC", (string)ln["coin"]!);
        Assert.Equal("Lightning", (string)ln["network"]!);
    }

    [Fact]
    public async Task Price_uses_the_fixed_rate_table_with_decimal_math()
    {
        var (_, http) = Build();
        var (_, envelope) = await Post(http, "price",
            """{"type":"fixed","fromCcy":"USDTTRC","toCcy":"BTCLN","direction":"to","amount":"0.0001"}""");
        var data = envelope["data"]!;

        // 0.0001 BTC at 100,000 USD/BTC is 10 USDT, plus the 1% markup.
        Assert.Equal("10.1", (string)data["from"]!["amount"]!);
        Assert.Equal("10.10", (string)data["from"]!["usd"]!);
        Assert.Equal("0.0001", (string)data["to"]!["amount"]!);
        Assert.Equal("10.00", (string)data["to"]!["usd"]!);
    }

    [Theory]
    [InlineData("USDTTRC", "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")]
    [InlineData("USDCSOL", "So11111111111111111111111111111111111111112")]
    [InlineData("ETH", "0x1111111111111111111111111111111111111111")]
    public async Task Create_returns_a_new_order_with_the_network_deposit_address(string fromCcy, string expectedAddress)
    {
        var (core, http) = Build();
        var order = await Create(http, fromCcy);

        Assert.Equal("NEW", (string)order["status"]!);
        Assert.Equal(6, ((string)order["id"]!).Length);
        Assert.Equal(32, ((string)order["token"]!).Length);
        Assert.Equal(expectedAddress, (string)order["from"]!["address"]!);
        Assert.Null(order["from"]!["tag"]);
        Assert.Equal(Bolt11, (string)order["to"]!["address"]!);
        Assert.Equal("BTCLN", (string)order["to"]!["code"]!);
        Assert.Equal(Now + 900, (long)order["time"]!["expiration"]!);
        Assert.Equal("NONE", (string)order["emergency"]!["choice"]!);
        Assert.Empty((JsonArray)order["emergency"]!["status"]!);

        var stored = Assert.Single(core.Orders);
        Assert.Equal("awaiting_deposit", stored.State);
        Assert.Equal(Bolt11, stored.Bolt11);
    }

    [Fact]
    public async Task Create_uses_a_pay_amount_override_when_configured()
    {
        var (_, http) = Build(new FakeLscOptions
        {
            Clock = () => Now,
            PayAmounts = new Dictionary<string, string> { ["USDT_TRON"] = "1.05" },
        });
        var order = await Create(http);
        Assert.Equal("1.05", (string)order["from"]!["amount"]!);
    }

    [Fact]
    public async Task Scripted_states_advance_one_step_per_poll_and_pay_the_invoice_once()
    {
        var paid = new List<string>();
        var (core, http) = Build(new FakeLscOptions
        {
            Clock = () => Now,
            Payer = (bolt11, _) =>
            {
                lock (paid) paid.Add(bolt11);
                return Task.CompletedTask;
            },
        });
        core.Script("USDT_TRON", ["confirming", "completed"]);
        var order = await Create(http);
        Assert.Equal("NEW", (string)order["status"]!);

        var first = (await Poll(http, order)).Envelope["data"]!;
        Assert.Equal("PENDING", (string)first["status"]!);
        Assert.NotNull(first["from"]!["tx"]!["id"]);
        Assert.Null(first["to"]!["tx"]);

        var second = (await Poll(http, order)).Envelope["data"]!;
        Assert.Equal("DONE", (string)second["status"]!);
        Assert.NotNull(second["to"]!["tx"]!["id"]);

        var third = (await Poll(http, order)).Envelope["data"]!;
        Assert.Equal("DONE", (string)third["status"]!);

        await core.WaitForPayerAsync();
        Assert.Equal(new[] { Bolt11 }, paid);
        Assert.Null(core.LastPayerError);
        Assert.Equal("completed", Assert.Single(core.Orders).State);
    }

    [Fact]
    public async Task Payer_failure_is_recorded_not_thrown()
    {
        var (core, http) = Build(new FakeLscOptions
        {
            Clock = () => Now,
            Payer = (_, _) => throw new InvalidOperationException("no route"),
        });
        core.Script("USDT_TRON", ["completed"]);
        var order = await Create(http);
        var (status, _) = await Poll(http, order);
        Assert.Equal(HttpStatusCode.OK, status);

        await core.WaitForPayerAsync();
        Assert.Equal("no route", core.LastPayerError);
    }

    [Fact]
    public async Task Force_refund_required_underpaid_is_an_emergency_with_LESS()
    {
        var (core, http) = Build();
        var order = await Create(http);
        core.ForceRefundRequired((string)order["id"]!, "underpaid");

        var polled = (await Poll(http, order)).Envelope["data"]!;
        Assert.Equal("EMERGENCY", (string)polled["status"]!);
        Assert.Equal("NONE", (string)polled["emergency"]!["choice"]!);
        Assert.Equal(new[] { "LESS" }, ((JsonArray)polled["emergency"]!["status"]!).Select(s => (string)s!));
        Assert.Null(polled["back"]);
        Assert.Equal("refund_required", Assert.Single(core.Orders).State);
    }

    [Fact]
    public async Task Force_refund_required_by_asset_applies_to_the_next_order()
    {
        var (core, http) = Build();
        core.ForceRefundRequired("USDT_TRON", "underpaid_and_late");
        var order = await Create(http);

        var polled = (await Poll(http, order)).Envelope["data"]!;
        Assert.Equal("EMERGENCY", (string)polled["status"]!);
        Assert.Equal(new[] { "LESS", "EXPIRED" }, ((JsonArray)polled["emergency"]!["status"]!).Select(s => (string)s!));
    }

    [Fact]
    public async Task Emergency_refund_records_the_refund_address()
    {
        var (core, http) = Build();
        var order = await Create(http);
        core.ForceRefundRequired((string)order["id"]!);

        var (status, envelope) = await Post(http, "emergency",
            $$"""{"id":"{{order["id"]}}","token":"{{order["token"]}}","choice":"REFUND","address":"TRefund111111111111111111111111111"}""");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(0, (int)envelope["code"]!);

        var polled = (await Poll(http, order)).Envelope["data"]!;
        Assert.Equal("EMERGENCY", (string)polled["status"]!);
        Assert.Equal("REFUND", (string)polled["emergency"]!["choice"]!);
        Assert.Equal("TRefund111111111111111111111111111", (string)polled["back"]!["address"]!);
        Assert.Null(polled["back"]!["tx"]);
        Assert.Equal("refund_pending", Assert.Single(core.Orders).State);

        core.Script((string)order["id"]!, ["refunded"]);
        var refunded = (await Poll(http, order)).Envelope["data"]!;
        Assert.NotNull(refunded["back"]!["tx"]!["id"]);
    }

    [Fact]
    public async Task Force_attention_renders_an_exchange_choice_or_an_unknown_status()
    {
        var (core, http) = Build();
        var emergency = await Create(http);
        core.ForceAttention((string)emergency["id"]!);
        var polled = (await Poll(http, emergency)).Envelope["data"]!;
        Assert.Equal("EMERGENCY", (string)polled["status"]!);
        Assert.Equal("EXCHANGE", (string)polled["emergency"]!["choice"]!);

        var unknown = await Create(http);
        core.ForceAttention((string)unknown["id"]!, "provider_status_unrecognized");
        polled = (await Poll(http, unknown)).Envelope["data"]!;
        Assert.Equal("SOMETHING_NEW", (string)polled["status"]!);
    }

    [Fact]
    public async Task Force_create_error_fails_the_next_create_only()
    {
        var (core, http) = Build();
        core.ForceCreateError("Order creation temporarily unavailable");

        var (status, envelope) = await Post(http, "create",
            $$"""{"type":"fixed","fromCcy":"USDTTRC","toCcy":"BTCLN","direction":"to","amount":"0.0001","toAddress":"{{Bolt11}}"}""");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(1, (int)envelope["code"]!);
        Assert.Equal("Order creation temporarily unavailable", (string)envelope["msg"]!);

        await Create(http);
    }

    [Fact]
    public async Task Rates_xml_lists_every_pay_in_to_lightning_pair()
    {
        var (_, http) = Build();
        using var response = await http.GetAsync("rates/fixed.xml");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/xml", response.Content.Headers.ContentType?.MediaType);
        var xml = await response.Content.ReadAsStringAsync();

        Assert.Contains("<from>USDTTRC</from><to>BTCLN</to><in>1.01</in><out>0.00001</out>", xml);
        Assert.Contains("<minamount>10 USDT</minamount><maxamount>10000 USDT</maxamount>", xml);
        Assert.Contains("<from>ETH</from><to>BTCLN</to><in>1.01</in><out>0.03</out>", xml);
        Assert.Equal(7, xml.Split("<item>").Length - 1);
    }

    [Fact]
    public async Task Rate_limit_next_answers_429_then_recovers()
    {
        var (core, http) = Build();
        core.RateLimitNext(1);

        var limited = await Post(http, "ccies", "{}");
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.Status);
        Assert.Equal(429, (int)limited.Envelope["code"]!);
        Assert.Equal("Too many requests", (string)limited.Envelope["msg"]!);

        var ok = await Post(http, "ccies", "{}");
        Assert.Equal(HttpStatusCode.OK, ok.Status);
    }

    [Fact]
    public async Task Unknown_paths_and_unknown_orders_are_envelopes()
    {
        var (_, http) = Build();
        var (status, envelope) = await Post(http, "nope", "{}");
        Assert.Equal(HttpStatusCode.NotFound, status);
        Assert.Equal(404, (int)envelope["code"]!);

        var missing = await Post(http, "order", """{"id":"ABC123","token":"nope"}""");
        Assert.Equal(HttpStatusCode.OK, missing.Status);
        Assert.Equal(1, (int)missing.Envelope["code"]!);
    }
}
