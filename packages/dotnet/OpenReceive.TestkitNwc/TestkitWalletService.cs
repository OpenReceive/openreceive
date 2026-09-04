using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using NBitcoin.Secp256k1;
using NNostr.Client;
using NNostr.Client.Protocols;

namespace OpenReceive.TestkitNwc;

/// <summary>
/// The NIP-47 protocol core: one wallet key, one connection secret, request dispatch, and the
/// signed events a relay runner would publish. Independent of any Nostr client so tests can drive
/// it in-process.
/// </summary>
public sealed class TestkitWalletService
{
    public const int InfoEventKind = 13194;
    public const int RequestEventKind = 23194;
    public const int ResponseEventKind = 23195;
    public const int Nip04NotificationEventKind = 23196;
    public const int Nip44NotificationEventKind = 23197;
    public const string EncryptionTag = "encryption";

    private static readonly IReadOnlySet<string> SpecMethods = new HashSet<string>
    {
        "pay_invoice", "multi_pay_invoice", "pay_keysend", "multi_pay_keysend", "make_invoice",
        "lookup_invoice", "list_transactions", "get_balance", "get_info", "sign_message",
    };

    private readonly IWalletBackend _backend;
    private readonly ECPrivKey _walletKey;
    private readonly ECPrivKey _connectionSecret;
    private readonly ECXOnlyPubKey _walletPubKey;
    private readonly ECXOnlyPubKey _connectionPubKey;
    private readonly Func<long> _clock;
    private readonly Dictionary<string, JsonObject> _metadataByHash = new();
    private readonly object _gate = new();
    private string _lastScheme;

