#nullable enable
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Lightning;
using BTCPayServer.Payments;
using BTCPayServer.Payments.Lightning;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Generated;
using Microsoft.Extensions.Logging;
using NBitcoin;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// The receive-only NWC Lightning backend BTCPay drives through its own
/// <c>LightningListener</c>. Every Lightning operation goes through the NWC connection;
/// the internal node is never consulted. It never calls a NIP-47 <c>pay_*</c> method,
/// whatever the wallet grants: every send-side member throws
/// <see cref="NotSupportedException"/>.
/// </summary>
public sealed class ReceiveOnlyNwcClient : IExtendedLightningClient
{
    public const string ReceiveOnlyMessage = "OpenReceive is receive-only: this Lightning connection cannot send.";
    private static readonly TimeSpan ExpiryTolerance = TimeSpan.FromSeconds(60);
    /// <summary>
    /// The longest invoice this backend mints, whatever BTCPay asks for. Most NWC wallet
    /// services refuse or clamp an expiry further out than a day, and a clamped invoice
    /// would trip the expiry check below and be refused; it also keeps every minted invoice
    /// inside the memo's fallback window (<see cref="ScanMemo.Window"/>), so a hash with no
    /// stored row (minted before the plugin kept one) is still found by the bounded walk. The setup page lowers the
    /// store's own timer to the same bound, so the checkout and the invoice agree.
    /// </summary>
    public static readonly TimeSpan MaxInvoiceExpiry = ScanMemo.Window;
    private const int ListInvoicesMaxPages = 25;

    private readonly NwcConnectionState _state;
    private readonly Network _network;
    private readonly ILogger _logger;

    public ReceiveOnlyNwcClient(NwcConnectionState state, Network network, ILogger logger)
    {
        _state = state;
        _network = network;
        _logger = logger;
    }

    public NwcUri Uri => _state.Uri;
    public bool AllowSpendCapableWallet => _state.AllowSpendCapableWallet;
    internal ScanMemo Memo => _state.Memo;
    internal IReceiveNwcTransport Transport => _state.Transport;

    /// <summary>BTCPay persists exactly this string; the secret stays inside it by design.</summary>
    public override string ToString() => OpenReceiveConnectionString.Format(_state.Uri.Raw, _state.AllowSpendCapableWallet);

    public string? DisplayName
    {
        get
        {
            var relay = _state.Uri.Relays.FirstOrDefault()?.ToString().TrimEnd('/');
            var lud16 = _state.Uri.Lud16 is { Length: > 0 } l ? $" {l}" : string.Empty;
            return $"OpenReceive (receive-only NWC) {relay}{lud16}";
        }
    }

    public Uri? ServerUri => _state.Uri.Relays.FirstOrDefault();

    // ---- Validate: the receive-only preflight that runs on every save (UI and Greenfield) ----

    public async Task<ValidationResult?> Validate()
    {
        var report = await PreflightAsync(CancellationToken.None).ConfigureAwait(false);
        return report.Ok ? ValidationResult.Success : new ValidationResult(report.Message);
    }

