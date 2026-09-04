#nullable enable
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// The wire beneath <see cref="ReceiveOnlyNwcClient"/>: one NWC connection's relay
/// session. Production uses <see cref="NwcRelayTransport"/> over NNostr; tests inject an
/// in-memory transport so every receive rule is testable without a relay. The transport
/// owns encryption negotiation (NIP-44 v2 when the wallet advertises it, else NIP-04);
/// callers only see decrypted JSON.
/// </summary>
public interface IReceiveNwcTransport : IAsyncDisposable
{
    /// <summary>The kind-13194 info event, or null when the relay has none for this wallet.</summary>
    Task<NwcServiceInfo?> FetchServiceInfoAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Send one NIP-47 request and return its <c>result</c>. An error envelope throws
    /// <see cref="NwcRequestException"/>; a relay/transport failure throws
    /// <see cref="NwcTransportException"/>.
    /// </summary>
    Task<JsonNode?> RequestAsync(string method, JsonObject parameters, CancellationToken cancellationToken);

    /// <summary>
    /// Decrypted NWC-02 notification envelopes (<c>{ notification_type, notification }</c>)
    /// for as long as the token lives. Author-bound: only events signed by the wallet
    /// pubkey and addressed to this connection are yielded.
    /// </summary>
    IAsyncEnumerable<JsonObject> SubscribeNotificationsAsync(CancellationToken cancellationToken);
}

/// <summary>The wallet answered with an error envelope.</summary>
public sealed class NwcRequestException : Exception
{
    public string Code { get; }
    public string Method { get; }

    public NwcRequestException(string method, string code, string message)
        : base(message)
    {
        Method = method;
        Code = code;
    }
}

/// <summary>The relay or the wallet could not be reached, or did not answer in time.</summary>
public sealed class NwcTransportException : Exception
{
    public NwcTransportException(string message, Exception? inner = null) : base(message, inner) { }

    /// <summary>True when the reply arrived but could not be decrypted (scheme mismatch).</summary>
    public bool DecryptFailed { get; init; }
}
