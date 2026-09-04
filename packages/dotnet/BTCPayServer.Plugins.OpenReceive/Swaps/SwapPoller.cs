#nullable enable
using System;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Events;
using BTCPayServer.HostedServices;
using BTCPayServer.Logging;
using BTCPayServer.Payments;
using BTCPayServer.Payments.Lightning;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>Periodic provider polling for live swap rows (registered with AddScheduledTask every 5 s).</summary>
public sealed class SwapPoller : IPeriodicTask
{
    private readonly SwapService _swaps;
    private readonly ILogger<SwapPoller> _logger;
    private int _running;

    public SwapPoller(SwapService swaps, ILogger<SwapPoller> logger)
    {
        _swaps = swaps;
        _logger = logger;
    }

    public async Task Do(CancellationToken cancellationToken)
    {
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0) return;
        try
        {
            var refreshed = await _swaps.PollOnceAsync(cancellationToken);
            if (refreshed > 0) _logger.LogDebug("swap.poll refreshed={Count}", refreshed);
        }
        finally
        {
            Interlocked.Exchange(ref _running, 0);
        }
    }
}

/// <summary>
/// Listens to BTCPay's invoice events: a Lightning payment recorded for an invoice stamps
/// the swap rows aimed at its hash; a re-minted BTC-LN prompt (partial payment) stops
/// swaps for that invoice.
/// </summary>
public sealed class SwapInvoiceEventsService : EventHostedServiceBase
{
    private readonly SwapService _swaps;
    private readonly PaymentMethodId _lightning = PaymentTypes.LN.GetPaymentMethodId("BTC");

    public SwapInvoiceEventsService(EventAggregator eventAggregator, SwapService swaps, ILogger<SwapInvoiceEventsService> logger)
        : base(eventAggregator, logger)
    {
        _swaps = swaps;
    }

    protected override void SubscribeToEvents()
    {
        Subscribe<InvoiceEvent>();
        Subscribe<InvoiceNewPaymentDetailsEvent>();
    }

    protected override async Task ProcessEvent(object evt, CancellationToken cancellationToken)
    {
        switch (evt)
        {
            case InvoiceEvent { Payment: { } payment } invoiceEvent
                when payment.PaymentMethodId == _lightning && invoiceEvent.EventCode is InvoiceEventCode.ReceivedPayment or InvoiceEventCode.PaymentSettled or InvoiceEventCode.PaidInFull:
                await _swaps.OnLightningPaymentAsync(invoiceEvent.InvoiceId, payment.Id, cancellationToken);
                break;
            case InvoiceNewPaymentDetailsEvent details when details.PaymentMethodId == _lightning:
                await _swaps.OnLightningRemintAsync(details.InvoiceId, cancellationToken);
                break;
        }
    }
}
