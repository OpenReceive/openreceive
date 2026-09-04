using System.Security.Cryptography;

namespace OpenReceive.TestkitNwc;

/// <summary>
/// Deterministic fake invoice store for unit tests: no Lightning node, invoices settle when a test
/// (or the control API) says so. Bolt11 strings are placeholders that embed the payment hash;
/// nothing in the testkit ever parses them.
/// </summary>
public sealed class InMemoryWalletBackend : IWalletBackend
{
    private readonly object _gate = new();
    private readonly List<WalletInvoice> _invoices = []; // insertion order

    public InMemoryWalletBackend(string network = "regtest") => Network = network;

    public string Network { get; }

    /// <summary>Unix-seconds clock; inject a fake to control created_at/expires_at/settled_at.</summary>
    public Func<long> Clock { get; set; } = static () => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    public event Action<WalletInvoice>? InvoiceSettled;

    public Task<WalletInvoice> MakeInvoiceAsync(long amountMsats, string? description, string? descriptionHash,
        int? expirySeconds, CancellationToken cancellationToken)
    {
        var preimage = RandomNumberGenerator.GetBytes(32);
        var hash = Convert.ToHexStringLower(SHA256.HashData(preimage));
        var now = Clock();
        var invoice = new WalletInvoice
        {
            PaymentHash = hash,
            Bolt11 = PlaceholderBolt11(Network, amountMsats, hash),
            AmountMsats = amountMsats,
            Description = description,
            DescriptionHash = descriptionHash,
            Preimage = Convert.ToHexStringLower(preimage),
            CreatedAt = now,
            ExpiresAt = now + (expirySeconds ?? 3600),
            State = InvoiceState.Pending,
        };
        Seed(invoice);
        return Task.FromResult(invoice);
    }

    public Task<WalletInvoice?> LookupAsync(string? paymentHash, string? bolt11, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            var found = _invoices.FirstOrDefault(i =>
                (paymentHash is not null && string.Equals(i.PaymentHash, paymentHash, StringComparison.OrdinalIgnoreCase)) ||
                (bolt11 is not null && string.Equals(i.Bolt11, bolt11, StringComparison.OrdinalIgnoreCase)));
            return Task.FromResult(found is null ? null : WithLazyExpiry(found));
        }
    }

    public Task<IReadOnlyList<WalletInvoice>> ListIncomingAsync(long? from, long? until, bool unpaid,
        CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            IReadOnlyList<WalletInvoice> rows = _invoices
                .Select((invoice, index) => (invoice: WithLazyExpiry(invoice), index))
                .Where(x => unpaid || x.invoice.IsSettled)
                .Where(x => from is null || x.invoice.CreatedAt >= from)
                .Where(x => until is null || x.invoice.CreatedAt <= until)
                .OrderByDescending(x => x.invoice.CreatedAt)
                .ThenByDescending(x => x.index)
                .Select(x => x.invoice)
                .ToList();
            return Task.FromResult(rows);
        }
    }

    public Task<long> BalanceMsatsAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
            return Task.FromResult(_invoices.Where(i => i.IsSettled).Sum(i => i.AmountMsats));
    }

    /// <summary>Add (or replace, by payment hash) an invoice as-is.</summary>
    public void Seed(WalletInvoice invoice)
    {
        lock (_gate)
        {
            _invoices.RemoveAll(i => i.PaymentHash == invoice.PaymentHash);
            _invoices.Add(invoice);
        }
    }

    /// <summary>Mark an invoice paid now and raise <see cref="InvoiceSettled"/>. Idempotent.</summary>
    public Task SettleAsync(string paymentHash)
    {
        var settled = Replace(paymentHash, current => current.IsSettled
            ? null
            : current with { State = InvoiceState.Settled, SettledAt = Clock() });
        if (settled is not null)
            InvoiceSettled?.Invoke(settled);
        return Task.CompletedTask;
    }

    public Task ExpireAsync(string paymentHash)
    {
        Replace(paymentHash, current => current.IsSettled ? null : current with { State = InvoiceState.Expired });
        return Task.CompletedTask;
    }

    private WalletInvoice? Replace(string paymentHash, Func<WalletInvoice, WalletInvoice?> update)
    {
        lock (_gate)
        {
            var index = _invoices.FindIndex(i => i.PaymentHash == paymentHash);
            if (index < 0)
                throw new KeyNotFoundException($"Unknown payment hash {paymentHash}");
            var next = update(_invoices[index]);
            if (next is not null)
                _invoices[index] = next;
            return next;
        }
    }

    /// <summary>A pending invoice past its expiry reads as expired without a separate sweep.</summary>
    private WalletInvoice WithLazyExpiry(WalletInvoice invoice) =>
        invoice.State == InvoiceState.Pending && Clock() > invoice.ExpiresAt
            ? invoice with { State = InvoiceState.Expired }
            : invoice;

    private static string PlaceholderBolt11(string network, long amountMsats, string paymentHash)
    {
        var hrp = network switch
        {
            "mainnet" => "lnbc",
            "testnet" => "lntb",
            "signet" => "lntbs",
            _ => "lnbcrt",
        };
        // 1 msat = 10 pico-BTC; "p" is the BOLT11 pico multiplier. Looks like a bolt11, never parses as one.
        return $"{hrp}{amountMsats * 10}p1{paymentHash}testkit";
    }
}
