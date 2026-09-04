using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenReceive.IntegrationTests;

/// <summary>
/// The running regtest stack, addressed by environment variables so the same tests run
/// from the host (127.0.0.1 ports) or inside the compose network (service names):
///   OPENRECEIVE_E2E_BTCPAY_URL   e.g. http://127.0.0.1:14180 or http://btcpayserver:49392
///   OPENRECEIVE_E2E_TESTKIT_URL  e.g. http://127.0.0.1:17790 (the receive-only wallet's control API)
///   OPENRECEIVE_E2E_TESTKIT_SPEND_URL  e.g. http://127.0.0.1:17791 (advertises pay_invoice)
///   OPENRECEIVE_E2E_FAKELSC_URL  e.g. https://127.0.0.1:17788 (control API; self-signed)
///   OPENRECEIVE_E2E_FAKELSC_HOST e.g. fake-lsc:7788 (the host BTCPay reaches the provider at)
///   OPENRECEIVE_E2E_CUSTOMER_LND_URL e.g. http://127.0.0.1:35532 — optional; when unset the
///     payer is reached through docker (`docker run … curl http://customer_lnd:8080`).
/// One BTCPay user + store per test run, created on first use.
/// </summary>
public sealed class E2eStack : IAsyncLifetime
{
    public static string? BtcPayUrl => Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_BTCPAY_URL");
    public static bool Enabled => !string.IsNullOrEmpty(BtcPayUrl);

    public string TestkitUrl { get; } = Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_TESTKIT_URL") ?? "http://127.0.0.1:17790";
    public string TestkitSpendUrl { get; } = Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_TESTKIT_SPEND_URL") ?? "http://127.0.0.1:17791";
    public string FakeLscUrl { get; } = Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_FAKELSC_URL") ?? "https://127.0.0.1:17788";
    public string FakeLscHost { get; } = Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_FAKELSC_HOST") ?? "fake-lsc:7788";
    public string? CustomerLndUrl { get; } = Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_CUSTOMER_LND_URL");
    public string ComposeNetwork { get; } = Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_NETWORK") ?? "openreceive-btcpay_default";

