namespace OpenReceive.TestkitNwc;

/// <summary>
/// The invoice store behind the NIP-47 wallet service. Incoming (receive) side only: the testkit
/// never pays anything.
/// </summary>
public interface IWalletBackend
{
    /// <summary>NIP-47 network name: mainnet, testnet, signet or regtest.</summary>
    string Network { get; }

    Task<WalletInvoice> MakeInvoiceAsync(long amountMsats, string? description, string? descriptionHash,
        int? expirySeconds, CancellationToken cancellationToken);

    /// <summary>Find by payment hash or by bolt11; null when unknown.</summary>
    Task<WalletInvoice?> LookupAsync(string? paymentHash, string? bolt11, CancellationToken cancellationToken);

    /// <summary>
    /// Incoming invoices, newest first, filtered by creation time (inclusive unix seconds).
    /// NIP-47 semantics: <paramref name="unpaid"/> false returns settled invoices only;
    /// true also includes the pending and expired ones.
    /// </summary>
    Task<IReadOnlyList<WalletInvoice>> ListIncomingAsync(long? from, long? until, bool unpaid,
        CancellationToken cancellationToken);

    Task<long> BalanceMsatsAsync(CancellationToken cancellationToken);

    /// <summary>Raised once per invoice when it settles.</summary>
    event Action<WalletInvoice>? InvoiceSettled;
}
