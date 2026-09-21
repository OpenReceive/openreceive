#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Data;
using BTCPayServer.Events;
using BTCPayServer.HostedServices;
using BTCPayServer.Payments;
using BTCPayServer.Payments.Lightning;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Settings;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using BTCPayServer.Services.Invoices;
using BTCPayServer.Services.Stores;
using Microsoft.Extensions.Logging;
using NBitcoin;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// Bridges every persisted mint to BTCPay's canonical historical destination and payment
/// services. Listener channels are only hints; the host payment row is acknowledgment.
/// No SDK attempt/gate state machine is introduced into BTCPay.
/// </summary>
public sealed class HistoricalInvoiceRecovery : IPeriodicTask
{
    private readonly IInvoiceStore _minted;
    private readonly ISwapStore _locks;
    private readonly InvoiceRepository _invoices;
    private readonly StoreRepository _stores;
    private readonly OpenReceiveSettingsService _settings;
    private readonly PaymentMethodHandlerDictionary _handlers;
    private readonly PaymentService _payments;
    private readonly EventAggregator _events;
    private readonly ILogger<HistoricalInvoiceRecovery> _logger;

    public HistoricalInvoiceRecovery(IInvoiceStore minted, ISwapStore locks, InvoiceRepository invoices,
        StoreRepository stores, OpenReceiveSettingsService settings, PaymentMethodHandlerDictionary handlers,
        PaymentService payments, EventAggregator events, ILogger<HistoricalInvoiceRecovery> logger)
    {
        _minted = minted;
        _locks = locks;
        _invoices = invoices;
        _stores = stores;
        _settings = settings;
        _handlers = handlers;
        _payments = payments;
        _events = events;
        _logger = logger;
    }

