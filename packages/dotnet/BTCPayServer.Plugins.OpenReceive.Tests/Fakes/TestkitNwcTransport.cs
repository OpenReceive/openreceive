using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using NBitcoin.Secp256k1;
using NNostr.Client;
using NNostr.Client.Protocols;
using OpenReceive.TestkitNwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Fakes;

/// <summary>
/// <see cref="IReceiveNwcTransport"/> over a <see cref="TestkitWalletService"/> with no relay
/// in between: every request is a real signed, encrypted NIP-47 event handed straight to the
/// service, and every reply (and notification) is decrypted with the connection secret, so
/// the crypto path the production relay transport exercises runs end to end in-process.
/// </summary>
public sealed class TestkitNwcTransport : IReceiveNwcTransport
{
    private readonly TestkitWalletService _service;
    private readonly ECPrivKey _secret;
    private readonly ECXOnlyPubKey _walletPub;
    private readonly Channel<WalletInvoice> _settled = Channel.CreateUnbounded<WalletInvoice>();
    private readonly ConcurrentDictionary<string, int> _requestCount = new(StringComparer.Ordinal);
    private int _serviceInfoFetches;

    public TestkitNwcTransport(TestkitWalletService service)
    {
        _service = service;
        _secret = NostrExtensions.ParseKey(service.ConnectionSecretHex);
        _walletPub = NostrExtensions.ParsePubKey(service.WalletPubKeyHex);
        service.OnInvoiceSettled += OnInvoiceSettled;
    }

    /// <summary>Requests sent so far, per NIP-47 method.</summary>
    public IReadOnlyDictionary<string, int> RequestCount => _requestCount;

    public int Count(string method) => _requestCount.GetValueOrDefault(method);

    public int ServiceInfoFetches => _serviceInfoFetches;

    /// <summary>When true, wallet settlements never reach the notification subscription.</summary>
    public bool DropNotifications { get; set; }

    /// <summary>
    /// Rewrites what the wallet answered before the client sees it. Called with the method
    /// name and the (detached) result object for requests, and with "notification" and the
    /// decrypted envelope for pushes. Return the node to hand over instead.
    /// </summary>
    public Func<string, JsonObject, JsonNode?>? Intercept { get; set; }

    /// <summary>The scheme the wallet advertises first (the NIP-47 baseline when it advertises none).</summary>
    public string NegotiatedEncryption =>
        _service.Options.EncryptionSchemes.FirstOrDefault() ?? EncryptionScheme.Nip04;

    public Task<NwcServiceInfo?> FetchServiceInfoAsync(CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _serviceInfoFetches);
        var info = _service.BuildInfoEvent();
        var methods = (info.Content ?? string.Empty).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var notifications = info.GetTaggedData("notifications")
            .SelectMany(value => value.Split(' ', StringSplitOptions.RemoveEmptyEntries)).ToArray();
        var encryption = info.GetTaggedData(NIP47.EncryptionTag)
            .SelectMany(value => value.Split(' ', StringSplitOptions.RemoveEmptyEntries)).ToArray();
        return Task.FromResult<NwcServiceInfo?>(new NwcServiceInfo(methods, notifications, encryption));
    }

    public async Task<JsonNode?> RequestAsync(string method, JsonObject parameters, CancellationToken cancellationToken)
    {
        _requestCount.AddOrUpdate(method, 1, static (_, count) => count + 1);
        var nip44 = NegotiatedEncryption == EncryptionScheme.Nip44V2;
        var request = new NIP47.Nip47Request { Method = method, Parameters = (JsonObject)parameters.DeepClone() };
        var evt = NIP47.CreateRequestEvent(request, _walletPub);
        if (nip44)
        {
            evt.SetTag(NIP47.EncryptionTag, NIP47.EncryptionSchemeNip44V2);
            evt.Content = NIP44.Encrypt(_secret, _walletPub, evt.Content!);
        }
        else
        {
            await evt.EncryptNip04EventAsync(_secret, null, true);
        }
        evt = await evt.ComputeIdAndSignAsync(_secret, false);

        var reply = await _service.HandleRequestEventAsync(evt, cancellationToken);
        var plaintext = await DecryptAsync(reply);
        var envelope = JsonNode.Parse(plaintext) as JsonObject
                       ?? throw new NwcTransportException($"NWC {method}: the wallet reply was not a JSON object.");
        if (envelope["error"] is JsonObject error)
        {
            throw new NwcRequestException(method,
                error["code"]?.GetValue<string>() ?? "OTHER",
                error["message"]?.GetValue<string>() ?? string.Empty);
        }
        var result = envelope["result"]?.DeepClone();
        if (Intercept is not null && result is JsonObject record)
        {
            result = Intercept(method, record);
        }
        return result;
    }

    public async IAsyncEnumerable<JsonObject> SubscribeNotificationsAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        while (await _settled.Reader.WaitToReadAsync(cancellationToken))
        {
            while (_settled.Reader.TryRead(out var invoice))
            {
                var evt = await _service.BuildNotificationEventAsync(invoice, _service.LastUsedScheme);
                // Author-bound like the relay transport: only the wallet's own signed pushes count.
                if (evt.PublicKey != _service.WalletPubKeyHex || !evt.Verify()) continue;
                var plaintext = await DecryptAsync(evt);
                var envelope = JsonNode.Parse(plaintext) as JsonObject ?? new JsonObject();
                if (Intercept is not null)
                {
                    envelope = Intercept("notification", envelope) as JsonObject ?? envelope;
                }
                yield return envelope;
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        _service.OnInvoiceSettled -= OnInvoiceSettled;
        _settled.Writer.TryComplete();
        return ValueTask.CompletedTask;
    }

    private void OnInvoiceSettled(WalletInvoice invoice)
    {
        if (DropNotifications) return;
        _settled.Writer.TryWrite(invoice);
    }

    private async Task<string> DecryptAsync(NostrEvent evt)
    {
        var nip44 = evt.GetTaggedData(NIP47.EncryptionTag).Contains(NIP47.EncryptionSchemeNip44V2)
                    || evt.Kind == NIP47.Nip44NotificationEventKind;
        return nip44
            ? NIP44.Decrypt(_secret, _walletPub, evt.Content!)
            : await evt.DecryptNip04EventAsync(_secret, null, true);
    }
}
