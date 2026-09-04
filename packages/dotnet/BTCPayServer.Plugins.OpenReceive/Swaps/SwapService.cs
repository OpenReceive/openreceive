#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Settings;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// The swap rail (plugin plan design S): the payer's altcoin deposit is swapped by the
/// provider INTO the invoice's existing Lightning BOLT11, the one BTCPay minted in the
/// NWC wallet through our client. Settlement is BTCPay's own LightningListener; this
/// service owns provider orders, their recovery and refunds. Wallet settlement and
/// provider workflow recovery stay independent (swap-operations.md).
/// </summary>
public sealed class SwapService
{
    public const string PluginReasonReminted = "invoice_reminted_after_partial_payment";
    public const int ReserveWindowSeconds = 60;
    public const int NoDepositGraceSeconds = 15 * 60;
    public const int CompletedWithoutSettlementSeconds = 30 * 60;
    public static readonly TimeSpan RecommendedInvoiceExpiration = TimeSpan.FromMinutes(60);
    public static readonly TimeSpan MinimumInvoiceExpiration = TimeSpan.FromMinutes(45);

    private readonly ISwapStore _store;
    private readonly SwapProviderPool _providers;
    private readonly ISwapSettingsSource _settings;
    private readonly ISwapInvoiceSource _invoices;
    private readonly ILogger<SwapService> _logger;
    private readonly Func<long> _clock;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _creationGates = new(StringComparer.Ordinal);

