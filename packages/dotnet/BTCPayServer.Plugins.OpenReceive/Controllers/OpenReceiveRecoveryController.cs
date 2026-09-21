#nullable enable
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BTCPayServer.Plugins.OpenReceive.Controllers;

[AllowAnonymous]
public sealed class OpenReceiveRecoveryController : Controller
{
    private readonly SwapService _swaps;
    public OpenReceiveRecoveryController(SwapService swaps) => _swaps = swaps;

    [HttpGet("plugins/openreceive/invoices/{invoiceId}/recovery")]
    public async Task<IActionResult> Recovery(string invoiceId, CancellationToken cancellationToken)
    {
        if (invoiceId.Length is < 1 or > 64 || await _swaps.RecoveryAsync(invoiceId, null, 1, cancellationToken) is null) return NotFound();
        return View("~/Views/OpenReceiveRecovery/Recovery.cshtml", invoiceId);
    }
}
