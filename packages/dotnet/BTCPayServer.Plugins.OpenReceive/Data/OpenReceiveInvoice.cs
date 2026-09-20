#nullable enable

namespace BTCPayServer.Plugins.OpenReceive.Data;

/// <summary>
/// One Lightning invoice this plugin minted, committed before BTCPay shows it to a payer:
/// the plugin's counterpart of an <c>openreceive_payments</c> row. It holds what only the
/// plugin knows and a restart would otherwise lose — the exact NIP-47 creation and expiry
/// times that bound the wallet walk and drive the close rule. Status, settlement and
/// fulfillment are BTCPay's own invoice and payment rows, and swap state is
/// <see cref="OpenReceiveSwap"/>: neither is copied here. Timestamps are unix seconds.
/// </summary>
public sealed class OpenReceiveInvoice
{
    /// <summary>64 lowercase hex: BTCPay's id for the Lightning invoice.</summary>
    public string PaymentHash { get; set; } = string.Empty;
    public string Bolt11 { get; set; } = string.Empty;
    public long AmountMsats { get; set; }
    public long CreatedAt { get; set; }
    public long ExpiresAt { get; set; }
}
