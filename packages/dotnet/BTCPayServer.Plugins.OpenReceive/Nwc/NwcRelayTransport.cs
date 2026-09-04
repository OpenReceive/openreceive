#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using NNostr.Client;
using NNostr.Client.Protocols;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// One NWC connection's relay session over NNostr: the pool lease, the negotiated
/// encryption scheme (NIP-44 v2 when the wallet's info event advertises it, NIP-04
/// otherwise — re-negotiated once on a decrypt failure), bounded per-call timeouts,
/// and the author-bound notification subscription. Everything above this class sees
/// decrypted JSON only. Shared by every client instance BTCPay creates for the same
/// connection string, so the negotiation happens once per process, not per call.
/// </summary>
public sealed class NwcRelayTransport : IReceiveNwcTransport
{
    public static readonly TimeSpan DefaultRequestTimeout = TimeSpan.FromSeconds(10);

    private readonly NostrClientPool _pool;
    private readonly NwcUri _uri;
    private readonly ILogger _logger;
    private readonly TimeSpan _requestTimeout;
    private readonly SemaphoreSlim _schemeGate = new(1, 1);
    private NIP47.EncryptionScheme? _scheme;
    private NwcServiceInfo? _serviceInfo;

    public NwcRelayTransport(NostrClientPool pool, NwcUri uri, ILogger logger, TimeSpan? requestTimeout = null)
    {
        _pool = pool;
        _uri = uri;
        _logger = logger;
        _requestTimeout = requestTimeout ?? DefaultRequestTimeout;
    }

    public NwcUri Uri => _uri;

    /// <summary>The scheme in use, once negotiated ("nip44_v2" or "nip04").</summary>
    public string? NegotiatedEncryption => _scheme switch
    {
        NIP47.EncryptionScheme.Nip44V2 => "nip44_v2",
        NIP47.EncryptionScheme.Nip04 => "nip04",
        _ => null,
    };

    private Uri[] Relays => _uri.Relays.ToArray();

    public async Task<NwcServiceInfo?> FetchServiceInfoAsync(CancellationToken cancellationToken)
    {
        using var cts = Bounded(cancellationToken);
        try
        {
            var (client, usage) = await _pool.GetClientAndConnect(Relays, cts.Token).ConfigureAwait(false);
            using (usage)
            {
                var filter = new NostrSubscriptionFilter
                {
                    Authors = new[] { _uri.WalletPubkey },
                    Kinds = new[] { NIP47.InfoEvent },
                    Limit = 1,
                };
                var infoEvent = (await FetchUntilEoseAsync(client, filter, cts.Token).ConfigureAwait(false))
                    .OrderByDescending(e => e.CreatedAt)
                    .FirstOrDefault();
                if (infoEvent is null) return null;
                var commands = (infoEvent.Content ?? string.Empty).Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var notifications = infoEvent.GetTaggedData("notifications").SelectMany(t => t.Split(' ', StringSplitOptions.RemoveEmptyEntries)).Distinct().ToArray();
                var encryption = infoEvent.GetTaggedData(NIP47.EncryptionTag).SelectMany(t => t.Split(' ', StringSplitOptions.RemoveEmptyEntries)).Distinct().ToArray();
                _serviceInfo = new NwcServiceInfo(commands, notifications, encryption);
                return _serviceInfo;
            }
        }
        catch (Exception e) when (e is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            throw Transport("fetching the wallet info event", e, cancellationToken);
        }
    }