    /// <summary>The full preflight, also used by the setup and doctor pages.</summary>
    public async Task<WalletPreflightReport> PreflightAsync(CancellationToken cancellationToken)
    {
        var startedAt = DateTimeOffset.UtcNow;
        NwcServiceInfo? serviceInfo;
        JsonNode? getInfo;
        try
        {
            serviceInfo = await _state.Transport.FetchServiceInfoAsync(cancellationToken).ConfigureAwait(false);
            if (serviceInfo is null)
            {
                return WalletPreflightReport.Failed("no_info_event",
                    "No NIP-47 info event was found for this wallet on its relay(s). Check the relay URL and that the wallet service is online.\n" +
                    $"Get a receive-only NWC code here: {NwcUri.CodeHelpUrl}", startedAt);
            }
            getInfo = await _state.Transport.RequestAsync("get_info", new JsonObject(), cancellationToken).ConfigureAwait(false);
        }
        catch (NwcRequestException e)
        {
            return WalletPreflightReport.Failed("get_info_failed",
                $"The wallet refused get_info ({e.Code}): {e.Message}\nGet a receive-only NWC code here: {NwcUri.CodeHelpUrl}", startedAt);
        }
        catch (NwcTransportException e)
        {
            return WalletPreflightReport.Failed("relay_unreachable",
                $"Could not reach the wallet through its relay: {e.Message}\nGet a receive-only NWC code here: {NwcUri.CodeHelpUrl}", startedAt);
        }
        var relayRtt = DateTimeOffset.UtcNow - startedAt;
        var serviceInfoJson = new JsonObject
        {
            ["methods"] = new JsonArray(serviceInfo.Methods.Select(m => (JsonNode?)m).ToArray()),
            ["notifications"] = new JsonArray(serviceInfo.Notifications.Select(n => (JsonNode?)n).ToArray()),
            ["encryption"] = new JsonArray(serviceInfo.EncryptionSchemes.Select(e => (JsonNode?)e).ToArray()),
        };
        var summary = NwcInfo.Summarize(_state.Uri, getInfo, serviceInfoJson);
        if (summary.Notifications.Count == 0 && serviceInfo.Notifications.Count > 0)
        {
            summary = summary with { Notifications = serviceInfo.Notifications };
        }
        _state.RememberCapabilities(summary);
        var preflight = WalletPreflight.Evaluate(summary, _state.AllowSpendCapableWallet);
        if (!preflight.Ok)
        {
            _logger.LogWarning("nwc.preflight.refused wallet={Wallet} code={Code}", _state.Uri.WalletPubkey, preflight.Code);
            return WalletPreflightReport.Failed(preflight.Code!, preflight.Message!, startedAt, summary, relayRtt);
        }
        if (preflight.Warning is not null)
        {
            // A deliberate, user-checked override: a warning on every preflight, never an error
            // (an error on every doctor visit only teaches operators to ignore errors).
            _logger.LogWarning("nwc.preflight.spend_override wallet={Wallet} {Warning}", _state.Uri.WalletPubkey, preflight.Warning);
        }
        var expectedNetwork = Nip47NetworkName(_network);
        var walletNetwork = NormalizeWalletNetwork(summary.Network);
        if (walletNetwork is not null && !string.Equals(walletNetwork, expectedNetwork, StringComparison.Ordinal))
        {
            return WalletPreflightReport.Failed("network_mismatch",
                $"The wallet is on {walletNetwork} but this BTCPay Server runs on {expectedNetwork}. Connect a wallet on the same network.\nGet a receive-only NWC code here: {NwcUri.CodeHelpUrl}",
                startedAt, summary, relayRtt);
        }
        _logger.LogInformation("nwc.preflight.ok wallet={Wallet} encryption={Encryption} notifications={Notifications} methods={Methods}",
            _state.Uri.WalletPubkey, summary.Encryption, string.Join(",", summary.Notifications), string.Join(",", summary.Methods));
        return WalletPreflightReport.Succeeded(summary, startedAt, relayRtt, preflight.Warning);
    }

    /// <summary>NBitcoin chain names → NIP-47 network words. An explicit map, never ToString() equality.</summary>
    public static string Nip47NetworkName(Network network)
    {
        var name = network.ChainName.ToString().ToLowerInvariant();
        return name switch
        {
            "main" or "mainnet" => "mainnet",
            "test" or "testnet" or "testnet3" or "testnet4" => "testnet",
            "regtest" => "regtest",
            "signet" or "mutinynet" => "signet",
            _ => name,
        };
    }

    private static string? NormalizeWalletNetwork(string? network)
    {
        if (string.IsNullOrWhiteSpace(network)) return null;
        var value = network.Trim().ToLowerInvariant();
        return value switch
        {
            "bitcoin" or "main" or "mainnet" => "mainnet",
            "testnet" or "testnet3" or "testnet4" or "test" => "testnet",
            "regtest" => "regtest",
            "signet" or "mutinynet" => "signet",
            _ => value,
        };
    }

