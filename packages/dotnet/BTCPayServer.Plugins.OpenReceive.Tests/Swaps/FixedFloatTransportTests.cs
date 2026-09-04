using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using BTCPayServer.Plugins.OpenReceive.Swaps;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Swaps;

public class FixedFloatTransportTests
{
    private const string Key = "api-key";
    private const string Secret = "api-secret";

    private static FixedFloatTransport Transport(FakeSwapProviderHandler handler, int timeoutMs = 5_000) =>
        new(new HttpClient(handler), Key, Secret, "https://ff.test/", "ff-test", TimeSpan.FromMilliseconds(timeoutMs));

    [Fact]
    public async Task Post_signs_the_exact_body_bytes_and_sets_the_provider_headers()
    {
        var handler = new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("""{"code":0,"msg":"OK","data":{"ok":true}}"""));
        var transport = Transport(handler);
        var body = new JsonObject { ["type"] = "fixed", ["fromCcy"] = "USDTTRC", ["amount"] = "0.0001" };

        var data = await transport.PostAsync("create", body, CancellationToken.None);

        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Message.Method);
        Assert.Equal("https://ff.test/api/v2/create", request.Message.RequestUri!.ToString());
        Assert.Equal("application/json; charset=UTF-8", request.Message.Content!.Headers.ContentType!.ToString());
        Assert.Equal(Key, request.Message.Headers.GetValues("X-API-KEY").Single());
        Assert.Equal("""{"type":"fixed","fromCcy":"USDTTRC","amount":"0.0001"}""", request.BodyText);
        var expectedSign = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), request.Body)).ToLowerInvariant();
        Assert.Equal(expectedSign, request.Message.Headers.GetValues("X-API-SIGN").Single());
        Assert.True(data!["ok"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Non_zero_envelope_code_is_an_api_error_carrying_the_provider_message()
    {
        var handler = new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("""{"code":301,"msg":"Invalid address","data":null}"""));
        var transport = Transport(handler);
        var responses = new List<SwapProviderApiResponseLog>();
        transport.AttachApiResponseLogger(responses.Add);

        var error = await Assert.ThrowsAsync<FixedFloatApiException>(() => transport.PostAsync("create", new JsonObject(), CancellationToken.None));

        Assert.Equal(FixedFloatApiErrorKind.Api, error.Kind);
        Assert.Equal("Invalid address", error.Message);
        Assert.Equal("301", error.FixedFloatCode);
        Assert.Equal("Invalid address", error.FixedFloatMessage);
        Assert.Null(error.Status);
        Assert.Equal(SwapTransportFailure.Refused, SwapTransportFailures.Classify(error));
        var log = Assert.Single(responses);
        Assert.Equal(("ff-test", "create", 200, true, "301", "Invalid address"), (log.Provider, log.Path, log.Status, log.Ok, log.Code, log.Message));
    }

    [Fact]
    public async Task Http_500_is_an_http_error()
    {
        var handler = new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("""{"code":1,"msg":"boom"}""", HttpStatusCode.InternalServerError));
        var transport = Transport(handler);

        var error = await Assert.ThrowsAsync<FixedFloatApiException>(() => transport.PostAsync("order", new JsonObject(), CancellationToken.None));

        Assert.Equal(FixedFloatApiErrorKind.Http, error.Kind);
        Assert.Equal(500, error.Status);
        Assert.Equal("FixedFloat order failed with HTTP 500: boom", error.Message);
        Assert.Equal(SwapTransportFailure.Unreachable, SwapTransportFailures.Classify(error));
    }

    [Fact]
    public async Task Http_429_is_rate_limited_and_marks_the_weight_budget()
    {
        var handler = new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("", HttpStatusCode.TooManyRequests));
        var transport = Transport(handler);
        var budget = new RecordingWeightBudget();
        transport.AttachWeightBudget(budget);

        var error = await Assert.ThrowsAsync<FixedFloatApiException>(() => transport.PostAsync("price", new JsonObject(), CancellationToken.None));

        Assert.Equal(FixedFloatApiErrorKind.RateLimited, error.Kind);
        Assert.Equal(429, error.Status);
        Assert.Equal("FixedFloat price failed with HTTP 429.", error.Message);
        Assert.Equal(new[] { "price" }, budget.Reserved);
        Assert.Equal(1, budget.RateLimitedCount);
        Assert.Equal(SwapTransportFailure.RateLimited, SwapTransportFailures.Classify(error));
    }

    [Fact]
    public async Task Weight_budget_denial_short_circuits_before_any_request()
    {
        var handler = new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("""{"code":0,"data":{}}"""));
        var transport = Transport(handler);
        var clock = 1_000L;
        var budget = new SwapProviderWeightBudget("ff-test", () => clock);
        budget.MarkRateLimited();
        transport.AttachWeightBudget(budget);

        var error = await Assert.ThrowsAsync<SwapWeightBudgetException>(() => transport.PostAsync("order", new JsonObject(), CancellationToken.None));

        Assert.Empty(handler.Requests);
        Assert.Equal(SwapTransportFailure.RateLimited, SwapTransportFailures.Classify(error));
    }

    [Fact]
    public async Task Invalid_json_body_is_an_invalid_json_error()
    {
        var handler = new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Text("<html>nope</html>", "text/html"));
        var transport = Transport(handler);

        var error = await Assert.ThrowsAsync<FixedFloatApiException>(() => transport.PostAsync("ccies", new JsonObject(), CancellationToken.None));

        Assert.Equal(FixedFloatApiErrorKind.InvalidJson, error.Kind);
        Assert.Equal(200, error.Status);
        Assert.Equal("FixedFloat ccies returned invalid JSON.", error.Message);
        Assert.Equal(SwapTransportFailure.Unreachable, SwapTransportFailures.Classify(error));
    }

    [Fact]
    public async Task Slow_provider_is_a_timeout_error()
    {
        var handler = new FakeSwapProviderHandler(async (_, cancellationToken) =>
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return FakeSwapProviderHandler.Json("{}");
        });
        var transport = Transport(handler, timeoutMs: 50);

        var error = await Assert.ThrowsAsync<FixedFloatApiException>(() => transport.PostAsync("create", new JsonObject(), CancellationToken.None));

        Assert.Equal(FixedFloatApiErrorKind.Timeout, error.Kind);
        Assert.Equal("FixedFloat create request timed out.", error.Message);
        Assert.Equal(SwapTransportFailure.Unreachable, SwapTransportFailures.Classify(error));
    }

    [Fact]
    public async Task Connection_failure_is_a_network_error()
    {
        var handler = new FakeSwapProviderHandler(_ => throw new HttpRequestException("connection refused"));
        var transport = Transport(handler);

        var error = await Assert.ThrowsAsync<FixedFloatApiException>(() => transport.PostAsync("create", new JsonObject(), CancellationToken.None));

        Assert.Equal(FixedFloatApiErrorKind.Network, error.Kind);
        Assert.Equal("FixedFloat create request failed before a response was received.", error.Message);
    }

    [Fact]
    public async Task Request_log_never_carries_the_order_token()
    {
        var handler = new FakeSwapProviderHandler(_ => FakeSwapProviderHandler.Json("""{"code":0,"data":{}}"""));
        var transport = Transport(handler);
        var requests = new List<SwapProviderApiRequestLog>();
        transport.AttachApiRequestLogger(requests.Add);

        await transport.PostAsync("order", new JsonObject { ["id"] = "ORD1", ["token"] = "very-secret" }, CancellationToken.None);

        var log = Assert.Single(requests);
        Assert.Equal("order", log.Path);
        Assert.DoesNotContain("very-secret", log.BodyJson);
        Assert.Contains("ORD1", log.BodyJson);
        Assert.Contains("very-secret", handler.Requests.Single().BodyText);
    }

    [Fact]
    public async Task Get_text_sends_the_accept_header_and_fails_closed_on_http_errors()
    {
        var handler = new FakeSwapProviderHandler(request =>
            request.Path == "/rates/fixed.xml"
                ? FakeSwapProviderHandler.Text("<rates/>", "application/xml")
                : FakeSwapProviderHandler.Text("nope", "text/plain", HttpStatusCode.BadGateway));
        var transport = Transport(handler);

        Assert.Equal("<rates/>", await transport.GetTextAsync("/rates/fixed.xml", CancellationToken.None));
        Assert.Equal("application/xml, text/xml, */*", handler.Requests[0].Message.Headers.Accept.ToString());
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => transport.GetTextAsync("/rates/float.xml", CancellationToken.None));
        Assert.Equal("FixedFloat rates float.xml failed with HTTP 502.", error.Message);
    }
}