    public async Task Do(CancellationToken cancellationToken)
    {
        // The same host database coordinates workers; each connection's existing memo still
        // owns its wallet walk, shared with the ordinary listener and notification path.
        await using var lease = await _locks.LockAsync("invoice-historical-recovery", cancellationToken);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var ready = new List<(OpenReceiveInvoice Row, InvoiceEntity Invoice, PaymentMethodId Method, NwcConnectionState State)>();
        foreach (var row in await _minted.RecoveryDueAsync(now, 200, cancellationToken))
        {
            try
            {
                row.NextRecoveryAt = now + 12;
                var matches = new List<(InvoiceEntity Invoice, PaymentMethodId Method)>();
                foreach (var method in new[] { PaymentTypes.LN.GetPaymentMethodId("BTC"), PaymentTypes.LNURL.GetPaymentMethodId("BTC") })
                {
                    var invoice = await _invoices.GetInvoiceFromAddress(method, row.PaymentHash);
                    if (invoice is not null) matches.Add((invoice, method));
                }
                if (matches.Count != 1)
                {
                    row.RecoveryReason = matches.Count == 0 ? "host_mapping_missing" : "host_mapping_ambiguous";
                    row.NextRecoveryAt = now + 60;
                    await _minted.UpdateAsync(row, cancellationToken);
                    continue;
                }
                var match = matches[0];
                if ((row.HostInvoiceId is not null && row.HostInvoiceId != match.Invoice.Id)
                    || (row.StoreId is not null && row.StoreId != match.Invoice.StoreId)
                    || (row.PaymentMethodId is not null && row.PaymentMethodId != match.Method.ToString()))
                {
                    row.RecoveryReason = "historical_mapping_conflict";
                    row.NextRecoveryAt = now + 60;
                    await _minted.UpdateAsync(row, cancellationToken);
                    continue;
                }
                row.HostInvoiceId = match.Invoice.Id;
                row.StoreId = match.Invoice.StoreId;
                row.PaymentMethodId = match.Method.ToString();
                var recorded = match.Invoice.GetPayments(false).SingleOrDefault(p => p.Id == row.PaymentHash && p.PaymentMethodId == match.Method);
                if (recorded?.Status == PaymentStatus.Settled && recorded.Value == row.AmountMsats / 100_000_000_000m)
                {
                    // The exact host acknowledgment suffices to replay accounting even if
                    // the original account was removed. Never ask a different wallet about it.
                    row.HostUpdateRequired = true;
                    row.NextRecoveryAt = now + 3600;
                    row.RecoveryReason = "host_payment_acknowledged_update_pending";
                    await _minted.UpdateAsync(row, cancellationToken);
                    _events.Publish(new InvoiceNeedUpdateEvent(match.Invoice.Id));
                    continue;
                }
                var store = await _stores.FindStore(match.Invoice.StoreId);
                var state = store is null ? null : _settings.GetConnectionState(store);
                // Current settings alone cannot establish which account minted a legacy row.
                if (row.ConnectionId is null || state is null || state.ConnectionId != row.ConnectionId)
                {
                    row.RecoveryReason = row.ConnectionId is null ? "connection_identity_missing" : "original_wallet_unconfigured";
                    row.NextRecoveryAt = now + 60;
                    await _minted.UpdateAsync(row, cancellationToken);
                    continue;
                }
                row.RecoveryReason = null;
                await _minted.UpdateAsync(row, cancellationToken);
                await state.RestoreAsync(row.PaymentHash, cancellationToken);
                state.Memo.Watch(row.PaymentHash);
                ready.Add((row, match.Invoice, match.Method, state));
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _logger.LogWarning("nwc.recovery.failed payment_hash={Hash} type={ErrorType}", row.PaymentHash, e.GetType().Name);
            }
        }
        foreach (var group in ready.GroupBy(r => r.State))
        {
            try { await group.Key.Memo.RefreshAsync(false, cancellationToken); }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _logger.LogWarning("nwc.recovery.scan_failed type={ErrorType}", e.GetType().Name);
                continue;
            }
            foreach (var item in group)
            {
                try
                {
                    var transaction = item.State.Memo.Lookup(item.Row.PaymentHash);
                    if (transaction is not null && Settlement.IsSettled(transaction))
                        await DeliverAsync(item.Row, item.Invoice, item.Method, transaction, cancellationToken);
                    else if (transaction is not null && (Settlement.IsExpired(transaction) || Settlement.IsFailed(transaction)))
                    {
                        item.Row.RecoveryClosedAt = now;
                        item.Row.RecoveryReason = "wallet_terminal";
                        await _minted.UpdateAsync(item.Row, cancellationToken);
                    }
                    else if (item.State.Memo.Complete && !item.State.Memo.IsWatched(item.Row.PaymentHash)
                             && item.State.Memo.RefreshedAt >= item.Row.ExpiresAt + ScanMemo.ExpiryGraceSeconds)
                    {
                        // Memo retirement here follows a successful covering scan; expiry
                        // alone (or an incomplete/failed scan) never closes the durable row.
                        item.Row.RecoveryClosedAt = now;
                        item.Row.RecoveryReason = "wallet_scan_unpaid_after_grace";
                        await _minted.UpdateAsync(item.Row, cancellationToken);
                    }
                    // A local deadline is never enough to discard an undiscovered payment.
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    _logger.LogWarning("nwc.recovery.delivery_failed payment_hash={Hash} type={ErrorType}", item.Row.PaymentHash, e.GetType().Name);
                }
            }
        }
    }

    private async Task DeliverAsync(OpenReceiveInvoice row, InvoiceEntity invoice, PaymentMethodId method,
        NwcTransaction transaction, CancellationToken cancellationToken)
    {
        if (transaction.AmountMsats is not { } amount) return;
        // Commit the update checkpoint BEFORE touching the host ledger. A crash at any later
        // boundary will find it, re-read the host payment, and request recalculation again.
        row.HostUpdateRequired = true;
        await _minted.UpdateAsync(row, cancellationToken);
        var btc = amount / 100_000_000_000m;
        var existing = invoice.GetPayments(false).SingleOrDefault(p => p.Id == row.PaymentHash && p.PaymentMethodId == method);
        if (existing is null)
        {
            var payment = new PaymentData
            {
                Id = row.PaymentHash,
                Created = DateTimeOffset.FromUnixTimeSeconds(transaction.SettledAt ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()),
                Status = PaymentStatus.Settled,
                Currency = "BTC",
                InvoiceDataId = invoice.Id,
                Amount = btc,
            }.Set(invoice, _handlers[method], new LightningLikePaymentData { PaymentHash = uint256.Parse(row.PaymentHash) });
            await _payments.AddPayment(payment, new HashSet<string> { row.Bolt11 });
        }
        // AddPayment returns null for a DB failure too. Only an exact settled host row is ack.
        var current = await _invoices.GetInvoice(invoice.Id);
        var acknowledged = current?.GetPayments(false).SingleOrDefault(p => p.Id == row.PaymentHash && p.PaymentMethodId == method);
        if (acknowledged is null) throw new InvalidOperationException("host_payment_not_committed");
        if (acknowledged.Status != PaymentStatus.Settled || acknowledged.Value != btc)
        {
            row.RecoveryReason = "host_payment_conflict";
            await _minted.UpdateAsync(row, cancellationToken);
            throw new InvalidOperationException("host_payment_conflict");
        }
        // Do not replay ReceivedPayment: it causes another partial-payment remint. Reissuing
        // this idempotent event also recovers host commit followed by process death.
        _events.Publish(new InvoiceNeedUpdateEvent(invoice.Id));
        // Event enqueue is not durable acknowledgment. Retain the checkpoint and revisit it
        // hourly (bounded/fair), including invoices excluded from BTCPay's startup sweep.
        row.NextRecoveryAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600;
        row.RecoveryReason = "host_payment_acknowledged_update_pending";
        await _minted.UpdateAsync(row, cancellationToken);
    }
}
