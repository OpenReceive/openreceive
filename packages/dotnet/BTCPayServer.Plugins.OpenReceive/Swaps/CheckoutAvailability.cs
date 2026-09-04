#nullable enable
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// The swap availability for the invoice a checkout page is rendering, computed once per
/// request: both checkout extensions (the pills, the payment panel) read it, so the
/// provider is asked once per page, not once per extension.
/// </summary>
public static class CheckoutAvailability
{
    private const string Key = "openreceive.swap.availability";

    public static async Task<SwapAvailability?> ForRequestAsync(HttpContext http, string invoiceId, BtcPayInvoiceSource invoices, SwapService swaps)
    {
        if (http.Items.TryGetValue(Key, out var cached)) return cached as SwapAvailability;
        var context = await invoices.LoadAsync(invoiceId, http.RequestAborted);
        var availability = context is null ? null : await swaps.AvailabilityAsync(context, http.RequestAborted);
        http.Items[Key] = availability;
        return availability;
    }
}
