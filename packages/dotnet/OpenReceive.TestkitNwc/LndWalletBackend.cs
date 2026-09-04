using BTCPayServer.Lightning;
using Microsoft.Extensions.Logging;
using NBitcoin;

namespace OpenReceive.TestkitNwc;

/// <summary>
/// Real invoices from an LND (or any BTCPayServer.Lightning-supported) node. Creation time,
/// description and description hash come from the bolt11 itself since the client API omits them.
/// </summary>
public sealed class LndWalletBackend : IWalletBackend
{
    private readonly ILightningClient _client;
    private readonly Network _network;
    private readonly ILogger? _logger;

    public LndWalletBackend(string connectionString, Network network, ILogger? logger = null)
        : this(new LightningClientFactory(network).Create(connectionString), network, logger)
    {
    }

    public LndWalletBackend(ILightningClient client, Network network, ILogger? logger = null)
    {
        _client = client;
        _network = network;
        _logger = logger;
        Network = NetworkNames.Nip47Name(network);
    }

    public string Network { get; }

    public event Action<WalletInvoice>? InvoiceSettled;

    public async Task<WalletInvoice> MakeInvoiceAsync(long amountMsats, string? description, string? descriptionHash,
        int? expirySeconds, CancellationToken cancellationToken)
    {
        var expiry = TimeSpan.FromSeconds(expirySeconds ?? 3600);
        var amount = LightMoney.MilliSatoshis(amountMsats);
        // NIP-47 hands us the hash itself, so the (obsolete but functional) DescriptionHash setter is
        // the right tool: DescriptionHashOnly alone would make the node hash our empty Description.
#pragma warning disable CS0618
        var request = descriptionHash is not null
            ? new CreateInvoiceParams(amount, "", expiry) { DescriptionHash = uint256.Parse(descriptionHash), DescriptionHashOnly = true }
            : new CreateInvoiceParams(amount, description ?? "", expiry);
#pragma warning restore CS0618
        var invoice = await _client.CreateInvoice(request, cancellationToken);
        return Convert(invoice);
    }

    public async Task<WalletInvoice?> LookupAsync(string? paymentHash, string? bolt11, CancellationToken cancellationToken)
    {
        var hash = paymentHash;
        if (hash is null && bolt11 is not null && BOLT11PaymentRequest.TryParse(bolt11, out var parsed, _network))
            hash = parsed?.PaymentHash?.ToString();
        if (hash is null)
            return null;
        try
        {
            var invoice = await _client.GetInvoice(hash, cancellationToken);
            return invoice is null ? null : Convert(invoice);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            _logger?.LogDebug(e, "GetInvoice({PaymentHash}) failed; reporting not found", hash);
            return null;
        }
    }

    public async Task<IReadOnlyList<WalletInvoice>> ListIncomingAsync(long? from, long? until, bool unpaid,
        CancellationToken cancellationToken)
    {
        var invoices = await _client.ListInvoices(new ListInvoicesParams { PendingOnly = false }, cancellationToken);
        return invoices
            .Select(Convert)
            .Where(i => unpaid || i.IsSettled)
            .Where(i => from is null || i.CreatedAt >= from)
            .Where(i => until is null || i.CreatedAt <= until)
            .OrderByDescending(i => i.CreatedAt)
            .ToList();
    }

    public async Task<long> BalanceMsatsAsync(CancellationToken cancellationToken)
    {
        var balance = await _client.GetBalance(cancellationToken);
        return balance.OffchainBalance?.Local?.MilliSatoshi ?? 0;
    }

    /// <summary>Follow the node's invoice stream until cancelled, raising <see cref="InvoiceSettled"/> for each payment.</summary>
    public async Task ListenAsync(CancellationToken cancellationToken)
    {
        var backoff = TimeSpan.FromSeconds(1);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var listener = await _client.Listen(cancellationToken);
                backoff = TimeSpan.FromSeconds(1);
                while (!cancellationToken.IsCancellationRequested)
                {
                    var invoice = await listener.WaitInvoice(cancellationToken);
                    if (invoice?.Status == LightningInvoiceStatus.Paid)
                        InvoiceSettled?.Invoke(Convert(invoice));
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
            catch (Exception e)
            {
                _logger?.LogWarning(e, "Invoice listener dropped; retrying in {Backoff}", backoff);
                await Task.Delay(backoff, cancellationToken);
                backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 30));
            }
        }
    }

    private WalletInvoice Convert(LightningInvoice invoice)
    {
        BOLT11PaymentRequest.TryParse(invoice.BOLT11, out var bolt11, _network);
        var settled = invoice.Status == LightningInvoiceStatus.Paid;
        return new WalletInvoice
        {
            PaymentHash = invoice.PaymentHash ?? bolt11?.PaymentHash?.ToString() ?? invoice.Id,
            Bolt11 = invoice.BOLT11,
            AmountMsats = invoice.Amount?.MilliSatoshi ?? 0,
            Description = bolt11?.ShortDescription,
            DescriptionHash = bolt11?.DescriptionHash?.ToString(),
            Preimage = settled ? invoice.Preimage : null,
            CreatedAt = (bolt11?.Timestamp ?? invoice.ExpiresAt).ToUnixTimeSeconds(),
            ExpiresAt = invoice.ExpiresAt.ToUnixTimeSeconds(),
            SettledAt = settled ? (invoice.PaidAt ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds() : null,
            State = invoice.Status switch
            {
                LightningInvoiceStatus.Paid => InvoiceState.Settled,
                LightningInvoiceStatus.Expired => InvoiceState.Expired,
                _ => InvoiceState.Pending,
            },
        };
    }
}

public static class NetworkNames
{
    public static Network Parse(string name) => name.ToLowerInvariant() switch
    {
        "mainnet" or "main" or "bitcoin" => Network.Main,
        "testnet" => Network.TestNet,
        "signet" => Bitcoin.Instance.Signet,
        "regtest" => Network.RegTest,
        _ => throw new ArgumentException($"Unknown network '{name}' (expected regtest|mainnet|testnet|signet)"),
    };

    public static string Nip47Name(Network network) =>
        network == Network.Main ? "mainnet"
        : network == Network.TestNet ? "testnet"
        : network == Bitcoin.Instance.Signet ? "signet"
        : "regtest";
}