    public async Task<JsonNode?> RequestAsync(string method, JsonObject parameters, CancellationToken cancellationToken)
    {
        var scheme = await NegotiateSchemeAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await SendAsync(method, parameters, scheme, cancellationToken).ConfigureAwait(false);
        }
        catch (NwcTransportException e) when (e.DecryptFailed)
        {
            // The wallet may have changed its advertised scheme since we cached ours:
            // re-read the info event once (the cached one would only pick the same scheme
            // again) and retry with whatever it says now.
            _logger.LogWarning("nwc.encryption.renegotiate wallet={Wallet} reason={Reason}", _uri.WalletPubkey, e.Message);
            _scheme = null;
            _serviceInfo = null;
            var renegotiated = await NegotiateSchemeAsync(cancellationToken).ConfigureAwait(false);
            return await SendAsync(method, parameters, renegotiated, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<JsonNode?> SendAsync(string method, JsonObject parameters, NIP47.EncryptionScheme scheme, CancellationToken cancellationToken)
    {
        using var cts = Bounded(cancellationToken);
        try
        {
            var (client, usage) = await _pool.GetClientAndConnect(Relays, cts.Token).ConfigureAwait(false);
            using (usage)
            {
                var request = new NIP47.Nip47Request { Method = method, Parameters = (JsonObject)parameters.DeepClone() };
                var response = await SendRequestAsync(client, request, scheme, cts.Token).ConfigureAwait(false);
                if (response is null)
                {
                    throw new NwcTransportException($"NWC {method}: the relay returned no reply.");
                }
                if (response.Error is not null)
                {
                    throw new NwcRequestException(method, response.Error.Code ?? "OTHER", response.Error.Message ?? string.Empty);
                }
                return response.Result;
            }
        }
        catch (NwcRequestException)
        {
            throw;
        }
        catch (NwcTransportException)
        {
            throw;
        }
        catch (Exception e) when (e is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            var decryptFailed = e is JsonException || e is ArgumentNullException || e is NullReferenceException ||
                                e.Message.Contains("decrypt", StringComparison.OrdinalIgnoreCase) ||
                                e.Message.Contains("padding", StringComparison.OrdinalIgnoreCase) ||
                                e.Message.Contains("mac", StringComparison.OrdinalIgnoreCase);
            throw Transport($"NWC {method}", e, cancellationToken, decryptFailed);
        }
    }

    private async Task<NIP47.EncryptionScheme> NegotiateSchemeAsync(CancellationToken cancellationToken)
    {
        if (_scheme is { } cached) return cached;
        await _schemeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_scheme is { } again) return again;
            var info = _serviceInfo ?? await FetchServiceInfoAsync(cancellationToken).ConfigureAwait(false);
            var mode = NwcInfo.ChooseEncryptionMode(info?.EncryptionSchemes ?? Array.Empty<string>());
            var scheme = mode switch
            {
                "nip44_v2" => NIP47.EncryptionScheme.Nip44V2,
                "nip04" => NIP47.EncryptionScheme.Nip04,
                _ => throw new NwcTransportException(
                    $"The wallet advertises encryption modes ({string.Join(" ", info?.EncryptionSchemes ?? Array.Empty<string>())}) and none of them is nip44_v2 or nip04."),
            };
            _scheme = scheme;
            _logger.LogInformation("nwc.encryption.negotiated wallet={Wallet} scheme={Scheme} advertised={Advertised}",
                _uri.WalletPubkey, mode, info is null ? "(no info event)" : string.Join(" ", info.EncryptionSchemes));
            return scheme;
        }
        finally
        {
            _schemeGate.Release();
        }
    }

