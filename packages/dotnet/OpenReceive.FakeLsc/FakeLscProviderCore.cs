using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenReceive.FakeLsc;

/// <summary>One HTTP answer from the fake, independent of any host.</summary>
public readonly record struct FakeHttpResponse(int Status, string ContentType, string Body);

/// <summary>What tests may read about a stored order. The token is exposed here only; it is never logged.</summary>
public sealed record FakeLscOrderView(string Id, string Token, string Bolt11, string Asset, string State);

/// <summary>
/// The pure in-memory FixedFloat-compatible provider: the signed <c>/api/v2</c> subset
/// the OpenReceive client calls (<c>ccies</c>, <c>price</c>, <c>create</c>, <c>order</c>,
/// <c>emergency</c>), the public <c>/rates/fixed.xml</c>, and the scripting controls
/// that drive an order through OpenReceive swap states. No sockets: hosts feed it
/// requests through <see cref="HandleAsync"/> (Kestrel in Program.cs, or
/// <see cref="FakeLscHttpMessageHandler"/> in-process).
/// </summary>
public sealed class FakeLscProviderCore
{
    private const string JsonContentType = "application/json; charset=utf-8";
    private const string XmlContentType = "application/xml; charset=utf-8";

    private static readonly IReadOnlyList<string> ScriptableStates = new[]
    {
        "awaiting_deposit", "confirming", "exchanging", "paying_invoice", "completed",
        "expired", "refund_required", "refund_pending", "refunded", "attention", "failed",
    };