    // ---- Invoices ----

    public Task<LightningInvoice> CreateInvoice(LightMoney amount, string description, TimeSpan expiry, CancellationToken cancellation = default) =>
        CreateInvoice(new CreateInvoiceParams(amount, description, expiry), cancellation);

    public async Task<LightningInvoice> CreateInvoice(CreateInvoiceParams createInvoiceRequest, CancellationToken cancellation = default)
    {
        var amountMsats = createInvoiceRequest.Amount?.MilliSatoshi ?? 0;
        if (amountMsats <= 0)
        {
            // Never numeric 0 through the shared amount guard: top-ups are a BTCPay
            // case this backend does not model (plugin plan 0.21).
            throw new PaymentMethodUnavailableException("OpenReceive needs an amount; top-up invoices are not supported on a receive-only NWC wallet.");
        }
        // Expiry: BTCPay's, capped at MaxInvoiceExpiry. BTCPay asks for the remaining life of
        // its own invoice (the store's "invoice expires after" setting: 15 min by default, 60
        // min once swaps are on, up to 24 days), on both the checkout BOLT11 and LNURL paths,
        // and shows that one BOLT11 for the whole checkout, re-minting only on a partial
        // payment. A shorter Lightning expiry than the checkout timer leaves a dead QR on the
        // page, so the plugin never shortens what BTCPay asks for below the cap; above the
        // cap the store's timer is lowered on save (OpenReceiveSettingsService), and a store
        // that raises it again by hand gets a day-long invoice under a longer timer. This is
        // deliberately unlike the Node/Ruby engines' 10-minute default: there the host owns
        // both the timer and the expiry; here the timer is BTCPay's. Rounded to whole seconds
        // (NIP-47 `expiry` is an integer), never below 1.
        var requestedExpiry = createInvoiceRequest.Expiry;
        var cappedExpiry = requestedExpiry > MaxInvoiceExpiry ? MaxInvoiceExpiry : requestedExpiry;
        var expirySeconds = (int)Math.Max(1, Math.Round(cappedExpiry.TotalSeconds));
        if (cappedExpiry != requestedExpiry)
        {
            _logger.LogInformation("nwc.invoice.expiry_capped requested_seconds={Requested} minted_seconds={Minted}", (long)requestedExpiry.TotalSeconds, expirySeconds);
        }
        var request = new MakeInvoiceRequest
        {
            AmountMsats = amountMsats,
            Description = createInvoiceRequest.DescriptionHashOnly ? null : createInvoiceRequest.Description,
            DescriptionHash = createInvoiceRequest.DescriptionHashOnly ? createInvoiceRequest.DescriptionHash?.ToString() : null,
            Expiry = expirySeconds,
        };
        try
        {
            NwcNormalize.ValidateMakeInvoiceRequest(request);
        }
        catch (NwcValidationException e)
        {
            throw new PaymentMethodUnavailableException($"OpenReceive cannot mint this invoice: {e.Message}");
        }
        var requestedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        MakeInvoiceResult result;
        try
        {
            var raw = await _state.Transport.RequestAsync("make_invoice", NwcNormalize.ToMakeInvoiceParams(request), cancellation).ConfigureAwait(false);
            result = NwcNormalize.MakeInvoice(raw);
        }
        catch (NwcRequestException e)
        {
            var error = NwcErrors.Normalize(e);
            throw new PaymentMethodUnavailableException($"The NWC wallet refused make_invoice ({error.Code}): {error.Message}");
        }
        // The wallet must honour the requested expiry: BTCPay's checkout timer is its own
        // invoice's expiry, so a wallet that clamps to its own minimum or maximum would make
        // that timer lie (a QR that dies early, or one BTCPay reports expired while the wallet
        // still accepts it). Sixty seconds of tolerance covers clock skew and a wallet that
        // stamps created_at a moment after we asked; anything more is refused before BTCPay
        // ever shows the invoice. A wallet that omits expires_at is taken at its word.
        var createdAt = result.CreatedAt ?? requestedAt;
        var expectedExpiry = createdAt + expirySeconds;
        if (result.ExpiresAt is { } expiresAt && Math.Abs(expiresAt - expectedExpiry) > ExpiryTolerance.TotalSeconds)
        {
            throw new PaymentMethodUnavailableException(
                $"The NWC wallet minted an invoice expiring at {expiresAt} instead of the requested {expectedExpiry} (±60 s); refusing it so BTCPay's expiry stays truthful.");
        }
        var row = new NwcTransaction
        {
            Type = "incoming",
            Invoice = result.Invoice,
            PaymentHash = result.PaymentHash.ToLowerInvariant(),
            AmountMsats = result.AmountMsats,
            CreatedAt = createdAt,
            ExpiresAt = result.ExpiresAt ?? expectedExpiry,
            TransactionState = "pending",
            Description = request.Description,
            DescriptionHash = request.DescriptionHash,
        };
        // Committed before BTCPay can show the invoice to a payer: after a restart the memo
        // gets this row back (NwcConnectionState.RestoreAsync) instead of guessing its age.
        await _state.Invoices.InsertAsync(new OpenReceiveInvoice
        {
            PaymentHash = row.PaymentHash,
            Bolt11 = result.Invoice,
            AmountMsats = result.AmountMsats,
            CreatedAt = createdAt,
            ExpiresAt = result.ExpiresAt ?? expectedExpiry,
        }, cancellation).ConfigureAwait(false);
        _state.Memo.Record(row);
        _state.Memo.Watch(row.PaymentHash);
        _state.Memo.NoteInvoiceMinted(createdAt);
        _logger.LogInformation("nwc.invoice.created payment_hash={Hash} amount_msats={Amount} expires_at={ExpiresAt}", row.PaymentHash, row.AmountMsats, row.ExpiresAt);
        return ToLightningInvoice(row);
    }