    public async IAsyncEnumerable<JsonObject> SubscribeNotificationsAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var scheme = await NegotiateSchemeAsync(cancellationToken).ConfigureAwait(false);
        // The lease is held for the whole subscription: returning it to the pool while
        // subscribed would let the pool's idle sweep close the socket under us.
        var (client, usage) = await _pool.GetClientAndConnect(Relays, cancellationToken).ConfigureAwait(false);
        using (usage)
        {
            var kind = scheme == NIP47.EncryptionScheme.Nip44V2 ? NIP47.Nip44NotificationEventKind : NIP47.NotificationEventKind;
            // Author-bound at the filter: only events signed by the wallet pubkey and addressed to this connection.
            var filter = new NostrSubscriptionFilter
            {
                Authors = new[] { _uri.WalletPubkey },
                ReferencedPublicKeys = new[] { _uri.SecretKey.CreateXOnlyPubKey().ToHex() },
                Kinds = new[] { kind },
            };
            var events = Channel.CreateUnbounded<NostrEvent>(new UnboundedChannelOptions { SingleReader = true });
            var subscriptionId = Guid.NewGuid().ToString("N");
            void OnEvents(object? sender, (string subscriptionId, NostrEvent[] events) args)
            {
                if (args.subscriptionId != subscriptionId) return;
                foreach (var evt in args.events) events.Writer.TryWrite(evt);
            }
            client.EventsReceived += OnEvents;
            try
            {
                await client.CreateSubscription(subscriptionId, new[] { filter }, cancellationToken).ConfigureAwait(false);
                await foreach (var evt in events.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
                {
                    if (evt.Kind != kind || evt.PublicKey != _uri.WalletPubkey) continue;
                    string decrypted;
                    try
                    {
                        decrypted = await DecryptAsync(evt, scheme).ConfigureAwait(false);
                    }
                    catch (Exception e)
                    {
                        _logger.LogWarning("nwc.notification.decrypt_failed wallet={Wallet} error={Error}", _uri.WalletPubkey, e.Message);
                        continue;
                    }
                    if (JsonNode.Parse(decrypted) is not JsonObject envelope) continue;
                    yield return envelope;
                }
            }
            finally
            {
                client.EventsReceived -= OnEvents;
                try { await client.CloseSubscription(subscriptionId, CancellationToken.None).ConfigureAwait(false); } catch { /* socket may be gone */ }
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        _schemeGate.Dispose();
        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// One request → one reply, with the reply subscription CLOSED afterwards. NNostr's
    /// SendNIP47Request never closes its per-request subscription, and relays cap
    /// concurrent subscriptions per socket (nostr-rs-relay: 20), so a long-lived pooled
    /// socket stops answering after twenty calls. This is the same wire exchange with the
    /// cleanup the relay needs.
    /// </summary>
    private async Task<NIP47.Nip47Response?> SendRequestAsync(INostrClient client, NIP47.Nip47Request request, NIP47.EncryptionScheme scheme, CancellationToken cancellationToken)
    {
        var evt = NIP47.CreateRequestEvent(request, _uri.WalletPubKey);
        if (scheme == NIP47.EncryptionScheme.Nip44V2)
        {
            evt.SetTag(NIP47.EncryptionTag, NIP47.EncryptionSchemeNip44V2);
            evt.Content = NIP44.Encrypt(_uri.SecretKey, _uri.WalletPubKey, evt.Content!);
        }
        else
        {
            await evt.EncryptNip04EventAsync(_uri.SecretKey, null, true).ConfigureAwait(false);
        }
        evt = await evt.ComputeIdAndSignAsync(_uri.SecretKey, false).ConfigureAwait(false);
        var filter = new NostrSubscriptionFilter
        {
            Authors = new[] { _uri.WalletPubkey },
            ReferencedEventIds = new[] { evt.Id },
            ReferencedPublicKeys = new[] { evt.PublicKey },
            Kinds = new[] { NIP47.ResponseEventKind },
        };
        var reply = new TaskCompletionSource<NostrEvent>(TaskCreationOptions.RunContinuationsAsynchronously);
        var subscriptionId = Guid.NewGuid().ToString("N");
        void OnEvents(object? sender, (string subscriptionId, NostrEvent[] events) args)
        {
            if (args.subscriptionId != subscriptionId) return;
            foreach (var received in args.events)
            {
                // The relay's filter is a courtesy; the binding is checked here. NNostr only
                // emits events whose signature verifies, so an event by the wallet pubkey IS
                // the wallet's: anyone else on a public relay can tag an event with our
                // request id and our pubkey, and with NIP-04 the decryption key would even
                // follow the forger's key. The e tag (inside the signed payload) ties the
                // reply to THIS request, so a relay cannot serve an older wallet reply either.
                if (IsReplyToRequest(received, evt.Id)) reply.TrySetResult(received);
            }
        }
        client.EventsReceived += OnEvents;
        using var registration = cancellationToken.Register(() => reply.TrySetCanceled(cancellationToken));
        try
        {
            await client.CreateSubscription(subscriptionId, new[] { filter }, cancellationToken).ConfigureAwait(false);
            await client.PublishEvent(evt, cancellationToken).ConfigureAwait(false);
            var responseEvent = await reply.Task.ConfigureAwait(false);
            var decrypted = await DecryptAsync(responseEvent, scheme).ConfigureAwait(false);
            return JsonSerializer.Deserialize<NIP47.Nip47Response>(decrypted);
        }
        finally
        {
            client.EventsReceived -= OnEvents;
            try { await client.CloseSubscription(subscriptionId, CancellationToken.None).ConfigureAwait(false); } catch { /* socket may be gone */ }
        }
    }

    /// <summary>A NIP-47 response signed by the wallet and addressed to the given request event.</summary>
    internal bool IsReplyToRequest(NostrEvent received, string requestId) =>
        received.Kind == NIP47.ResponseEventKind &&
        string.Equals(received.PublicKey, _uri.WalletPubkey, StringComparison.OrdinalIgnoreCase) &&
        received.GetTaggedData("e").Contains(requestId, StringComparer.OrdinalIgnoreCase);

    private async Task<string> DecryptAsync(NostrEvent evt, NIP47.EncryptionScheme scheme)
    {
        return scheme == NIP47.EncryptionScheme.Nip44V2
            ? NIP44.Decrypt(_uri.SecretKey, _uri.WalletPubKey, evt.Content!)
            : await evt.DecryptNip04EventAsync(_uri.SecretKey, null, true).ConfigureAwait(false);
    }

    /// <summary>A stored-event fetch that closes its subscription at EOSE (NNostr's FetchEvents leaks it).</summary>
    private static async Task<List<NostrEvent>> FetchUntilEoseAsync(INostrClient client, NostrSubscriptionFilter filter, CancellationToken cancellationToken)
    {
        var results = new List<NostrEvent>();
        var eose = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var subscriptionId = Guid.NewGuid().ToString("N");
        void OnEvents(object? sender, (string subscriptionId, NostrEvent[] events) args)
        {
            if (args.subscriptionId != subscriptionId) return;
            lock (results) results.AddRange(args.events);
        }
        void OnEose(object? sender, string id)
        {
            if (id == subscriptionId) eose.TrySetResult(true);
        }
        client.EventsReceived += OnEvents;
        client.EoseReceived += OnEose;
        using var registration = cancellationToken.Register(() => eose.TrySetCanceled(cancellationToken));
        try
        {
            await client.CreateSubscription(subscriptionId, new[] { filter }, cancellationToken).ConfigureAwait(false);
            await eose.Task.ConfigureAwait(false);
            lock (results) return results.ToList();
        }
        finally
        {
            client.EventsReceived -= OnEvents;
            client.EoseReceived -= OnEose;
            try { await client.CloseSubscription(subscriptionId, CancellationToken.None).ConfigureAwait(false); } catch { /* socket may be gone */ }
        }
    }

    private CancellationTokenSource Bounded(CancellationToken cancellationToken)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(_requestTimeout);
        return cts;
    }

    private NwcTransportException Transport(string what, Exception e, CancellationToken outer, bool decryptFailed = false)
    {
        if (e is OperationCanceledException && !outer.IsCancellationRequested)
        {
            return new NwcTransportException($"{what} timed out after {_requestTimeout.TotalSeconds:0}s on {string.Join(", ", _uri.Relays)}.", e);
        }
        return new NwcTransportException($"{what} failed: {e.Message}", e) { DecryptFailed = decryptFailed };
    }
}
