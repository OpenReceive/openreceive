#nullable enable
using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BTCPayServer.Plugins.OpenReceive.Controllers;

/// <summary>
/// The payer's swap routes, called by the checkout component. Anonymous on purpose: the
/// BTCPay invoice id is the payer's bearer, exactly as it is for BTCPay's own checkout
/// page and status endpoint (plugin plan 0.22); a swap is addressed by its own id and
/// must belong to that invoice. No BTCPay rate-limit zone: the public-invoices zone
/// DELAYS excess requests (4/min, burst 10), which stalls a checkout that polls every
/// five seconds and a payer who tries three assets. Abuse is bounded instead by the
/// invoice id being required, by "one live order per invoice and asset" (a repeat
/// create re-serves the row without a provider call), and by the per-provider weight
/// budget on provider calls.
/// </summary>
[AllowAnonymous]
[IgnoreAntiforgeryToken]
[Route("api/plugins/openreceive/swaps")]
public sealed class OpenReceiveSwapApiController : ControllerBase
{
    private readonly SwapService _swaps;

    public OpenReceiveSwapApiController(SwapService swaps)
    {
        _swaps = swaps;
    }

    public sealed class CreateSwapRequest
    {
        public string? InvoiceId { get; set; }
        public string? PayInAsset { get; set; }
    }

    public sealed class RefundRequest
    {
        public string? RefundAddress { get; set; }
    }

    [HttpPost("")]
    public async Task<IActionResult> Create([FromBody] CreateSwapRequest? request, CancellationToken cancellationToken)
    {
        if (request?.InvoiceId is not { Length: > 0 and <= 64 } invoiceId || request.PayInAsset is not { Length: > 0 and <= 32 } asset)
        {
            return Problem(400, "invalid_request", "invoiceId and payInAsset are required.");
        }
        try
        {
            return Json(await _swaps.CreateAsync(invoiceId, asset, cancellationToken));
        }
        catch (SwapRequestException e)
        {
            return Problem(e.Status, e.Code, e.Message);
        }
    }

    [HttpGet("{invoiceId}/{swapId}")]
    public async Task<IActionResult> Get(string invoiceId, string swapId, CancellationToken cancellationToken)
    {
        if (!Plausible(invoiceId) || !Plausible(swapId)) return Problem(404, "swap_not_found", "Swap not found.");
        var model = await _swaps.GetAsync(invoiceId, swapId, cancellationToken);
        return model is null ? Problem(404, "swap_not_found", "Swap not found.") : Json(model);
    }

    [HttpPost("{invoiceId}/{swapId}/refund")]
    public async Task<IActionResult> Refund(string invoiceId, string swapId, [FromBody] RefundRequest? request, CancellationToken cancellationToken)
    {
        if (!Plausible(invoiceId) || !Plausible(swapId)) return Problem(404, "swap_not_found", "Swap not found.");
        if (request?.RefundAddress is not { Length: > 0 and <= 200 } address)
        {
            return Problem(400, "invalid_refund_address", "refundAddress is required.");
        }
        try
        {
            return Json(await _swaps.RefundAsync(invoiceId, swapId, address, cancellationToken));
        }
        catch (SwapRequestException e)
        {
            return Problem(e.Status, e.Code, e.Message);
        }
    }

    private static bool Plausible(string value) => value.Length is > 0 and <= 64;

    // BTCPay's MVC pipeline serializes with Newtonsoft (camelCase); the checkout
    // contract is snake_case like the rest of OpenReceive, so serialize explicitly.
    private static readonly JsonSerializerOptions WireJson = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    private ContentResult Json(object model, int status = 200) =>
        new() { Content = JsonSerializer.Serialize(model, WireJson), ContentType = "application/json; charset=utf-8", StatusCode = status };

    private ContentResult Problem(int status, string code, string message) =>
        Json(new { code, message }, status);
}