    public Task<LightningInvoice> GetInvoice(string invoiceId, CancellationToken cancellation = default) =>
        GetInvoiceByHash(invoiceId, cancellation);

    public Task<LightningInvoice> GetInvoice(uint256 paymentHash, CancellationToken cancellation = default) =>
        GetInvoiceByHash(paymentHash.ToString(), cancellation);

    /// <summary>
    /// Every hash BTCPay asks about joins the connection's scan memo watch set, and one
    /// walk serves every caller. A hash the memo has forgotten (a restart) is first restored
    /// from the plugin's own table; one that was never minted here forces one targeted
    /// refresh (the memo looks it up when the wallet grants <c>lookup_invoice</c>, else
    /// walks for it). Paid iff the settlement rule says settled; Expired ONLY when the
    /// wallet's own row says expired/failed; Unpaid otherwise — including a hash the memo
    /// still has not seen, because a null or Expired answer makes BTCPay drop the hash from
    /// its watched set, and a wallet that ignores the <c>unpaid</c> flag would otherwise
    /// make BTCPay forget a live invoice. BTCPay's own state machine owns invoice expiry.
    /// </summary>
    private async Task<LightningInvoice> GetInvoiceByHash(string paymentHash, CancellationToken cancellation)
    {
        var hash = paymentHash.Trim().ToLowerInvariant();
        await _state.RestoreAsync(hash, cancellation).ConfigureAwait(false);
        _state.Memo.Watch(hash);
        var walked = await _state.Memo.RefreshAsync(force: false, cancellation).ConfigureAwait(false);
        var row = _state.Memo.Lookup(hash);
        if (row is null && !walked)
        {
            await _state.Memo.RefreshAsync(force: true, cancellation).ConfigureAwait(false);
            row = _state.Memo.Lookup(hash);
        }
        else if (row is not null && !Settlement.IsSettled(row) && row.AmountMsats is null && await _state.LookupInvoiceGrantedAsync(cancellation).ConfigureAwait(false))
        {
            row = await RefreshHashAsync(hash, cancellation).ConfigureAwait(false) ?? row;
        }
        if (row is null)
        {
            return new LightningInvoice
            {
                Id = hash,
                PaymentHash = hash,
                Status = LightningInvoiceStatus.Unpaid,
                ExpiresAt = DateTimeOffset.UtcNow.Add(Window()),
            };
        }
        return ToLightningInvoice(row);
    }

