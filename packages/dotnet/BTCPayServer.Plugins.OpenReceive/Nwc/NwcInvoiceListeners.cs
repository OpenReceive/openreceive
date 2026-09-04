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
/// less only triggers one bounded memo refresh. Behind the pushes runs a slow periodic
/// memo pass (<see cref="DefaultSweepInterval"/>): the safety net for a push the relay
/// dropped or a socket that died quietly, the AGENTS.md rule for every engine. Every
/// settlement, pushed or swept, reaches BTCPay through the memo's newly-settled queue,
/// so one invoice is emitted once however many paths saw it.
/// </summary>
public sealed class NwcNotificationListener : ILightningInvoiceListener
{
    public static readonly TimeSpan DefaultSweepInterval = TimeSpan.FromSeconds(60);

    private readonly ReceiveOnlyNwcClient _client;
    private readonly IReceiveNwcTransport _transport;
    private readonly ScanMemo _memo;
    private readonly ILogger _logger;
    private readonly TimeSpan _sweepInterval;
    private readonly CancellationTokenSource _cts = new();
    private readonly Channel<LightningInvoice> _paid = Channel.CreateUnbounded<LightningInvoice>();
    private readonly FailureLog _sweepFailures;
    private readonly Task _pump;

    public NwcNotificationListener(ReceiveOnlyNwcClient client, IReceiveNwcTransport transport, ScanMemo memo, ILogger logger, TimeSpan? sweepInterval = null)
    {
        _client = client;
        _transport = transport;
        _memo = memo;
        _logger = logger;
        _sweepInterval = sweepInterval ?? DefaultSweepInterval;
        _sweepFailures = new FailureLog(logger, "nwc.sweep");
        _pump = Task.Run(PumpAsync);
    }

    private async Task PumpAsync()
    {
        var pushes = PushesAsync();
        var sweeps = SweepsAsync();
        var first = await Task.WhenAny(pushes, sweeps).ConfigureAwait(false);
        try
        {
            await first.ConfigureAwait(false);
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
        finally
        {
            _cts.Cancel(); // either loop ending ends the session; BTCPay opens a new listener
        }
    }

    private async Task PushesAsync()
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
                    await _client.RefreshHashAsync(transaction.PaymentHash, _cts.Token).ConfigureAwait(false); // records the wallet's row
                }
                else
                {
                    _memo.Record(transaction);
                }
                if (_memo.Lookup(transaction.PaymentHash) is { AmountMsats: not null } row && Settlement.IsSettled(row))
                {
                    await EmitAsync().ConfigureAwait(false);
                    continue;
                }
            }
            // No finality signal (or no amount even after a lookup): one bounded
            // refresh of the memo, and whatever it now shows as settled is emitted.
            await _memo.RefreshAsync(force: true, _cts.Token).ConfigureAwait(false);
            await EmitAsync().ConfigureAwait(false);
        }
    }

    private async Task SweepsAsync()
    {
        while (true)
        {
            await Task.Delay(_sweepInterval, _cts.Token).ConfigureAwait(false);
            try
            {
                await _memo.RefreshAsync(force: false, _cts.Token).ConfigureAwait(false);
                await EmitAsync().ConfigureAwait(false);
                _sweepFailures.Recovered();
            }
            catch (OperationCanceledException) when (_cts.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                _sweepFailures.Failed(e); // a relay hiccup is not fatal to the session: the next sweep retries
            }
        }
    }

    private async Task EmitAsync()
    {
        foreach (var settled in _memo.DrainNewlySettled())
        {
            _logger.LogInformation("nwc.notification.settled payment_hash={Hash}", settled.PaymentHash);
            await _paid.Writer.WriteAsync(ReceiveOnlyNwcClient.ToLightningInvoice(settled), _cts.Token).ConfigureAwait(false);
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
    private readonly FailureLog _failures;
    private readonly CancellationTokenSource _cts = new();
    private readonly Channel<LightningInvoice> _paid = Channel.CreateUnbounded<LightningInvoice>();
    private readonly Task _pump;

    public NwcPollListener(ScanMemo memo, ILogger logger)
    {
        _memo = memo;
        _logger = logger;
        _failures = new FailureLog(logger, "nwc.scan");
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
                    _failures.Recovered();
                }
                catch (OperationCanceledException) when (_cts.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception e)
                {
                    _failures.Failed(e); // a relay hiccup is not fatal to the session: the next tick retries
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
    }

    private int _disposed;
}

/// <summary>
/// One warning when a periodic scan starts failing, debug lines while it keeps failing,
/// one line when it recovers — BTCPay's own LightningListener logs a dead connection the
/// same way rather than every few seconds forever.
/// </summary>
internal sealed class FailureLog
{
    private readonly ILogger _logger;
    private readonly string _prefix;
    private bool _failing;

    public FailureLog(ILogger logger, string prefix)
    {
        _logger = logger;
        _prefix = prefix;
    }

    public void Failed(Exception e)
    {
        if (!_failing)
        {
            _failing = true;
            _logger.LogWarning("{Prefix}.failed error={Error} (further failures at debug level until it recovers)", _prefix, e.Message);
        }
        else
        {
            _logger.LogDebug("{Prefix}.failed error={Error}", _prefix, e.Message);
        }
    }

    public void Recovered()
    {
        if (!_failing) return;
        _failing = false;
        _logger.LogInformation("{Prefix}.recovered", _prefix);
    }
}
