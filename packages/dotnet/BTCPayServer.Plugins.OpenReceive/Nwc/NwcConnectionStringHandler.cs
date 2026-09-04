#nullable enable
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Lightning;
using Microsoft.Extensions.Logging;
using NBitcoin;
using NNostr.Client;

namespace BTCPayServer.Plugins.OpenReceive.Nwc;

/// <summary>
/// Everything one connection string shares across the many client instances BTCPay
/// creates for it: the relay transport (with its negotiated encryption), the scan memo,
/// and the last capability summary. Process-local by design.
/// </summary>
public sealed class NwcConnectionState
{
    public NwcConnectionState(NwcUri uri, bool allowSpendCapableWallet, IReceiveNwcTransport transport, Func<long> clock, ILogger logger)
    {
        Uri = uri;
        AllowSpendCapableWallet = allowSpendCapableWallet;
        Transport = transport;
        ListPage = ListPageAsync;
        Memo = new ScanMemo(ListPage, clock, logger);
    }

    public NwcUri Uri { get; }
    public bool AllowSpendCapableWallet { get; }
    public IReceiveNwcTransport Transport { get; }
    public ScanMemo Memo { get; }
    public ListTransactionsPage ListPage { get; }
    public WalletCapabilitySummary? Capabilities { get; private set; }

    public bool LookupInvoiceGranted => MethodGranted("lookup_invoice");

    public bool MethodGranted(string method) =>
        Capabilities?.Methods.Contains(method, StringComparer.Ordinal) == true;

    public void RememberCapabilities(WalletCapabilitySummary summary) => Capabilities = summary;

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
    private readonly ILoggerFactory _loggerFactory;
    private readonly Func<long> _clock;

    public NwcConnectionRegistry(NostrClientPool pool, ILoggerFactory loggerFactory)
    {
        _pool = pool;
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
            return new NwcConnectionState(uri, connection.AllowSpendCapableWallet, transport, _clock, logger);
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
            error = e.Message;
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
