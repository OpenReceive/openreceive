using BTCPayServer.Lightning;
using NBitcoin;
using OpenReceive.FakeLsc;

// A fake Lightning Swap Connect (FixedFloat-compatible) provider for BTCPay plugin
// end-to-end tests. Every request is forwarded to FakeLscProviderCore; the
// /__testkit/ control surface scripts order lifecycles from the outside.
//
//   --port 7788                 listen port (default 7788)
//   --key / --secret            API credentials the client must sign with
//   --payer "<connstr>"         BTCPayServer.Lightning connection string; pays each completed order's bolt11
//   --network regtest           NBitcoin network for --payer (default regtest)
//   --cert /path.pfx            serve HTTPS with this certificate (plain HTTP when absent)
//   --cert-password ...         password of the pfx
//   --deposit-window 900        seconds an order's deposit window stays open

var arguments = ParseArgs(args);
var port = int.Parse(arguments.GetValueOrDefault("port", "7788"));
var certPath = arguments.GetValueOrDefault("cert");
var certPassword = arguments.GetValueOrDefault("cert-password");

var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(console => console.SingleLine = true);
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Logging.AddFilter("FakeLsc", LogLevel.Information);
builder.WebHost.ConfigureKestrel(kestrel =>
{
    kestrel.ListenAnyIP(port, listen =>
    {
        if (certPath is not null) listen.UseHttps(certPath, certPassword);
    });
});

var app = builder.Build();
var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("FakeLsc");

var payerConnectionString = arguments.GetValueOrDefault("payer");
var network = Network.GetNetwork(arguments.GetValueOrDefault("network", "regtest"))
    ?? throw new ArgumentException("Unknown --network.");
Func<string, CancellationToken, Task>? payer = null;
if (payerConnectionString is not null)
{
    var lightning = new LightningClientFactory(network).Create(payerConnectionString);
    payer = async (bolt11, ct) =>
    {
        var response = await lightning.Pay(bolt11, ct);
        if (response.Result != PayResult.Ok)
            throw new InvalidOperationException($"Lightning payment {response.Result}: {response.ErrorDetail}");
    };
}

var options = new FakeLscOptions
{
    Key = arguments.GetValueOrDefault("key", "test-key"),
    Secret = arguments.GetValueOrDefault("secret", "test-secret"),
    DepositWindowSeconds = int.Parse(arguments.GetValueOrDefault("deposit-window", "900")),
    Payer = payer,
    Log = message => log.LogInformation("{Message}", message),
};
var core = new FakeLscProviderCore(options);

// ----- control surface --------------------------------------------------------

app.MapGet("/__testkit/health", () => Results.Json(new { ok = true }));

app.MapGet("/__testkit/lsc-uri", (HttpRequest request) =>
{
    var host = request.Query["host"].FirstOrDefault() ?? request.Host.Value ?? $"localhost:{port}";
    var uri = $"lightning+swapconnect://{host}/?key={Uri.EscapeDataString(options.Key)}&secret={Uri.EscapeDataString(options.Secret)}";
    return Results.Json(new { uri });
});

app.MapPost("/__testkit/script", (ScriptRequest body) =>
    Control(() => core.Script(body.Selector, body.States)));

app.MapPost("/__testkit/force-refund-required", (ForceRequest body) =>
    Control(() => core.ForceRefundRequired(body.Selector, body.Reason ?? "underpaid")));

app.MapPost("/__testkit/force-attention", (ForceRequest body) =>
    Control(() => core.ForceAttention(body.Selector, body.Reason ?? "provider_reported_emergency")));

app.MapPost("/__testkit/force-create-error", (CreateErrorRequest body) =>
    Control(() => core.ForceCreateError(body.Message ?? "Fake LSC create failed.")));

app.MapPost("/__testkit/rate-limit", (RateLimitRequest body) =>
    Control(() => core.RateLimitNext(body.Count)));

app.MapGet("/__testkit/orders", () => Results.Json(new
{
    orders = core.Orders.Select(o => new { id = o.Id, asset = o.Asset, state = o.State, bolt11 = o.Bolt11 }),
    last_payer_error = core.LastPayerError,
}));

// ----- everything else is the provider ------------------------------------------
// A catch-all route (not MapFallback: that one skips paths that look like files,
// which would silently 404 /rates/fixed.xml) so the /__testkit endpoints above still
// win routing while every provider path reaches the core.

app.Map("{**providerPath}", async (HttpContext context) =>
{
    using var reader = new StreamReader(context.Request.Body);
    var body = await reader.ReadToEndAsync(context.RequestAborted);
    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var (name, values) in context.Request.Headers) headers[name] = values.ToString();

    var response = await core.HandleAsync(
        context.Request.Method,
        context.Request.Path + context.Request.QueryString,
        headers,
        body,
        context.RequestAborted);
    context.Response.StatusCode = response.Status;
    context.Response.ContentType = response.ContentType;
    await context.Response.WriteAsync(response.Body, context.RequestAborted);
});

log.LogInformation("Fake LSC listening on {Scheme}://0.0.0.0:{Port} (payer: {Payer})",
    certPath is null ? "http" : "https", port, payerConnectionString is null ? "none" : "configured");
app.Run();

static IResult Control(Action action)
{
    try
    {
        action();
        return Results.Json(new { ok = true });
    }
    catch (ArgumentException ex)
    {
        return Results.Json(new { ok = false, error = ex.Message }, statusCode: 400);
    }
}

static Dictionary<string, string> ParseArgs(string[] args)
{
    var parsed = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var i = 0; i < args.Length; i++)
    {
        if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
        var name = args[i][2..];
        var equals = name.IndexOf('=');
        if (equals >= 0)
        {
            parsed[name[..equals]] = name[(equals + 1)..];
        }
        else if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
        {
            parsed[name] = args[++i];
        }
        else
        {
            parsed[name] = "true";
        }
    }
    return parsed;
}

sealed record ScriptRequest(string Selector, string[] States);
sealed record ForceRequest(string Selector, string? Reason);
sealed record CreateErrorRequest(string? Message);
sealed record RateLimitRequest(int Count);
