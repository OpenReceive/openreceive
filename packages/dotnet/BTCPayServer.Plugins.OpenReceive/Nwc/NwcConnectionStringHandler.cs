#nullable enable
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Lightning;
using BTCPayServer.Plugins.OpenReceive.Data;
using Microsoft.Extensions.Logging;
using NBitcoin;
using NNostr.Client;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// Everything one connection string shares across the many client instances BTCPay
/// creates for it: the relay transport (with its negotiated encryption), the scan memo,
/// and the capability summary. Capabilities come from the wallet's kind-13194 info event
/// the first time anything needs them (so they survive a BTCPay restart without a
/// preflight) and are replaced by the fuller <c>get_info</c> summary when a preflight
/// runs. All of that is process-local; what a restart must not lose — the invoices minted
/// here — lives in <see cref="IInvoiceStore"/>, and <see cref="RestoreAsync"/> hands a
/// forgotten one back to the memo.
/// </summary>
public sealed class NwcConnectionState
{
    private readonly ILogger _logger;

    public NwcConnectionState(NwcUri uri, bool allowSpendCapableWallet, IReceiveNwcTransport transport, IInvoiceStore invoices, Func<long> clock, ILogger logger)
    {
        Uri = uri;
        AllowSpendCapableWallet = allowSpendCapableWallet;
        Transport = transport;
        Invoices = invoices;
        _logger = logger;
        ListPage = ListPageAsync;
        Memo = new ScanMemo(ListPage, clock, logger, LookupIfGrantedAsync);
    }

    public NwcUri Uri { get; }
    public string ConnectionId => Uri.WalletPubkey.ToLowerInvariant() + ":" + Uri.SecretKey.CreateXOnlyPubKey().ToHex();
    public bool AllowSpendCapableWallet { get; }
    public IReceiveNwcTransport Transport { get; }
    public IInvoiceStore Invoices { get; }
    public ScanMemo Memo { get; }
    public ListTransactionsPage ListPage { get; }
    public WalletCapabilitySummary? Capabilities { get; private set; }

    /// <summary>What is known right now; <see cref="LookupInvoiceGrantedAsync"/> learns first.</summary>
    public bool LookupInvoiceGranted => MethodGranted("lookup_invoice");

    public bool MethodGranted(string method) =>
        Capabilities?.Methods.Contains(method, StringComparer.Ordinal) == true;

    public void RememberCapabilities(WalletCapabilitySummary summary) => Capabilities = summary;

    /// <summary>
    /// Learns the capabilities from the info event when nothing has recorded them yet in
    /// this process. One relay read per connection per process; a relay that is down
    /// leaves them unknown (every method reads as not granted) until the next call.
    /// </summary>
    public async Task EnsureCapabilitiesAsync(CancellationToken cancellationToken)
    {
        if (Capabilities is not null) return;
        try
        {
            var info = await Transport.FetchServiceInfoAsync(cancellationToken).ConfigureAwait(false);
            if (info is null || Capabilities is not null) return;
            RememberCapabilities(NwcInfo.FromServiceInfo(Uri, info));
            _logger.LogInformation("nwc.capabilities.learned wallet={Wallet} methods={Methods}", Uri.WalletPubkey, string.Join(",", Capabilities!.Methods));
        }
        catch (NwcTransportException e)
        {
            _logger.LogDebug("nwc.capabilities.unavailable wallet={Wallet} error={Error}", Uri.WalletPubkey, SecretSafeDiagnostics.Text(e.Message));
        }
    }

    /// <summary>
    /// Gives the memo back an invoice it has forgotten (a restart): the stored row, as the
    /// pending row the memo held when it was minted. The walk for it then starts at its own
    /// creation time and it closes by its own expiry, exactly as before the restart. A hash
    /// with no stored row was not minted here; the memo treats it as one of unknown age.
    /// </summary>
    public async Task<bool> RestoreAsync(string paymentHash, CancellationToken cancellationToken)
    {
        paymentHash = NwcNormalize.CanonicalHash(paymentHash);
        var stored = await Invoices.FindAsync(paymentHash, cancellationToken).ConfigureAwait(false);
        if (stored is null) return true; // Host invoice predating this plugin's mint table.
        if (stored.ConnectionId != ConnectionId) return false;
        if (Memo.Lookup(paymentHash) is not null) return true;
        Memo.Record(new NwcTransaction
        {
            Type = "incoming",
            Invoice = stored.Bolt11,
            PaymentHash = stored.PaymentHash,
            AmountMsats = stored.AmountMsats,
            CreatedAt = stored.CreatedAtAuthoritative ? stored.CreatedAt : 0,
            ExpiresAt = stored.ExpiresAt,
            TransactionState = "pending",
        });
        _logger.LogDebug("nwc.invoice.restored payment_hash={Hash} created_at={CreatedAt}", paymentHash, stored.CreatedAt);
        return true;
    }