    private static readonly IReadOnlyDictionary<string, string[]> EmergencyStatusesByReason =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["underpaid"] = ["LESS"],
            ["overpaid"] = ["MORE"],
            ["late_deposit"] = ["EXPIRED"],
            ["underpaid_and_late"] = ["LESS", "EXPIRED"],
            ["overpaid_and_late"] = ["MORE", "EXPIRED"],
        };

    private readonly FakeLscOptions _options;
    private readonly Lock _gate = new();
    private readonly Dictionary<string, FakeOrder> _orders = new(StringComparer.Ordinal);
    private readonly Dictionary<string, PendingScript> _pendingByAsset = new(StringComparer.Ordinal);
    private readonly List<Task> _payerTasks = [];
    private string? _nextCreateError;
    private int _rateLimitRemaining;

    public FakeLscProviderCore(FakeLscOptions? options = null)
    {
        _options = options ?? new FakeLscOptions();
        foreach (var asset in _options.SupportedAssets)
        {
            if (FakeLscAssets.ByPayInAsset(asset) is null)
                throw new ArgumentException($"Unknown pay-in asset {asset}.", nameof(options));
        }
    }

    /// <summary>The message of the most recent failed payer invocation, or null.</summary>
    public string? LastPayerError { get; private set; }

    /// <summary>Every order created so far, in creation order.</summary>
    public IReadOnlyList<FakeLscOrderView> Orders
    {
        get
        {
            lock (_gate)
            {
                return _orders.Values.Select(o => new FakeLscOrderView(o.Id, o.Token, o.Bolt11, o.Asset, o.State)).ToArray();
            }
        }
    }

    // ----- controls -------------------------------------------------------------

    /// <summary>
    /// Queue OpenReceive states for an asset (applies to the next order created for it and
    /// to every existing order of that asset) or for one order id. Each <c>/order</c> poll
    /// advances one step and then holds on the last state.
    /// </summary>
    public void Script(string assetOrOrderId, IReadOnlyList<string> openReceiveStates)
    {
        if (openReceiveStates.Count == 0)
            throw new ArgumentException("A swap script needs at least one state.", nameof(openReceiveStates));
        foreach (var state in openReceiveStates)
        {
            if (!ScriptableStates.Contains(state))
                throw new ArgumentException($"Unknown OpenReceive swap state {state}.", nameof(openReceiveStates));
        }
        lock (_gate)
        {
            foreach (var order in Match(assetOrOrderId))
            {
                order.Steps = [.. openReceiveStates];
                order.Next = 0;
                order.AttentionReason = null;
            }
            if (IsAsset(assetOrOrderId))
                _pendingByAsset[assetOrOrderId] = new PendingScript([.. openReceiveStates], null, null);
        }
    }

    /// <summary>
    /// Force <c>refund_required</c> with a refund reason (underpaid, overpaid, late_deposit,
    /// underpaid_and_late, overpaid_and_late): matching orders move now, and an asset selector
    /// also queues it for the asset's next order.
    /// </summary>
    public void ForceRefundRequired(string assetOrOrderId, string reason = "underpaid")
    {
        if (!EmergencyStatusesByReason.ContainsKey(reason))
            throw new ArgumentException($"Unknown refund reason {reason}.", nameof(reason));
        Force(assetOrOrderId, "refund_required", attentionReason: null, refundReason: reason);
    }

    /// <summary>
    /// Force <c>attention</c>: <c>provider_reported_emergency</c> renders an EMERGENCY order
    /// whose choice is EXCHANGE; <c>provider_status_unrecognized</c> renders an unknown status.
    /// </summary>
    public void ForceAttention(string assetOrOrderId, string reason = "provider_reported_emergency")
    {
        if (reason is not ("provider_reported_emergency" or "provider_status_unrecognized"))
            throw new ArgumentException($"Unknown attention reason {reason}.", nameof(reason));
        Force(assetOrOrderId, "attention", attentionReason: reason, refundReason: null);
    }

    /// <summary>Make the next <c>/create</c> answer an API error envelope with this message.</summary>
    public void ForceCreateError(string message = "Fake LSC create failed.")
    {
        lock (_gate) _nextCreateError = message;
    }

    /// <summary>Make the next <paramref name="count"/> <c>/api/v2</c> calls answer HTTP 429.</summary>
    public void RateLimitNext(int count)
    {
        lock (_gate) _rateLimitRemaining = Math.Max(0, count);
    }

    /// <summary>Await every payer invocation started so far (failures are already recorded in <see cref="LastPayerError"/>).</summary>
    public async Task WaitForPayerAsync()
    {
        Task[] pending;
        lock (_gate) pending = [.. _payerTasks];
        await Task.WhenAll(pending).ConfigureAwait(false);
    }

    // ----- HTTP -----------------------------------------------------------------

    public Task<FakeHttpResponse> HandleAsync(
        string method,
        string pathAndQuery,
        IReadOnlyDictionary<string, string> headers,
        string body,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var path = pathAndQuery.Split('?', 2)[0].TrimEnd('/');
        if (path.Length == 0) path = "/";

        if (method.Equals("GET", StringComparison.OrdinalIgnoreCase) && path == "/rates/fixed.xml")
        {
            _options.Log("GET /rates/fixed.xml");
            return Task.FromResult(new FakeHttpResponse(200, XmlContentType, RatesXml()));
        }

        if (method.Equals("POST", StringComparison.OrdinalIgnoreCase) && path.StartsWith("/api/v2/", StringComparison.Ordinal))
        {
            var apiPath = path["/api/v2/".Length..];
            return Task.FromResult(HandleApi(apiPath, headers, body));
        }

        _options.Log($"{method} {path} -> 404");
        return Task.FromResult(Envelope(404, 404, "Not found"));
    }

    private FakeHttpResponse HandleApi(string apiPath, IReadOnlyDictionary<string, string> headers, string body)
    {
        lock (_gate)
        {
            if (_rateLimitRemaining > 0)
            {
                _rateLimitRemaining--;
                _options.Log($"POST /api/v2/{apiPath} -> 429 (rate limit scripted)");
                return Envelope(429, 429, "Too many requests");
            }
        }

        if (_options.VerifySignature && !SignatureValid(headers, body))
        {
            _options.Log($"POST /api/v2/{apiPath} -> 401 invalid signature");
            return Envelope(401, 1, "Invalid signature");
        }

        JsonObject request;
        try
        {
            request = body.Trim().Length == 0 ? new JsonObject() : JsonNode.Parse(body) as JsonObject ?? new JsonObject();
        }
        catch (JsonException)
        {
            return Envelope(400, 1, "Invalid JSON body");
        }

        return apiPath switch
        {
            "ccies" => Log(apiPath, null, Ok(Ccies())),
            "price" => Price(request),
            "create" => Create(request),
            "order" => WithOrder(apiPath, request, order => Ok(Advance(order))),
            "emergency" => WithOrder(apiPath, request, order => Emergency(order, request)),
            _ => Log(apiPath, null, Envelope(404, 404, "Not found")),
        };
    }

    private FakeHttpResponse Log(string apiPath, string? orderId, FakeHttpResponse response)
    {
        _options.Log(orderId is null
            ? $"POST /api/v2/{apiPath} -> {response.Status}"
            : $"POST /api/v2/{apiPath} order={orderId} -> {response.Status}");
        return response;
    }

    private bool SignatureValid(IReadOnlyDictionary<string, string> headers, string body)
    {
        var key = Header(headers, "X-API-KEY");
        var sign = Header(headers, "X-API-SIGN");
        if (key is null || sign is null || !string.Equals(key, _options.Key, StringComparison.Ordinal)) return false;
        var expected = Sign(_options.Secret, body);
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(sign.ToLowerInvariant()),
            Encoding.ASCII.GetBytes(expected));
    }

    /// <summary>Lowercase hex HMAC-SHA256 of the raw request body — the client's <c>X-API-SIGN</c>.</summary>
    public static string Sign(string secret, string body) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body)));

    private static string? Header(IReadOnlyDictionary<string, string> headers, string name)
    {
        if (headers.TryGetValue(name, out var direct)) return direct;
        foreach (var (key, value) in headers)
        {
            if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) return value;
        }
        return null;
    }

    // ----- endpoints ------------------------------------------------------------

    private JsonArray Ccies()
    {
        var items = new JsonArray();
        foreach (var asset in FakeLscAssets.All.Where(a => _options.SupportedAssets.Contains(a.PayInAsset)))
        {
            items.Add(Currency(asset.Code, asset.Coin, asset.Network, $"{asset.Coin} ({asset.Network})"));
        }
        items.Add(Currency(FakeLscAssets.LightningCode, FakeLscAssets.LightningCoin, FakeLscAssets.LightningNetwork, "Bitcoin (Lightning)"));
        return items;

        static JsonObject Currency(string code, string coin, string network, string name) => new()
        {
            ["code"] = code,
            ["coin"] = coin,
            ["network"] = network,
            ["name"] = name,
            ["recv"] = true,
            ["send"] = true,
        };
    }

    private FakeHttpResponse Price(JsonObject request)
    {
        var trade = ResolveTrade(request);
        return Log("price", null, trade.Error is not null
            ? Envelope(200, 1, trade.Error)
            : Ok(new JsonObject
            {
                ["from"] = Side(trade.Asset!.Code, trade.Asset.Coin, trade.Asset.Network, trade.DepositAmount, trade.FromUsd),
                ["to"] = Side(FakeLscAssets.LightningCode, FakeLscAssets.LightningCoin, FakeLscAssets.LightningNetwork, trade.BtcAmount, trade.ToUsd),
            }));

        static JsonObject Side(string code, string coin, string network, decimal amount, decimal usd) => new()
        {
            ["code"] = code,
            ["coin"] = coin,
            ["network"] = network,
            ["amount"] = FakeLscAssets.FormatAmount(amount),
            ["usd"] = FakeLscAssets.FormatUsd(usd),
        };
    }

    private FakeHttpResponse Create(JsonObject request)
    {
        lock (_gate)
        {
            if (_nextCreateError is { } forced)
            {
                _nextCreateError = null;
                return Log("create", null, Envelope(200, 1, forced));
            }
        }

        var trade = ResolveTrade(request);
        if (trade.Error is not null) return Log("create", null, Envelope(200, 1, trade.Error));
        var bolt11 = request["toAddress"]?.ToString();
        if (string.IsNullOrWhiteSpace(bolt11)) return Log("create", null, Envelope(200, 1, "toAddress is required"));

        var now = _options.Clock();
        var order = new FakeOrder
        {
            Id = RandomAlnum(6),
            Token = RandomAlnum(32),
            Asset = trade.Asset!.PayInAsset,
            Currency = trade.Asset,
            Bolt11 = bolt11,
            DepositAmount = trade.DepositAmount,
            BtcAmount = trade.BtcAmount,
            FromUsd = trade.FromUsd,
            ToUsd = trade.ToUsd,
            Registered = now,
            Expiration = now + _options.DepositWindowSeconds,
        };

        lock (_gate)
        {
            if (_pendingByAsset.Remove(order.Asset, out var pending))
            {
                order.Steps = [.. pending.Steps];
                order.AttentionReason = pending.AttentionReason;
                order.RefundReason = pending.RefundReason;
            }
            _orders[order.Id] = order;
            return Log("create", order.Id, Ok(Render(order)));
        }
    }

    private FakeHttpResponse WithOrder(string apiPath, JsonObject request, Func<FakeOrder, FakeHttpResponse> handle)
    {
        var id = request["id"]?.ToString();
        var token = request["token"]?.ToString();
        lock (_gate)
        {
            if (id is null || !_orders.TryGetValue(id, out var order) || !string.Equals(order.Token, token, StringComparison.Ordinal))
                return Log(apiPath, id, Envelope(200, 1, "Order not found"));
            return Log(apiPath, id, handle(order));
        }
    }

    /// <summary>One scripted step per poll, then hold. Caller holds the gate.</summary>
    private JsonObject Advance(FakeOrder order)
    {
        if (order.Next < order.Steps.Count)
        {
            Apply(order, order.Steps[order.Next++]);
        }
        return Render(order);
    }

    private FakeHttpResponse Emergency(FakeOrder order, JsonObject request)
    {
        var choice = request["choice"]?.ToString()?.ToUpperInvariant();
        if (choice != "REFUND") return Envelope(200, 1, "Unsupported emergency choice");
        var address = request["address"]?.ToString();
        if (string.IsNullOrWhiteSpace(address)) return Envelope(200, 1, "address is required");
        order.RefundAddress = address;
        order.RefundReason ??= "underpaid";
        Apply(order, "refund_pending");
        return Ok(true);
    }

    // ----- lifecycle ------------------------------------------------------------

    private void Force(string assetOrOrderId, string state, string? attentionReason, string? refundReason)
    {
        lock (_gate)
        {
            foreach (var order in Match(assetOrOrderId))
            {
                order.Steps = [];
                order.Next = 0;
                order.AttentionReason = attentionReason;
                if (refundReason is not null) order.RefundReason = refundReason;
                Apply(order, state);
            }
            if (IsAsset(assetOrOrderId))
                _pendingByAsset[assetOrOrderId] = new PendingScript([state], attentionReason, refundReason);
        }
    }

    /// <summary>Move an order to an OpenReceive state; entering <c>completed</c> pays the invoice once. Caller holds the gate.</summary>
    private void Apply(FakeOrder order, string state)
    {
        order.State = state;
        if (state is "refund_required" or "refund_pending" or "refunded") order.RefundReason ??= "underpaid";
        if (state == "attention") order.AttentionReason ??= "provider_reported_emergency";
        if (state == "completed" && !order.PayerInvoked)
        {
            order.PayerInvoked = true;
            InvokePayer(order);
        }
    }

    private void InvokePayer(FakeOrder order)
    {
        if (_options.Payer is not { } payer)
        {
            _options.Log($"order={order.Id} completed (no payer configured)");
            return;
        }
        _options.Log($"order={order.Id} completed; paying invoice");
        _payerTasks.Add(Task.Run(async () =>
        {
            try
            {
                await payer(order.Bolt11, CancellationToken.None).ConfigureAwait(false);
                _options.Log($"order={order.Id} invoice paid");
            }
            catch (Exception ex)
            {
                LastPayerError = ex.Message;
                _options.Log($"order={order.Id} payer failed: {ex.Message}");
            }
        }));
    }

    private static bool IsAsset(string selector) => FakeLscAssets.ByPayInAsset(selector) is not null;

    private IEnumerable<FakeOrder> Match(string assetOrOrderId) =>
        IsAsset(assetOrOrderId)
            ? _orders.Values.Where(o => o.Asset == assetOrOrderId).ToArray()
            : _orders.TryGetValue(assetOrOrderId, out var order) ? [order] : [];

    // ----- rendering ------------------------------------------------------------

    private JsonObject Render(FakeOrder order)
    {
        var (status, choice) = order.State switch
        {
            "awaiting_deposit" => ("NEW", "NONE"),
            "confirming" => ("PENDING", "NONE"),
            "exchanging" => ("EXCHANGE", "NONE"),
            "paying_invoice" => ("WITHDRAW", "NONE"),
            "completed" => ("DONE", "NONE"),
            "expired" => ("EXPIRED", "NONE"),
            "refund_required" => ("EMERGENCY", "NONE"),
            "refund_pending" => ("EMERGENCY", "REFUND"),
            "refunded" => ("EMERGENCY", "REFUND"),
            "attention" => order.AttentionReason == "provider_status_unrecognized" ? ("SOMETHING_NEW", "NONE") : ("EMERGENCY", "EXCHANGE"),
            "failed" => ("FAILED", "NONE"),
            _ => throw new InvalidOperationException($"Unrenderable state {order.State}"),
        };
        var emergencyStatuses = status == "EMERGENCY"
            ? EmergencyStatusesByReason[order.RefundReason ?? "underpaid"]
            : [];
        var depositSeen = order.State is not ("awaiting_deposit" or "expired");
        var depositAmount = FakeLscAssets.FormatAmount(order.DepositAmount);

        var from = new JsonObject
        {
            ["code"] = order.Currency.Code,
            ["coin"] = order.Currency.Coin,
            ["network"] = order.Currency.Network,
            ["address"] = order.Currency.DepositAddress,
            ["tag"] = null,
            ["amount"] = depositAmount,
            ["usd"] = FakeLscAssets.FormatUsd(order.FromUsd),
        };
        if (depositSeen)
        {
            from["tx"] = new JsonObject { ["id"] = $"fake-deposit-{order.Id}", ["amount"] = depositAmount };
        }

        var to = new JsonObject
        {
            ["code"] = FakeLscAssets.LightningCode,
            ["coin"] = FakeLscAssets.LightningCoin,
            ["network"] = FakeLscAssets.LightningNetwork,
            ["address"] = order.Bolt11,
            ["amount"] = FakeLscAssets.FormatAmount(order.BtcAmount),
            ["usd"] = FakeLscAssets.FormatUsd(order.ToUsd),
        };
        if (order.State == "completed")
        {
            to["tx"] = new JsonObject { ["id"] = $"fake-payout-{order.Id}", ["amount"] = FakeLscAssets.FormatAmount(order.BtcAmount) };
        }

        var body = new JsonObject
        {
            ["id"] = order.Id,
            ["type"] = "fixed",
            ["token"] = order.Token,
            ["status"] = status,
            ["time"] = new JsonObject
            {
                ["reg"] = order.Registered,
                ["start"] = order.Registered,
                ["expiration"] = order.Expiration,
                ["left"] = Math.Max(0, order.Expiration - _options.Clock()),
            },
            ["from"] = from,
            ["to"] = to,
            ["emergency"] = new JsonObject
            {
                ["status"] = new JsonArray(emergencyStatuses.Select(s => (JsonNode)s).ToArray()),
                ["choice"] = choice,
                ["repeat"] = 0,
            },
        };

        if (order.RefundAddress is not null || order.State == "refunded")
        {
            var back = new JsonObject { ["address"] = order.RefundAddress, ["amount"] = depositAmount };
            if (order.State == "refunded")
            {
                back["tx"] = new JsonObject { ["id"] = $"fake-refund-{order.Id}", ["amount"] = depositAmount };
            }
            body["back"] = back;
        }
        return body;
    }

    private string RatesXml()
    {
        var sb = new StringBuilder("<rates>\n");
        foreach (var asset in FakeLscAssets.All.Where(a => _options.SupportedAssets.Contains(a.PayInAsset)))
        {
            sb.Append("  <item>")
              .Append("<from>").Append(asset.Code).Append("</from>")
              .Append("<to>").Append(FakeLscAssets.LightningCode).Append("</to>")
              .Append("<in>").Append(FakeLscAssets.FormatAmount(FakeLscAssets.Markup)).Append("</in>")
              .Append("<out>").Append(FakeLscAssets.FormatAmount(FakeLscAssets.BtcPerUnit(asset.Coin))).Append("</out>")
              .Append("<amount>10 BTC</amount>")
              .Append("<minamount>").Append(asset.MinAmount).Append(' ').Append(asset.Coin).Append("</minamount>")
              .Append("<maxamount>").Append(asset.MaxAmount).Append(' ').Append(asset.Coin).Append("</maxamount>")
              .Append("<tofee>0.0000 BTC</tofee>")
              .Append("</item>\n");
        }
        return sb.Append("</rates>\n").ToString();
    }

    /// <summary>The trade a <c>/price</c> or <c>/create</c> body describes, or the API error it earns.</summary>
    private Trade ResolveTrade(JsonObject request)
    {
        var fromCcy = request["fromCcy"]?.ToString() ?? "";
        var toCcy = request["toCcy"]?.ToString() ?? "";
        var direction = request["direction"]?.ToString() ?? "to";
        var asset = FakeLscAssets.ByCode(fromCcy);
        if (asset is null || !_options.SupportedAssets.Contains(asset.PayInAsset))
            return new Trade($"Currency {fromCcy} is not supported for deposits.");
        if (!string.Equals(toCcy, FakeLscAssets.LightningCode, StringComparison.OrdinalIgnoreCase))
            return new Trade($"Currency {toCcy} is not supported for payouts.");
        if (!string.Equals(direction, "to", StringComparison.OrdinalIgnoreCase))
            return new Trade("Only direction \"to\" is supported.");
        if (!FakeLscAssets.TryParseAmount(request["amount"]?.ToString(), out var btcAmount))
            return new Trade("amount must be a positive decimal.");

        var depositAmount = _options.PayAmounts.TryGetValue(asset.PayInAsset, out var overrideText)
            && FakeLscAssets.TryParseAmount(overrideText, out var overrideAmount)
                ? overrideAmount
                : FakeLscAssets.DepositAmountFor(asset, btcAmount);
        return new Trade(null)
        {
            Asset = asset,
            BtcAmount = btcAmount,
            DepositAmount = depositAmount,
            FromUsd = FakeLscAssets.UsdValue(asset.Coin, depositAmount),
            ToUsd = FakeLscAssets.UsdValue(FakeLscAssets.LightningCoin, btcAmount),
        };
    }

    private static FakeHttpResponse Ok(JsonNode data) => Envelope(200, 0, "OK", data);

    private static FakeHttpResponse Envelope(int httpStatus, int code, string msg, JsonNode? data = null)
    {
        var envelope = new JsonObject { ["code"] = code, ["msg"] = msg, ["data"] = data };
        return new FakeHttpResponse(httpStatus, JsonContentType, envelope.ToJsonString());
    }

    private static string RandomAlnum(int length)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        return RandomNumberGenerator.GetString(alphabet, length);
    }

    private sealed record Trade(string? Error)
    {
        public FakeLscAsset? Asset { get; init; }
        public decimal BtcAmount { get; init; }
        public decimal DepositAmount { get; init; }
        public decimal FromUsd { get; init; }
        public decimal ToUsd { get; init; }
    }

    private sealed record PendingScript(List<string> Steps, string? AttentionReason, string? RefundReason);

    private sealed class FakeOrder
    {
        public required string Id { get; init; }
        public required string Token { get; init; }
        public required string Asset { get; init; }
        public required FakeLscAsset Currency { get; init; }
        public required string Bolt11 { get; init; }
        public required decimal DepositAmount { get; init; }
        public required decimal BtcAmount { get; init; }
        public required decimal FromUsd { get; init; }
        public required decimal ToUsd { get; init; }
        public required long Registered { get; init; }
        public required long Expiration { get; init; }
        public string State { get; set; } = "awaiting_deposit";
        public List<string> Steps { get; set; } = [];
        public int Next { get; set; }
        public string? AttentionReason { get; set; }
        public string? RefundReason { get; set; }
        public string? RefundAddress { get; set; }
        public bool PayerInvoked { get; set; }
    }
}