    public SwapService(
        ISwapStore store,
        SwapProviderPool providers,
        ISwapSettingsSource settings,
        ISwapInvoiceSource invoices,
        ILogger<SwapService> logger,
        Func<long>? clock = null)
    {
        _store = store;
        _providers = providers;
        _settings = settings;
        _invoices = invoices;
        _logger = logger;
        _clock = clock ?? (static () => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    }

    public long Now => _clock();

    // ---- Availability: which pills the checkout shows, and why not ----

    public async Task<SwapAvailability> AvailabilityAsync(SwapInvoiceContext invoice, CancellationToken cancellationToken)
    {
        if (!invoice.LightningNodeIsOpenReceive) return SwapAvailability.NotOffered("lightning_node_not_openreceive");
        var settings = await _settings.GetAsync(invoice.StoreId);
        if (!settings.SwapsEnabled) return SwapAvailability.NotOffered("swaps_disabled");
        var providers = await _providers.ProvidersAsync(invoice.StoreId, cancellationToken);
        if (providers.Count == 0) return SwapAvailability.NotOffered("provider_unconfigured");
        if (!invoice.Payable) return SwapAvailability.NotOffered("invoice_not_payable");
        if (invoice.TopUp) return SwapAvailability.NotOffered("top_up_invoice");
        if (invoice.Bolt11 is null || invoice.PaymentHash is null) return SwapAvailability.NotOffered("no_lightning_prompt");
        if (invoice.HasPartialPayments) return SwapAvailability.NotOffered("partial_payment");
        var reminted = (await _store.ForInvoiceAsync(invoice.InvoiceId, cancellationToken)).Any(r => r.PluginReason == PluginReasonReminted);
        if (reminted) return SwapAvailability.NotOffered("invoice_reminted");

        var bolt11 = invoice.Bolt11;
        var paymentHash = invoice.PaymentHash;
        var amountMsats = invoice.InvoiceAmountMsats;
        if (amountMsats <= 0) return SwapAvailability.NotOffered("top_up_invoice");

        var provider = await _providers.SelectForCreateAsync(invoice.StoreId, cancellationToken) ?? providers[0];
        var minimumSeconds = provider.InvoiceExpirySeconds;
        var remaining = invoice.ExpiresAt - _clock();
        if (remaining < minimumSeconds)
        {
            return new SwapAvailability(false, "invoice_expires_too_soon", Array.Empty<SwapAssetOffer>(), bolt11, paymentHash, amountMsats, minimumSeconds);
        }

        var enabled = settings.EnabledPayInAssets.Count == 0
            ? OpenReceiveTables.SwapPayInAssets
            : OpenReceiveTables.SwapPayInAssets.Where(settings.EnabledPayInAssets.Contains).ToArray();
        IReadOnlyList<SwapProviderAsset> catalog;
        try
        {
            catalog = await provider.PayInAssetCatalogAsync(cancellationToken);
            _providers.MarkHealthy(provider);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _providers.MarkFailed(provider);
            _logger.LogWarning("swap.catalog.failed provider={Provider} error={Error}", provider.Name, e.Message);
            var failure = SwapTransportFailures.Classify(e) == SwapTransportFailure.RateLimited ? "provider_rate_limited" : "provider_unreachable";
            var unavailable = enabled.Select(asset => Offer(asset, false, failure, FixedFloatQuote.AvailabilityMessage(failure))).ToList();
            return new SwapAvailability(true, null, unavailable, bolt11, paymentHash, amountMsats, minimumSeconds);
        }
        var offers = new List<SwapAssetOffer>();
        foreach (var asset in enabled)
        {
            var entry = catalog.FirstOrDefault(c => c.PayAsset == asset);
            if (entry is null)
            {
                offers.Add(Offer(asset, false, "pair_temporarily_unavailable", FixedFloatQuote.AvailabilityMessage("pair_temporarily_unavailable")));
                continue;
            }
            if (entry.Available == false)
            {
                var reason = entry.UnavailableReason ?? "pair_temporarily_unavailable";
                offers.Add(Offer(asset, false, reason, entry.UnavailableMessage ?? FixedFloatQuote.AvailabilityMessage(reason)));
                continue;
            }
            if (entry.MinimumInvoiceAmountMsats is { } min && amountMsats < min)
            {
                offers.Add(Offer(asset, false, "amount_too_small", FixedFloatQuote.AvailabilityMessage("amount_too_small")));
                continue;
            }
            if (entry.MaximumInvoiceAmountMsats is { } max && amountMsats > max)
            {
                offers.Add(Offer(asset, false, "amount_too_large", FixedFloatQuote.AvailabilityMessage("amount_too_large")));
                continue;
            }
            offers.Add(Offer(asset, true, null, null));
        }
        return new SwapAvailability(true, null, offers, bolt11, paymentHash, amountMsats, minimumSeconds);
    }

    private static SwapAssetOffer Offer(string asset, bool available, string? reason, string? message)
    {
        var info = OpenReceiveTables.SwapAssetInfo[asset];
        return new SwapAssetOffer(asset, info.Label, info.NetworkLabel, available, reason, message);
    }

    // ---- Create / read / refund (payer routes) ----

    public async Task<SwapCheckoutModel> CreateAsync(string invoiceId, string payInAsset, CancellationToken cancellationToken)
    {
        if (!SwapAssets.IsSwapPayInAsset(payInAsset))
        {
            throw new SwapRequestException(400, "invalid_pay_in_asset", "Unknown pay-in asset.");
        }
        var invoice = await _invoices.LoadAsync(invoiceId, cancellationToken) ?? throw new SwapRequestException(404, "invoice_not_found", "Invoice not found.");
        var availability = await AvailabilityAsync(invoice, cancellationToken);
        if (!availability.Offered)
        {
            throw new SwapRequestException(409, availability.Reason ?? "swaps_unavailable", availability.Reason switch
            {
                "invoice_expires_too_soon" => $"This invoice expires in {Math.Max(0, (invoice.ExpiresAt - _clock()) / 60)} minutes; a swap needs at least {availability.MinimumInvoiceSeconds / 60}.",
                "partial_payment" => "This invoice already received a partial Lightning payment; finish paying it over Lightning.",
                _ => "Swaps are not available for this invoice.",
            });
        }
        var offer = availability.Assets.FirstOrDefault(a => a.PayInAsset == payInAsset)
                    ?? throw new SwapRequestException(409, "asset_not_offered", "This asset is not offered for this invoice.");
        if (!offer.Available)
        {
            throw new SwapRequestException(409, offer.Reason ?? "asset_unavailable", offer.Message ?? "This asset is temporarily unavailable.");
        }

        var key = $"{invoice.StoreId}:{invoice.InvoiceId}:{payInAsset}";
        var gate = _creationGates.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var dbLock = await _store.LockAsync(key, cancellationToken);
            var now = _clock();
            var live = await _store.FindLiveAsync(invoice.InvoiceId, payInAsset, cancellationToken);
            if (live is not null)
            {
                if (live.ProviderExpiresAt - ReserveWindowSeconds > now)
                {
                    return Model(live, invoice);
                }
                // Too close to the provider's deadline to be worth showing again: close it and mint a fresh order.
                live.State = "expired";
                live.StateReason = "superseded_near_provider_expiry";
                Touch(live, now, stateChanged: true);
                await _store.UpdateAsync(live, cancellationToken);
            }
            var order = await CreateProviderOrderAsync(invoice.StoreId, new CreateSwapInput(payInAsset, availability.Bolt11!, availability.InvoiceAmountMsats), cancellationToken);
            var row = new OpenReceiveSwap
            {
                StoreId = invoice.StoreId,
                InvoiceId = invoice.InvoiceId,
                PaymentHash = availability.PaymentHash!,
                Bolt11 = availability.Bolt11!,
                InvoiceAmountMsats = availability.InvoiceAmountMsats,
                CreatedAt = now,
                UpdatedAt = now,
                StateChangedAt = now,
                LastPolledAt = now,
            };
            Apply(row, order, now);
            await _store.InsertAsync(row, cancellationToken);
            _logger.LogInformation("swap.created invoice={Invoice} asset={Asset} provider={Provider} order={Order} state={State}",
                invoice.InvoiceId, payInAsset, row.Provider, row.ProviderOrderId, row.State);
            return Model(row, invoice);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<SwapOrder> CreateProviderOrderAsync(string storeId, CreateSwapInput input, CancellationToken cancellationToken)
    {
        var providers = await _providers.ProvidersAsync(storeId, cancellationToken);
        var preferred = await _providers.SelectForCreateAsync(storeId, cancellationToken);
        var ordered = preferred is null ? providers : new[] { preferred }.Concat(providers.Where(p => p.Name != preferred.Name)).ToList();
        Exception? last = null;
        foreach (var provider in ordered)
        {
            try
            {
                var order = await provider.CreateSwapAsync(input, cancellationToken);
                _providers.MarkHealthy(provider);
                return order;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                last = e;
                var failure = SwapTransportFailures.Classify(e);
                _logger.LogWarning("swap.create.failed provider={Provider} failure={Failure} error={Error}", provider.Name, failure, e.Message);
                if (failure is SwapTransportFailure.Unreachable or SwapTransportFailure.RateLimited)
                {
                    _providers.MarkFailed(provider);
                    continue; // backup only while the primary is down
                }
                break; // an application-level refusal is not something the backup fixes
            }
        }
        var classified = last is null ? null : SwapTransportFailures.Classify(last);
        throw classified switch
        {
            SwapTransportFailure.RateLimited => new SwapRequestException(503, "provider_rate_limited", "The swap provider is rate limited. Try again in a minute."),
            SwapTransportFailure.Unreachable => new SwapRequestException(502, "provider_unreachable", "The swap provider is temporarily unreachable."),
            _ => new SwapRequestException(502, "provider_refused", last?.Message ?? "The swap provider refused the order."),
        };
    }

    public async Task<SwapCheckoutModel?> GetAsync(string invoiceId, string swapId, CancellationToken cancellationToken)
    {
        var row = await _store.GetAsync(swapId, cancellationToken);
        if (row is null || !string.Equals(row.InvoiceId, invoiceId, StringComparison.Ordinal)) return null;
        return Model(row, await _invoices.LoadAsync(invoiceId, cancellationToken));
    }

    public async Task<SwapCheckoutModel> RefundAsync(string invoiceId, string swapId, string refundAddress, CancellationToken cancellationToken)
    {
        var row = await _store.GetAsync(swapId, cancellationToken);
        if (row is null || !string.Equals(row.InvoiceId, invoiceId, StringComparison.Ordinal))
        {
            throw new SwapRequestException(404, "swap_not_found", "Swap not found.");
        }
        var address = refundAddress.Trim();
        var assetInfo = OpenReceiveTables.SwapAssetInfo[row.PayInAsset];
        if (SwapAddress.RefundAddressError(row.PayInAsset, address, assetInfo.NetworkLabel) is { } error)
        {
            throw new SwapRequestException(400, "invalid_refund_address", error);
        }
        if (row.RefundAddress is not null)
        {
            throw new SwapRequestException(409, "refund_already_requested", "A refund address was already submitted for this swap.");
        }
        var provider = await _providers.ByNameAsync(row.StoreId, row.Provider, cancellationToken)
                       ?? throw new SwapRequestException(409, "provider_unconfigured", "The swap provider for this order is no longer configured.");
        var now = _clock();
        var fresh = await provider.GetStatusAsync(ToOrder(row), cancellationToken);
        Apply(row, fresh, now);
        if (row.State != "refund_required")
        {
            await _store.UpdateAsync(row, cancellationToken);
            throw new SwapRequestException(409, "refund_not_required", $"The provider reports this swap as {row.State}; a refund cannot be requested now.");
        }
        await provider.RequestRefundAsync(ToOrder(row), address, cancellationToken);
        row.RefundAddress = address;
        row.State = "refund_pending";
        Touch(row, now, stateChanged: true);
        await _store.UpdateAsync(row, cancellationToken);
        _logger.LogInformation("swap.refund.requested swap={Swap} provider={Provider} order={Order}", row.Id, row.Provider, row.ProviderOrderId);
        return Model(row, await _invoices.LoadAsync(invoiceId, cancellationToken));
    }

    // ---- Merchant side ----

    public Task<IReadOnlyList<OpenReceiveSwap>> ForInvoiceAsync(string invoiceId, CancellationToken cancellationToken) => _store.ForInvoiceAsync(invoiceId, cancellationToken);
    public Task<IReadOnlyList<OpenReceiveSwap>> ForStoreAsync(string storeId, int limit, CancellationToken cancellationToken) => _store.ForStoreAsync(storeId, limit, cancellationToken);
    public Task<int> CountAttentionAsync(string storeId, CancellationToken cancellationToken) => _store.CountAttentionAsync(storeId, cancellationToken);

    // ---- Poller ----

    /// <summary>One pass over live rows: refresh provider state for the ones whose cadence is due.</summary>
    public async Task<int> PollOnceAsync(CancellationToken cancellationToken)
    {
        var now = _clock();
        var refreshed = 0;
        foreach (var row in await _store.LiveAsync(200, cancellationToken))
        {
            if (row.LastPolledAt is { } last && now - last < PollIntervalSeconds(row)) continue;
            try
            {
                await RefreshRowAsync(row, cancellationToken);
                refreshed++;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _logger.LogWarning("swap.poll.failed swap={Swap} provider={Provider} error={Error}", row.Id, row.Provider, e.Message);
                row.LastPolledAt = _clock();
                await _store.UpdateAsync(row, cancellationToken);
            }
        }
        return refreshed;
    }

    /// <summary>5 s while the deposit could still change the outcome; 30 s once the invoice's Lightning side settled.</summary>
    public static int PollIntervalSeconds(OpenReceiveSwap row) => row.WalletSettledAt is null ? 5 : 30;

    public async Task RefreshRowAsync(OpenReceiveSwap row, CancellationToken cancellationToken)
    {
        var now = _clock();
        var provider = await _providers.ByNameAsync(row.StoreId, row.Provider, cancellationToken);
        if (provider is null)
        {
            _logger.LogWarning("swap.poll.provider_missing swap={Swap} provider={Provider}", row.Id, row.Provider);
            row.LastPolledAt = now;
            await _store.UpdateAsync(row, cancellationToken);
            return;
        }
        var fresh = await provider.GetStatusAsync(ToOrder(row), cancellationToken);
        var before = row.State;
        Apply(row, fresh, now);
        if (row.State == "awaiting_deposit" && row.DepositTxId is null && now > row.ProviderExpiresAt + NoDepositGraceSeconds)
        {
            row.State = "expired";
            row.StateReason = "no_deposit_before_provider_expiry";
            Touch(row, now, stateChanged: true);
        }
        else if (row.State == "completed" && row.WalletSettledAt is null && now - row.StateChangedAt > CompletedWithoutSettlementSeconds)
        {
            // The one reserved reason in kernel-tables.json; this plugin is its first emitter (scope-lock.md records the asymmetry).
            row.State = "attention";
            row.Attention = true;
            row.AttentionReason = "provider_completed_without_wallet_settlement";
            Touch(row, now, stateChanged: true);
        }
        row.LastPolledAt = now;
        await _store.UpdateAsync(row, cancellationToken);
        if (before != row.State)
        {
            _logger.LogInformation("swap.state swap={Swap} invoice={Invoice} {From}->{To}", row.Id, row.InvoiceId, before, row.State);
        }
    }

    // ---- BTCPay invoice events ----

    /// <summary>The invoice's Lightning side settled: stamp the rows aimed at that hash; siblings keep polling slowly.</summary>
    public async Task OnLightningPaymentAsync(string invoiceId, string paymentHash, CancellationToken cancellationToken)
    {
        var now = _clock();
        foreach (var row in await _store.ForInvoiceAsync(invoiceId, cancellationToken))
        {
            if (row.WalletSettledAt is not null || !string.Equals(row.PaymentHash, paymentHash, StringComparison.OrdinalIgnoreCase)) continue;
            row.WalletSettledAt = now;
            Touch(row, now, stateChanged: false);
            await _store.UpdateAsync(row, cancellationToken);
            _logger.LogInformation("swap.wallet_settled swap={Swap} invoice={Invoice} state={State}", row.Id, invoiceId, row.State);
        }
    }

    /// <summary>BTCPay re-minted the BOLT11 after a partial payment: stop offering swaps, keep polling the old orders.</summary>
    public async Task OnLightningRemintAsync(string invoiceId, CancellationToken cancellationToken)
    {
        var now = _clock();
        foreach (var row in await _store.ForInvoiceAsync(invoiceId, cancellationToken))
        {
            if (row.IsTerminal || row.PluginReason == PluginReasonReminted) continue;
            row.PluginReason = PluginReasonReminted;
            Touch(row, now, stateChanged: false);
            await _store.UpdateAsync(row, cancellationToken);
        }
    }

    // ---- Mapping ----

    public static SwapOrder ToOrder(OpenReceiveSwap row) => new()
    {
        Provider = row.Provider,
        ProviderOrderId = row.ProviderOrderId,
        ProviderToken = row.ProviderToken,
        PayInAsset = row.PayInAsset,
        DepositAddress = row.DepositAddress,
        DepositMemo = row.DepositMemo,
        DepositAmount = row.DepositAmount,
        ExpiresAt = row.ProviderExpiresAt,
        State = row.State,
        DepositTxId = row.DepositTxId,
        PayoutTxId = row.PayoutTxId,
        RefundTxId = row.RefundTxId,
        Attention = row.Attention ? true : null,
        AttentionReason = row.AttentionReason,
        RefundReason = row.RefundReason,
        DepositReceivedAmount = row.DepositReceivedAmount,
        RefundAmount = row.RefundAmount,
        EmergencyRepeat = row.EmergencyRepeat ? true : null,
        Fee = row.FeeCurrency is not null && row.PayInFiat is not null && row.PayoutFiat is not null ? new SwapFee(row.FeeCurrency, row.PayInFiat, row.PayoutFiat) : null,
    };

    private static void Apply(OpenReceiveSwap row, SwapOrder order, long now)
    {
        var stateChanged = row.State != order.State;
        row.Provider = order.Provider;
        row.ProviderOrderId = order.ProviderOrderId;
        row.ProviderToken = order.ProviderToken;
        row.PayInAsset = order.PayInAsset;
        row.DepositAddress = order.DepositAddress;
        row.DepositMemo = order.DepositMemo ?? row.DepositMemo;
        row.DepositAmount = order.DepositAmount;
        row.ProviderExpiresAt = order.ExpiresAt;
        row.State = order.State;
        row.Attention = order.Attention ?? false;
        row.AttentionReason = order.AttentionReason;
        row.RefundReason = order.RefundReason ?? row.RefundReason;
        row.DepositTxId = order.DepositTxId ?? row.DepositTxId;
        row.PayoutTxId = order.PayoutTxId ?? row.PayoutTxId;
        row.RefundTxId = order.RefundTxId ?? row.RefundTxId;
        row.DepositReceivedAmount = order.DepositReceivedAmount ?? row.DepositReceivedAmount;
        row.RefundAmount = order.RefundAmount ?? row.RefundAmount;
        row.EmergencyRepeat = order.EmergencyRepeat ?? row.EmergencyRepeat;
        if (order.Fee is { } fee)
        {
            row.FeeCurrency = fee.Currency;
            row.PayInFiat = fee.PayInFiat;
            row.PayoutFiat = fee.PayoutFiat;
        }
        Touch(row, now, stateChanged);
    }

    private static void Touch(OpenReceiveSwap row, long now, bool stateChanged)
    {
        row.UpdatedAt = now;
        if (stateChanged) row.StateChangedAt = now;
    }

    private SwapCheckoutModel Model(OpenReceiveSwap row, SwapInvoiceContext? invoice) =>
        SwapCheckoutModel.From(row, _clock(), invoice?.ExpiresAt, invoice?.Status);
}