    public TestkitWalletService(IWalletBackend backend, TestkitWalletOptions options,
        ECPrivKey? walletKey = null, ECPrivKey? connectionSecret = null, Func<long>? clock = null)
    {
        _backend = backend;
        Options = options;
        _walletKey = walletKey ?? NewKey();
        _connectionSecret = connectionSecret ?? NewKey();
        _walletPubKey = _walletKey.CreateXOnlyPubKey();
        _connectionPubKey = _connectionSecret.CreateXOnlyPubKey();
        _clock = clock ?? (static () => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        _lastScheme = options.EncryptionSchemes.FirstOrDefault() ?? EncryptionScheme.Nip04;
        WalletPubKeyHex = _walletPubKey.ToHex();
        ConnectionSecretHex = _connectionSecret.ToHex();
        ConnectionPubKeyHex = _connectionPubKey.ToHex();
        _backend.InvoiceSettled += invoice => OnInvoiceSettled?.Invoke(invoice);
    }

    public TestkitWalletOptions Options { get; }
    public string WalletPubKeyHex { get; }
    public string ConnectionSecretHex { get; }
    public string ConnectionPubKeyHex { get; }
    public string Network => _backend.Network;

    /// <summary>Optional request log sink (method + payment hash, never the secret).</summary>
    public ILogger? Logger { get; set; }

    /// <summary>The scheme the connection used on its most recent authorized request; notifications follow it.</summary>
    public string LastUsedScheme => _lastScheme;

    /// <summary>Forwarded from the backend: the invoice that just settled.</summary>
    public event Action<WalletInvoice>? OnInvoiceSettled;

    public string NwcUri(params Uri[] relays)
    {
        var query = relays.Select(r => "relay=" + Uri.EscapeDataString(r.ToString())).ToList();
        query.Add("secret=" + ConnectionSecretHex);
        if (Options.Lud16 is { } lud16)
            query.Add("lud16=" + Uri.EscapeDataString(lud16));
        return $"nostr+walletconnect://{WalletPubKeyHex}?{string.Join("&", query)}";
    }

    public static string RedactUri(string nwcUri) =>
        System.Text.RegularExpressions.Regex.Replace(nwcUri, "secret=[0-9a-fA-F]+", "secret=[REDACTED]");

    public NostrEvent BuildInfoEvent()
    {
        var evt = new NostrEvent
        {
            Kind = InfoEventKind,
            Content = string.Join(" ", Options.GrantedMethods),
            CreatedAt = DateTimeOffset.FromUnixTimeSeconds(_clock()),
        };
        if (Options.Notifications)
            evt.SetTag("notifications", Nip47Json.PaymentReceived);
        if (Options.EncryptionSchemes.Count > 0)
            evt.SetTag(EncryptionTag, string.Join(" ", Options.EncryptionSchemes));
        return Sign(evt);
    }

    // ---- request dispatch -------------------------------------------------------------------

    public async Task<JsonObject> HandleRequestAsync(JsonObject request, CancellationToken cancellationToken)
    {
        var method = Str(request["method"]) ?? "";
        var parameters = request["params"] as JsonObject ?? new JsonObject();
        var response = await DispatchAsync(method, parameters, cancellationToken);
        Logger?.LogInformation("NWC {Method} payment_hash={PaymentHash} -> {Outcome}", method,
            Str(parameters["payment_hash"]) ?? Str(response["result"]?["payment_hash"]) ?? "-",
            Str(response["error"]?["code"]) ?? "ok");
        return response;
    }

    private async Task<JsonObject> DispatchAsync(string method, JsonObject p, CancellationToken ct)
    {
        if (Options.ExtraGrantedMethods.Contains(method))
            return Nip47Json.Error(method, Nip47Json.ErrorCodes.NotImplemented,
                $"{method} is advertised by the testkit but never executed");
        if (!Options.Methods.Contains(method) || method == "notifications")
            return Nip47Json.Error(method,
                SpecMethods.Contains(method) ? Nip47Json.ErrorCodes.Restricted : Nip47Json.ErrorCodes.NotImplemented,
                SpecMethods.Contains(method) ? $"{method} is not granted to this connection" : $"{method} is not implemented");
        try
        {
            return method switch
            {
                "get_info" => Nip47Json.Result(method, GetInfo()),
                "make_invoice" => await MakeInvoiceAsync(p, ct),
                "lookup_invoice" => await LookupInvoiceAsync(p, ct),
                "list_transactions" => await ListTransactionsAsync(p, ct),
                "get_balance" => Nip47Json.Result(method, new JsonObject { ["balance"] = await _backend.BalanceMsatsAsync(ct) }),
                _ => Nip47Json.Error(method, Nip47Json.ErrorCodes.NotImplemented, $"{method} is not implemented"),
            };
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception e)
        {
            return Nip47Json.Error(method, Nip47Json.ErrorCodes.Internal, e.Message);
        }
    }

    private JsonObject GetInfo()
    {
        var info = new JsonObject
        {
            ["alias"] = "OpenReceive testkit",
            ["color"] = "#f7931a",
            ["pubkey"] = WalletPubKeyHex,
            ["network"] = _backend.Network,
            ["block_height"] = 0,
            ["block_hash"] = new string('0', 64),
            ["methods"] = new JsonArray(Options.GrantedMethods.Select(m => (JsonNode)m).ToArray()),
        };
        if (Options.Notifications)
            info["notifications"] = new JsonArray(Nip47Json.PaymentReceived);
        return info;
    }

    private async Task<JsonObject> MakeInvoiceAsync(JsonObject p, CancellationToken ct)
    {
        if (Int64(p["amount"]) is not { } amountMsats)
            return Nip47Json.Error("make_invoice", Nip47Json.ErrorCodes.Other, "amount (msats) is required");
        var expiry = (int)(Int64(p["expiry"]) ?? 3600) + (Options.ExpirySecondsDelta ?? 0);
        var invoice = await _backend.MakeInvoiceAsync(amountMsats, Str(p["description"]), Str(p["description_hash"]), expiry, ct);
        var metadata = p["metadata"] as JsonObject;
        if (metadata is not null)
            lock (_gate) _metadataByHash[invoice.PaymentHash] = metadata.DeepClone().AsObject();
        return Nip47Json.Result("make_invoice", Transaction(invoice));
    }

    private async Task<JsonObject> LookupInvoiceAsync(JsonObject p, CancellationToken ct)
    {
        var invoice = await _backend.LookupAsync(Str(p["payment_hash"]), Str(p["invoice"]), ct);
        return invoice is null
            ? Nip47Json.Error("lookup_invoice", Nip47Json.ErrorCodes.NotFound, "invoice not found")
            : Nip47Json.Result("lookup_invoice", Transaction(invoice));
    }

    private async Task<JsonObject> ListTransactionsAsync(JsonObject p, CancellationToken ct)
    {
        var limit = Math.Clamp((int)(Int64(p["limit"]) ?? Options.PageLimitCap), 0, Options.PageLimitCap);
        var offset = Options.DropOffset ? 0 : (int)(Int64(p["offset"]) ?? 0);
        var type = Str(p["type"]);
        IEnumerable<WalletInvoice> rows = type == "outgoing"
            ? []
            : await _backend.ListIncomingAsync(Int64(p["from"]), Int64(p["until"]), Bool(p["unpaid"]) ?? false, ct);
        var page = rows.Skip(offset).Take(limit).Select(i => (JsonNode)Transaction(i)).ToArray();
        return Nip47Json.Result("list_transactions", new JsonObject { ["transactions"] = new JsonArray(page) });
    }

    private JsonObject Transaction(WalletInvoice invoice)
    {
        JsonObject? metadata;
        lock (_gate) _metadataByHash.TryGetValue(invoice.PaymentHash, out metadata);
        return Nip47Json.Transaction(invoice, metadata);
    }

    // ---- events -------------------------------------------------------------------------------

    /// <summary>Decrypt a kind-23194 request, dispatch it, and return the signed kind-23195 reply in the same scheme.</summary>
    public async Task<NostrEvent> HandleRequestEventAsync(NostrEvent requestEvent, CancellationToken cancellationToken)
    {
        var sender = requestEvent.GetPublicKey();
        var scheme = requestEvent.GetTaggedData(EncryptionTag).FirstOrDefault() ?? EncryptionScheme.Nip04;
        var authorized = requestEvent.PublicKey == ConnectionPubKeyHex;
        JsonObject response;
        if (!EncryptionScheme.IsKnown(scheme))
        {
            scheme = EncryptionScheme.Nip04;
            response = Nip47Json.Error("", Nip47Json.ErrorCodes.UnsupportedEncryption, $"unsupported encryption scheme");
        }
        else
        {
            var plaintext = scheme == EncryptionScheme.Nip44V2
                ? NIP44.Decrypt(_walletKey, sender, requestEvent.Content!)
                : await requestEvent.DecryptNip04EventAsync(_walletKey, null, true);
            var request = JsonNode.Parse(plaintext) as JsonObject ?? new JsonObject();
            if (authorized)
            {
                _lastScheme = scheme;
                response = await HandleRequestAsync(request, cancellationToken);
            }
            else
            {
                response = Nip47Json.Error(Str(request["method"]) ?? "",
                    Nip47Json.ErrorCodes.Unauthorized, "this public key has no wallet connected");
            }
        }

        var reply = new NostrEvent { Kind = ResponseEventKind, CreatedAt = DateTimeOffset.FromUnixTimeSeconds(_clock()) };
        reply.SetReferencedPublickKey(requestEvent.PublicKey);
        reply.SetReferencedEvent(requestEvent.Id);
        return await EncryptAndSignAsync(reply, sender, response.ToJsonString(), scheme);
    }

    /// <summary>A NWC-02 payment_received push for the connection: kind 23197 (nip44_v2) or 23196 (nip04).</summary>
    public Task<NostrEvent> BuildNotificationEventAsync(WalletInvoice invoice, string scheme)
    {
        var nip44 = scheme == EncryptionScheme.Nip44V2;
        var evt = new NostrEvent
        {
            Kind = nip44 ? Nip44NotificationEventKind : Nip04NotificationEventKind,
            CreatedAt = DateTimeOffset.FromUnixTimeSeconds(_clock()),
        };
        evt.SetReferencedPublickKey(ConnectionPubKeyHex);
        JsonObject? metadata;
        lock (_gate) _metadataByHash.TryGetValue(invoice.PaymentHash, out metadata);
        var content = Nip47Json.Notification(invoice, metadata).ToJsonString();
        return EncryptAndSignAsync(evt, _connectionPubKey, content, nip44 ? EncryptionScheme.Nip44V2 : EncryptionScheme.Nip04);
    }

    private async Task<NostrEvent> EncryptAndSignAsync(NostrEvent evt, ECXOnlyPubKey recipient, string plaintext, string scheme)
    {
        evt.PublicKey = WalletPubKeyHex;
        if (scheme == EncryptionScheme.Nip44V2)
        {
            evt.SetTag(EncryptionTag, EncryptionScheme.Nip44V2);
            evt.Content = NIP44.Encrypt(_walletKey, recipient, plaintext);
        }
        else
        {
            evt.Content = plaintext;
            await evt.EncryptNip04EventAsync(_walletKey, null, true);
        }
        return Sign(evt);
    }

    private NostrEvent Sign(NostrEvent evt)
    {
        evt.PublicKey = WalletPubKeyHex;
        evt.Id = evt.ComputeId();
        evt.Signature = evt.ComputeSignature(_walletKey);
        return evt;
    }

    // Params may be parsed JSON or JsonObjects built in-process (int vs long, etc.): deserialize, do not cast.
    private static long? Int64(JsonNode? node) => node is null ? null : node.Deserialize<long>();
    private static bool? Bool(JsonNode? node) => node is null ? null : node.Deserialize<bool>();
    private static string? Str(JsonNode? node) => node is null ? null : node.Deserialize<string>();

    private static ECPrivKey NewKey() => ECPrivKey.Create(RandomNumberGenerator.GetBytes(32));
}
