#nullable enable
using System;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using BTCPayServer.Lightning;
using Microsoft.Extensions.Logging;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// NWC-02 push path. A <c>payment_received</c> payload that carries a finality signal
/// AND an amount settles directly (notifications are authenticated wallet data); a
/// finality signal without an amount refreshes that one hash first, because BTCPay
/// records only <c>AmountReceived ?? Amount</c> and retries a sparse Paid; anything
/// less only triggers one bounded memo refresh.
/// </summary>
public sealed class NwcNotificationListener : ILightningInvoiceListener
{
    private readonly ReceiveOnlyNwcClient _client;
    private readonly IReceiveNwcTransport _transport;
    private readonly ScanMemo _memo;
    private readonly ILogger _logger;
    private readonly CancellationTokenSource _cts = new();
    private readonly Channel<LightningInvoice> _paid = Channel.CreateUnbounded<LightningInvoice>();
    private readonly Task _pump;

    public NwcNotificationListener(ReceiveOnlyNwcClient client, IReceiveNwcTransport transport, ScanMemo memo, ILogger logger)
    {
        _client = client;
        _transport = transport;
        _memo = memo;
        _logger = logger;
        _pump = Task.Run(PumpAsync);
    }

    private async Task PumpAsync()
    {
        try
        {
            await foreach (var envelope in _transport.SubscribeNotificationsAsync(_cts.Token).ConfigureAwait(false))
            {
                NwcWalletNotification notification;
                try
                {
                    notification = NwcNormalize.Notification(envelope);
                }
                catch (Exception e)
                {
                    _logger.LogWarning("nwc.notification.unreadable error={Error}", e.Message);
                    continue;
                }
                if (!string.Equals(notification.Type, "payment_received", StringComparison.Ordinal))
                {
                    continue;
                }
                _logger.LogInformation("nwc.notification.received type={Type} payment_hash={Hash}", notification.Type, notification.PaymentHash);
                var transaction = notification.Transaction;
                if (transaction?.PaymentHash is not null && Settlement.IsSettled(transaction))
                {
                    if (transaction.AmountMsats is null)
                    {
                        transaction = await _client.RefreshHashAsync(transaction.PaymentHash, _cts.Token).ConfigureAwait(false) ?? transaction;
                    }
                    else
                    {
                        _memo.Record(transaction);
                    }
                    if (transaction.AmountMsats is not null)
                    {
                        await _paid.Writer.WriteAsync(ReceiveOnlyNwcClient.ToLightningInvoice(transaction), _cts.Token).ConfigureAwait(false);
                        continue;
                    }
                }
                // No finality signal (or no amount even after a lookup): one bounded
                // refresh of the memo, and whatever it now shows as settled is emitted.
                await _memo.RefreshAsync(force: true, _cts.Token).ConfigureAwait(false);
                foreach (var settled in _memo.DrainNewlySettled())
                {
                    await _paid.Writer.WriteAsync(ReceiveOnlyNwcClient.ToLightningInvoice(settled), _cts.Token).ConfigureAwait(false);
                }
            }
            _paid.Writer.TryComplete(new NwcTransportException("The notification subscription ended."));
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested)
        {
            _paid.Writer.TryComplete();
        }
        catch (Exception e)
        {
            _logger.LogWarning("nwc.notification.subscription_failed error={Error}", e.Message);
            _paid.Writer.TryComplete(e);
        }
    }

    public async Task<LightningInvoice> WaitInvoice(CancellationToken cancellation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellation);
        return await _paid.Reader.ReadAsync(linked.Token).ConfigureAwait(false);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _cts.Cancel();
        _cts.Dispose();
    }

    private int _disposed;
}

/// <summary>
/// Poll path for wallets without notifications: an incremental settled-transaction
/// feed that IS the scan memo refresh. Every newly settled row is yielded and BTCPay
/// filters by <c>notification.Id</c>. Never yields Unpaid or Expired — either would
/// change what BTCPay watches, and BTCPay's own invoice state machine owns expiry.
/// </summary>
public sealed class NwcPollListener : ILightningInvoiceListener
{
    private readonly ScanMemo _memo;
    private readonly ILogger _logger;
    private readonly CancellationTokenSource _cts = new();
    private readonly Channel<LightningInvoice> _paid = Channel.CreateUnbounded<LightningInvoice>();
    private readonly Task _pump;

    public NwcPollListener(ScanMemo memo, ILogger logger)
    {
        _memo = memo;
        _logger = logger;
        _pump = Task.Run(PumpAsync);
    }

    private async Task PumpAsync()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    await _memo.RefreshAsync(force: false, _cts.Token).ConfigureAwait(false);
                    foreach (var settled in _memo.DrainNewlySettled())
                    {
                        _logger.LogInformation("nwc.scan.settled payment_hash={Hash}", settled.PaymentHash);
                        await _paid.Writer.WriteAsync(ReceiveOnlyNwcClient.ToLightningInvoice(settled), _cts.Token).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (_cts.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception e)
                {
                    // A relay hiccup is not fatal to the session: the next tick retries.
                    _logger.LogWarning("nwc.scan.failed error={Error}", e.Message);
                }
                await Task.Delay(_memo.CurrentInterval, _cts.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            _paid.Writer.TryComplete();
        }
    }

    public async Task<LightningInvoice> WaitInvoice(CancellationToken cancellation)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellation);
        return await _paid.Reader.ReadAsync(linked.Token).ConfigureAwait(false);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _cts.Cancel();
        _cts.Dispose();
    }

    private int _disposed;
}
