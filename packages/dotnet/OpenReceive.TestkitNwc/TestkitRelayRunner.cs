using System.Net.WebSockets;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using NNostr.Client;

namespace OpenReceive.TestkitNwc;

/// <summary>
/// Puts a <see cref="TestkitWalletService"/> on one or more relays: publishes the info event,
/// answers requests addressed to the wallet key, pushes payment notifications, and reconnects
/// with backoff when the socket drops.
/// </summary>
public sealed class TestkitRelayRunner
{
    private static readonly TimeSpan MaxRequestAge = TimeSpan.FromMinutes(5);

    private readonly TestkitWalletService _service;
    private readonly Uri[] _relays;
    private readonly ILogger? _logger;
    private readonly Action<WebSocket>? _websocketConfigure;
    private readonly HashSet<string> _seen = [];
    private readonly Channel<object> _work = Channel.CreateUnbounded<object>();
    private volatile INostrClient? _client;
    private volatile bool _connected;

    public TestkitRelayRunner(TestkitWalletService service, Uri[] relays, ILogger? logger = null,
        Action<WebSocket>? websocketConfigure = null)
    {
        if (relays.Length == 0)
            throw new ArgumentException("At least one relay is required", nameof(relays));
        _service = service;
        _relays = relays;
        _logger = logger;
        _websocketConfigure = websocketConfigure;
    }

    public bool RelayConnected => _connected;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        _service.OnInvoiceSettled += OnInvoiceSettled;
        var worker = ProcessWorkAsync(cancellationToken);
        var backoff = TimeSpan.FromSeconds(1);
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    await ServeOneConnectionAsync(cancellationToken);
                    backoff = TimeSpan.FromSeconds(1);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
                catch (Exception e)
                {
                    _logger?.LogWarning(e, "Relay connection failed; retrying in {Backoff}", backoff);
                }
                _connected = false;
                await Task.Delay(backoff, cancellationToken).ContinueWith(_ => { }, CancellationToken.None);
                backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 30));
            }
        }
        finally
        {
            _service.OnInvoiceSettled -= OnInvoiceSettled;
            _work.Writer.TryComplete();
            await worker;
        }
    }

    private async Task ServeOneConnectionAsync(CancellationToken ct)
    {
        using var client = CreateClient();
        client.EventsReceived += OnEventsReceived;
        try
        {
            using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            connectTimeout.CancelAfter(TimeSpan.FromSeconds(20));
            await client.ConnectAndWaitUntilConnected(connectTimeout.Token, ct);
            _client = client;
            _connected = true;
            _logger?.LogInformation("Connected to {Relays}; wallet pubkey {WalletPubKey}",
                string.Join(", ", _relays.Select(r => r.ToString())), _service.WalletPubKeyHex);

            await client.PublishEvent(_service.BuildInfoEvent(), ct);
            await client.CreateSubscription("nwc-requests", [new NostrSubscriptionFilter
            {
                Kinds = [TestkitWalletService.RequestEventKind],
                ReferencedPublicKeys = [_service.WalletPubKeyHex],
                Limit = 0,
            }], ct);

            while (IsOpen(client))
                await Task.Delay(1000, ct);
            _logger?.LogWarning("Relay socket closed");
        }
        finally
        {
            _client = null;
            _connected = false;
            client.EventsReceived -= OnEventsReceived;
        }
    }

    private INostrClient CreateClient() => _relays.Length == 1
        ? new NostrClient(_relays[0], _websocketConfigure)
        : new CompositeNostrClient(_relays, _websocketConfigure);

    private static bool IsOpen(INostrClient client) => client switch
    {
        NostrClient single => single.State == WebSocketState.Open,
        CompositeNostrClient composite => composite.States.Values.Any(s => s == WebSocketState.Open),
        _ => true,
    };

    private void OnEventsReceived(object? sender, (string subscriptionId, NostrEvent[] events) e)
    {
        var cutoff = DateTimeOffset.UtcNow - MaxRequestAge;
        foreach (var evt in e.events)
        {
            if (evt.Kind != TestkitWalletService.RequestEventKind ||
                !evt.GetTaggedPublicKeys().Contains(_service.WalletPubKeyHex) ||
                evt.CreatedAt < cutoff)
                continue;
            lock (_seen)
            {
                if (!_seen.Add(evt.Id))
                    continue;
            }
            _work.Writer.TryWrite(evt);
        }
    }

    private void OnInvoiceSettled(WalletInvoice invoice) => _work.Writer.TryWrite(invoice);

    private async Task ProcessWorkAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var item in _work.Reader.ReadAllAsync(ct))
            {
                try
                {
                    var outgoing = item switch
                    {
                        NostrEvent request => await _service.HandleRequestEventAsync(request, ct),
                        WalletInvoice invoice => await _service.BuildNotificationEventAsync(invoice, _service.LastUsedScheme),
                        _ => null,
                    };
                    if (outgoing is null)
                        continue;
                    if (item is WalletInvoice settled)
                        _logger?.LogInformation("payment_received {PaymentHash} via {Scheme} (kind {Kind})",
                            settled.PaymentHash, _service.LastUsedScheme, outgoing.Kind);
                    if (_client is { } client)
                        await client.PublishEvent(outgoing, ct);
                    else
                        _logger?.LogWarning("No relay connection; dropped outgoing kind {Kind} event", outgoing.Kind);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                catch (Exception e)
                {
                    _logger?.LogError(e, "Failed to handle {Item}", item.GetType().Name);
                }
            }
        }
        catch (OperationCanceledException) { }
    }
}