    public HttpClient Http { get; } = new(new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, _, _, _) => true }) { Timeout = TimeSpan.FromSeconds(60) };
    public string StoreId { get; private set; } = string.Empty;
    public string ApiKey { get; private set; } = string.Empty;
    public string Email { get; } = $"e2e-{Guid.NewGuid():N}@openreceive.test";
    public const string Password = "OpenReceive-e2e-Passw0rd!";

    public async ValueTask InitializeAsync()
    {
        if (!Enabled) return;
        var btcpay = BtcPayUrl!.TrimEnd('/');
        var presetKey = Environment.GetEnvironmentVariable("OPENRECEIVE_E2E_API_KEY");
        if (!string.IsNullOrEmpty(presetKey))
        {
            // BTCPay closes public registration after the first admin; a key minted earlier
            // (docker/e2e.sh saves one under docker/.state/e2e-store) keeps working.
            ApiKey = presetKey;
            var store0 = await BtcPay(HttpMethod.Post, "/api/v1/stores", new { name = "OpenReceive e2e", defaultCurrency = "USD" });
            StoreId = store0!["id"]!.GetValue<string>();
            return;
        }
        // The first registered user becomes admin (BTCPAY_ALLOW-ADMIN-REGISTRATION); later ones are plain users, which is enough.
        await Http.PostAsJsonAsync($"{btcpay}/api/v1/users", new { email = Email, password = Password, isAdministrator = true });
        using var basic = new HttpRequestMessage(HttpMethod.Post, $"{btcpay}/api/v1/api-keys")
        {
            Content = JsonContent.Create(new { label = "e2e", permissions = new[] { "unrestricted" } }),
        };
        basic.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{Email}:{Password}")));
        var keyResponse = await Http.SendAsync(basic);
        keyResponse.EnsureSuccessStatusCode();
        ApiKey = (await keyResponse.Content.ReadFromJsonAsync<JsonObject>())!["apiKey"]!.GetValue<string>();
        var store = await BtcPay(HttpMethod.Post, "/api/v1/stores", new { name = "OpenReceive e2e", defaultCurrency = "USD" });
        StoreId = store!["id"]!.GetValue<string>();
    }

    public ValueTask DisposeAsync()
    {
        Http.Dispose();
        return ValueTask.CompletedTask;
    }

    public async Task<JsonNode?> BtcPay(HttpMethod method, string path, object? body = null, bool ensureSuccess = true)
    {
        using var request = new HttpRequestMessage(method, $"{BtcPayUrl!.TrimEnd('/')}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("token", ApiKey);
        if (body is not null) request.Content = JsonContent.Create(body);
        var response = await Http.SendAsync(request);
        if (ensureSuccess) Assert.True(response.IsSuccessStatusCode, $"{method} {path} -> {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        var text = await response.Content.ReadAsStringAsync();
        return text.Length == 0 ? null : JsonNode.Parse(text);
    }

    public async Task<(int Status, JsonNode? Body)> BtcPayRaw(HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, $"{BtcPayUrl!.TrimEnd('/')}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("token", ApiKey);
        if (body is not null) request.Content = JsonContent.Create(body);
        var response = await Http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        return ((int)response.StatusCode, text.Length == 0 ? null : JsonNode.Parse(text));
    }

    /// <summary>The payer's anonymous swap routes (no API key).</summary>
    public async Task<(int Status, JsonNode? Body)> Public(HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, $"{BtcPayUrl!.TrimEnd('/')}{path}");
        if (body is not null) request.Content = JsonContent.Create(body);
        var response = await Http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        return ((int)response.StatusCode, text.Length == 0 ? null : JsonNode.Parse(text));
    }

    public Task<string> TestkitNwcUri() => Http.GetStringAsync($"{TestkitUrl}/uri");
    public Task<string> TestkitSpendNwcUri() => Http.GetStringAsync($"{TestkitSpendUrl}/uri");

    public async Task<string> FakeLscUri()
    {
        var node = await Http.GetFromJsonAsync<JsonObject>($"{FakeLscUrl}/__testkit/lsc-uri?host={Uri.EscapeDataString(FakeLscHost)}");
        return node!["uri"]!.GetValue<string>();
    }

    public async Task FakeLsc(string path, object body)
    {
        var response = await Http.PostAsJsonAsync($"{FakeLscUrl}/__testkit/{path}", body);
        response.EnsureSuccessStatusCode();
    }

    /// <summary>Pays a BOLT11 from customer_lnd (REST, no macaroons), directly or through a docker helper on the compose network.</summary>
    public async Task<JsonNode?> PayFromCustomer(string bolt11)
    {
        if (CustomerLndUrl is not null)
        {
            // LND 0.21 dropped the legacy SendPaymentSync route; the router API streams
            // status objects until the payment reaches a final state.
            var response = await Http.PostAsJsonAsync($"{CustomerLndUrl.TrimEnd('/')}/v2/router/send", new { payment_request = bolt11, timeout_seconds = 60, fee_limit_sat = 1000 });
            var streamed = (await response.Content.ReadAsStringAsync()).Split('\n', StringSplitOptions.RemoveEmptyEntries);
            return streamed.Length == 0 ? null : JsonNode.Parse(streamed[^1]);
        }
        var psi = new System.Diagnostics.ProcessStartInfo("docker")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in new[] { "run", "--rm", "--network", ComposeNetwork, "curlimages/curl:8.10.1", "-sS", "-m", "120", "-X", "POST", "-H", "Content-Type: application/json", "--data", $"{{\"payment_request\":\"{bolt11}\",\"timeout_seconds\":60,\"fee_limit_sat\":1000}}", "http://customer_lnd:8080/v2/router/send" })
        {
            psi.ArgumentList.Add(arg);
        }
        using var process = System.Diagnostics.Process.Start(psi)!;
        var output = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        return lines.Length == 0 ? null : JsonNode.Parse(lines[^1]);
    }

    public async Task<string> CreateInvoiceAsync(string amount)
    {
        var invoice = await BtcPay(HttpMethod.Post, $"/api/v1/stores/{StoreId}/invoices", new { amount, currency = "USD", checkout = new { paymentMethods = new[] { "BTC-LN" } } });
        return invoice!["id"]!.GetValue<string>();
    }

    public async Task<string> Bolt11Of(string invoiceId)
    {
        var methods = await BtcPay(HttpMethod.Get, $"/api/v1/stores/{StoreId}/invoices/{invoiceId}/payment-methods");
        return methods!.AsArray().First(m => m!["paymentMethodId"]!.GetValue<string>() == "BTC-LN")!["destination"]!.GetValue<string>();
    }

    public async Task<string> InvoiceStatus(string invoiceId) =>
        (await BtcPay(HttpMethod.Get, $"/api/v1/stores/{StoreId}/invoices/{invoiceId}"))!["status"]!.GetValue<string>();

    public async Task<string> WaitForInvoiceStatus(string invoiceId, string expected, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        var status = await InvoiceStatus(invoiceId);
        while (status != expected && DateTime.UtcNow < deadline)
        {
            await Task.Delay(1000);
            status = await InvoiceStatus(invoiceId);
        }
        return status;
    }

    public static string Redact(string nwcUri) => System.Text.RegularExpressions.Regex.Replace(nwcUri, "secret=[0-9a-f]{64}", "secret=[REDACTED]");
}
