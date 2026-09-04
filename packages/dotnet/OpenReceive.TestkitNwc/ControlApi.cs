using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace OpenReceive.TestkitNwc;

/// <summary>Tiny Kestrel control surface a test harness drives: health, the NWC URI, settle, invoices.</summary>
public static class ControlApi
{
    public static WebApplication Build(int port, TestkitWalletService service, IWalletBackend backend,
        Func<bool> relayConnected, string nwcUri)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions());
        builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
        builder.Logging.ClearProviders();
        builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
        builder.Logging.AddFilter("Microsoft", LogLevel.Warning);
        var app = builder.Build();

        app.MapGet("/health", () => Results.Json(new JsonObject
        {
            ["ok"] = true,
            ["relayConnected"] = relayConnected(),
        }));

        app.MapGet("/uri", () => Results.Text(nwcUri, "text/plain"));

        app.MapPost("/settle/{paymentHash}", async (string paymentHash) =>
        {
            if (backend is not InMemoryWalletBackend memory)
                return Results.Json(new JsonObject { ["error"] = "settle is only available on the memory backend" }, statusCode: 409);
            try
            {
                await memory.SettleAsync(paymentHash.ToLowerInvariant());
                return Results.NoContent();
            }
            catch (KeyNotFoundException)
            {
                return Results.NotFound();
            }
        });

        app.MapGet("/invoices", async (CancellationToken ct) =>
        {
            var invoices = await backend.ListIncomingAsync(null, null, unpaid: true, ct);
            var rows = invoices.Select(i =>
            {
                var tx = Nip47Json.Transaction(i);
                tx.Remove("preimage");
                return (JsonNode)tx;
            }).ToArray();
            return Results.Json(new JsonArray(rows));
        });

        return app;
    }
}