    public async Task<bool> LookupInvoiceGrantedAsync(CancellationToken cancellationToken)
    {
        await EnsureCapabilitiesAsync(cancellationToken).ConfigureAwait(false);
        return LookupInvoiceGranted;
    }

    /// <summary>The memo's fallback for a hash a walk could not reach: <c>lookup_invoice</c> when granted.</summary>
    public async Task<LookupResult> LookupIfGrantedAsync(string paymentHash, CancellationToken cancellationToken)
    {
        if (!await LookupInvoiceGrantedAsync(cancellationToken).ConfigureAwait(false)) return LookupResult.Unavailable;
        try
        {
            var raw = await Transport.RequestAsync("lookup_invoice", new JsonObject { ["payment_hash"] = paymentHash }, cancellationToken).ConfigureAwait(false);
            // The wallet's own hash names the row; the requested one only fills a reply that omits it.
            var row = NwcNormalize.Transaction(raw);
            return new LookupResult(LookupOutcome.Found, row.PaymentHash is null ? row with { PaymentHash = paymentHash } : row);
        }
        catch (NwcRequestException e) when (string.Equals(e.Code, "NOT_FOUND", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogDebug("nwc.lookup_invoice.not_found payment_hash={Hash}", paymentHash);
            return LookupResult.NotFound;
        }
        catch (NwcRequestException e)
        {
            _logger.LogDebug("nwc.lookup_invoice.error payment_hash={Hash} code={Code}", paymentHash, e.Code);
            return LookupResult.Unavailable;
        }
    }

    private async Task<ListTransactionsResult> ListPageAsync(ListTransactionsRequest request, CancellationToken cancellationToken)
    {
        var raw = await Transport.RequestAsync("list_transactions", NwcNormalize.ToListTransactionsParams(request), cancellationToken).ConfigureAwait(false);
        return NwcNormalize.ListTransactions(raw);
    }
}

/// <summary>Registry of per-connection state, keyed by the connection string.</summary>
public sealed class NwcConnectionRegistry
{
    private readonly ConcurrentDictionary<string, NwcConnectionState> _states = new(StringComparer.Ordinal);
    private readonly NostrClientPool _pool;
    private readonly IInvoiceStore _invoices;
    private readonly ILoggerFactory _loggerFactory;
    private readonly Func<long> _clock;

    public NwcConnectionRegistry(NostrClientPool pool, IInvoiceStore invoices, ILoggerFactory loggerFactory)
    {
        _pool = pool;
        _invoices = invoices;
        _loggerFactory = loggerFactory;
        _clock = static () => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    }

    public NwcConnectionState GetOrAdd(OpenReceiveConnectionString connection, NwcUri uri)
    {
        var key = connection.Format();
        return _states.GetOrAdd(key, _ =>
        {
            var logger = _loggerFactory.CreateLogger<ReceiveOnlyNwcClient>();
            var transport = new NwcRelayTransport(_pool, uri, logger);
            return new NwcConnectionState(uri, connection.AllowSpendCapableWallet, transport, _invoices, _clock, logger);
        });
    }

    public NwcConnectionState? Find(string connectionString) =>
        _states.TryGetValue(connectionString, out var state) ? state : null;
}

/// <summary>
/// Claims <c>type=openreceive;nwc=…</c> and nothing else, so a server with both this and
/// the Nostr plugin installed stays deterministic (BTCPay takes the first handler that
/// returns non-null, in registration order).
/// </summary>
public sealed class NwcConnectionStringHandler : ILightningConnectionStringHandler
{
    private readonly NwcConnectionRegistry _registry;
    private readonly ILogger<ReceiveOnlyNwcClient> _logger;

    public NwcConnectionStringHandler(NwcConnectionRegistry registry, ILogger<ReceiveOnlyNwcClient> logger)
    {
        _registry = registry;
        _logger = logger;
    }

    public ILightningClient? Create(string connectionString, Network network, out string? error)
    {
        OpenReceiveConnectionString? parsed;
        try
        {
            parsed = OpenReceiveConnectionString.Parse(connectionString);
        }
        catch (FormatException e)
        {
            error = SecretSafeDiagnostics.Text(e.Message);
            return null;
        }
        if (parsed is null)
        {
            error = null;
            return null;
        }
        if (!NwcUri.TryParse(parsed.NwcUri, out var uri, out var parseError) || uri is null)
        {
            error = NwcUri.FormatInvalidNwcMessage(parseError?.Message, "The nwc= value");
            return null;
        }
        error = null;
        var state = _registry.GetOrAdd(parsed, uri);
        return new ReceiveOnlyNwcClient(state, network, _logger);
    }
}