    /// <summary>
    /// The optional single-hash fast path: <c>lookup_invoice</c> when the wallet grants
    /// it (never required — a receive-only code the Node engine accepts works unchanged),
    /// else one forced memo walk. Returns the memo's row for the hash afterwards.
    /// </summary>
    internal async Task<NwcTransaction?> RefreshHashAsync(string paymentHash, CancellationToken cancellation)
    {
        _state.Memo.Watch(paymentHash);
        if (await _state.LookupInvoiceGrantedAsync(cancellation).ConfigureAwait(false))
        {
            try
            {
                var raw = await _state.Transport.RequestAsync("lookup_invoice", new JsonObject { ["payment_hash"] = paymentHash }, cancellation).ConfigureAwait(false);
                // The wallet's own hash names the row; the requested one only fills a reply that omits it.
                var row = NwcNormalize.Transaction(raw);
                _state.Memo.Record(row.PaymentHash is null ? row with { PaymentHash = paymentHash } : row);
                return _state.Memo.Lookup(paymentHash);
            }
            catch (NwcRequestException e)
            {
                _logger.LogDebug("nwc.lookup_invoice.error payment_hash={Hash} code={Code}", paymentHash, e.Code);
                return _state.Memo.Lookup(paymentHash);
            }
        }
        await _state.Memo.RefreshAsync(force: true, cancellation).ConfigureAwait(false);
        return _state.Memo.Lookup(paymentHash);
    }

    public Task<LightningInvoice[]> ListInvoices(CancellationToken cancellation = default) =>
        ListInvoices(new ListInvoicesParams(), cancellation);

