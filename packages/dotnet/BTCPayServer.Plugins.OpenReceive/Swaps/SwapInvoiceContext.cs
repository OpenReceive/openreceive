#nullable enable
using System;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Data;
using BTCPayServer.Lightning;
using BTCPayServer.Plugins.OpenReceive.Settings;
using BTCPayServer.Services.Invoices;
using BTCPayServer.Services.Stores;
using InvoiceStatus = BTCPayServer.Client.Models.InvoiceStatus;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Everything the swap rail needs to know about one BTCPay invoice, read once at the
/// boundary so <see cref="SwapService"/> stays a pure function of it (and testable
/// without BTCPay's repositories).
/// </summary>
public sealed record SwapInvoiceContext(
    string InvoiceId,
    string StoreId,
    string Status,
    bool Payable,
    bool TopUp,
    string? Bolt11,
    string? PaymentHash,
    long InvoiceAmountMsats,
    bool HasPartialPayments,
    long ExpiresAt,
    bool LightningNodeIsOpenReceive,
    decimal InvoicePrice = 0,
    string InvoiceCurrency = "");

public interface ISwapInvoiceSource
{
    Task<SwapInvoiceContext?> LoadAsync(string invoiceId, CancellationToken cancellationToken);
}

public interface ISwapSettingsSource
{
    Task<OpenReceiveStoreSettings> GetAsync(string storeId);
}

/// <summary>The BTCPay-backed source: invoice repository + store + the BTC-LN prompt's BOLT11.</summary>
public sealed class BtcPayInvoiceSource : ISwapInvoiceSource
{
    private readonly InvoiceRepository _invoices;
    private readonly StoreRepository _stores;
    private readonly OpenReceiveSettingsService _settings;

    public BtcPayInvoiceSource(InvoiceRepository invoices, StoreRepository stores, OpenReceiveSettingsService settings)
    {
        _invoices = invoices;
        _stores = stores;
        _settings = settings;
    }

    public async Task<SwapInvoiceContext?> LoadAsync(string invoiceId, CancellationToken cancellationToken)
    {
        var invoice = await _invoices.GetInvoice(invoiceId);
        if (invoice is null) return null;
        var store = await _stores.FindStore(invoice.StoreId);
        return store is null ? null : From(invoice, store);
    }

    public SwapInvoiceContext From(InvoiceEntity invoice, StoreData store)
    {
        var prompt = invoice.GetPaymentPrompt(_settings.LightningPaymentMethodId);
        string? bolt11 = null;
        string? paymentHash = null;
        long amountMsats = 0;
        if (prompt is { Activated: true } && !string.IsNullOrEmpty(prompt.Destination))
        {
            bolt11 = prompt.Destination;
            var request = BOLT11PaymentRequest.Parse(bolt11, _settings.BitcoinNetwork.NBitcoinNetwork);
            paymentHash = request.PaymentHash?.ToString();
            amountMsats = request.MinimumAmount.MilliSatoshi;
        }
        return new SwapInvoiceContext(
            invoice.Id,
            store.Id,
            invoice.Status.ToString(),
            invoice.Status == InvoiceStatus.New,
            invoice.IsUnsetTopUp(),
            bolt11,
            paymentHash,
            amountMsats,
            invoice.GetPayments(true).Count > 0,
            invoice.ExpirationTime.ToUnixTimeSeconds(),
            _settings.GetConnection(store) is not null,
            invoice.Price,
            invoice.Currency ?? string.Empty);
    }
}