    public async Task<LightningInvoice[]> ListInvoices(ListInvoicesParams request, CancellationToken cancellation = default)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        // An untargeted listing (BTCPay's own tooling, never settlement): bounded to the window and a few pages.
        var walk = await WalletScan.WalkAsync(_state.ListPage, now - (long)ScanMemo.Window.TotalSeconds, now + ScanMemo.OverlapSeconds,
            includeUnpaid: request.PendingOnly ?? false, expected: null, ListInvoicesMaxPages, cancellation).ConfigureAwait(false);
        var rows = walk.ByPaymentHash.Values.AsEnumerable();
        if (request.PendingOnly is true) rows = rows.Where(r => !Settlement.IsSettled(r));
        if (request.OffsetIndex is { } offset) rows = rows.Skip((int)offset);
        return rows.Select(ToLightningInvoice).ToArray();
    }

    public async Task<ILightningInvoiceListener> Listen(CancellationToken cancellation = default)
    {
        var info = await _state.Transport.FetchServiceInfoAsync(cancellation).ConfigureAwait(false);
        if (info is not null && _state.Capabilities is null)
        {
            _state.RememberCapabilities(NwcInfo.FromServiceInfo(_state.Uri, info)); // a restart without a preflight
        }
        var notifications = info?.Notifications.Contains("payment_received") == true
                            || _state.Capabilities?.Notifications.Contains("payment_received") == true;
        _logger.LogInformation("nwc.listen.start wallet={Wallet} mode={Mode}", _state.Uri.WalletPubkey, notifications ? "notifications" : "poll");
        return notifications
            ? new NwcNotificationListener(this, _state.Transport, _state.Memo, _logger)
            : new NwcPollListener(_state.Memo, _logger);
    }

    // ---- Node info and balance ----

    public Task<LightningNodeInformation> GetInfo(CancellationToken cancellation = default) =>
        throw new NotSupportedException("OpenReceive exposes no node information: the NWC wallet is remote.");

    public async Task<LightningNodeBalance> GetBalance(CancellationToken cancellation = default)
    {
        await _state.EnsureCapabilitiesAsync(cancellation).ConfigureAwait(false);
        if (!_state.MethodGranted("get_balance"))
        {
            throw new NotSupportedException("This NWC connection does not grant get_balance.");
        }
        var raw = await _state.Transport.RequestAsync("get_balance", new JsonObject(), cancellation).ConfigureAwait(false);
        var balance = raw?["balance"]?.GetValue<long>() ?? 0;
        return new LightningNodeBalance
        {
            OffchainBalance = new OffchainBalance { Local = LightMoney.MilliSatoshis(balance) },
        };
    }

    // ---- Everything that could spend: never a NIP-47 pay_* call, whatever the wallet grants ----

    public Task<PayResponse> Pay(PayInvoiceParams payParams, CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<PayResponse> Pay(string bolt11, PayInvoiceParams payParams, CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<PayResponse> Pay(string bolt11, CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<OpenChannelResponse> OpenChannel(OpenChannelRequest openChannelRequest, CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<BitcoinAddress> GetDepositAddress(CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<ConnectionResult> ConnectTo(NodeInfo nodeInfo, CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task CancelInvoice(string invoiceId, CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<LightningChannel[]> ListChannels(CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<LightningPayment> GetPayment(string paymentHash, CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<LightningPayment[]> ListPayments(CancellationToken cancellation = default) => throw ReceiveOnly();
    public Task<LightningPayment[]> ListPayments(ListPaymentsParams request, CancellationToken cancellation = default) => throw ReceiveOnly();

    private static NotSupportedException ReceiveOnly() => new(ReceiveOnlyMessage);

    private static TimeSpan Window() => ScanMemo.Window;

    /// <summary>Maps a normalized wallet row to BTCPay's invoice: Id MUST be the payment hash (listener contract).</summary>
    public static LightningInvoice ToLightningInvoice(NwcTransaction row)
    {
        var detection = Settlement.Classify(row);
        var status = detection.Status switch
        {
            "settled" => LightningInvoiceStatus.Paid,
            "expired" or "failed" => LightningInvoiceStatus.Expired,
            _ => LightningInvoiceStatus.Unpaid,
        };
        var amount = row.AmountMsats is { } msats ? LightMoney.MilliSatoshis(msats) : null;
        return new LightningInvoice
        {
            Id = row.PaymentHash,
            PaymentHash = row.PaymentHash,
            BOLT11 = row.Invoice,
            Amount = amount,
            AmountReceived = status == LightningInvoiceStatus.Paid ? amount : null,
            Preimage = row.Preimage,
            Status = status,
            PaidAt = status == LightningInvoiceStatus.Paid
                ? DateTimeOffset.FromUnixTimeSeconds(row.SettledAt ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                : null,
            ExpiresAt = row.ExpiresAt is { } expires
                ? DateTimeOffset.FromUnixTimeSeconds(expires)
                : DateTimeOffset.UtcNow.Add(Window()),
        };
    }
}

/// <summary>Outcome of a preflight, for Validate(), the setup page and the doctor.</summary>
public sealed record WalletPreflightReport(
    bool Ok,
    string? Code,
    string? Message,
    WalletCapabilitySummary? Summary,
    DateTimeOffset CheckedAt,
    TimeSpan? RelayRoundTrip,
    string? Warning)
{
    public static WalletPreflightReport Failed(string code, string message, DateTimeOffset checkedAt, WalletCapabilitySummary? summary = null, TimeSpan? rtt = null) =>
        new(false, code, message, summary, checkedAt, rtt, null);

    public static WalletPreflightReport Succeeded(WalletCapabilitySummary summary, DateTimeOffset checkedAt, TimeSpan rtt, string? warning) =>
        new(true, null, null, summary, checkedAt, rtt, warning);
}
