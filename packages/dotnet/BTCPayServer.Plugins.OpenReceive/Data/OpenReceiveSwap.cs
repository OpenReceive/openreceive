#nullable enable
using System;
using System.Security.Cryptography;
using System.Text;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Data;

/// <summary>
/// One provider swap order aimed at one BTCPay invoice's Lightning BOLT11. The table
/// the plugin owns inside BTCPay's database (schema BTCPayServer.Plugins.OpenReceive).
/// <see cref="ProviderToken"/> is server-only: never serialized toward a browser or a log.
/// Timestamps are unix seconds.
/// </summary>
public sealed class OpenReceiveSwap
{
    public string Id { get; set; } = NewId();
    public string StoreId { get; set; } = string.Empty;
    public string InvoiceId { get; set; } = string.Empty;
    /// <summary>64 lowercase hex: the BOLT11 the provider pays.</summary>
    public string PaymentHash { get; set; } = string.Empty;
    public string Bolt11 { get; set; } = string.Empty;
    public long InvoiceAmountMsats { get; set; }
    public string Provider { get; set; } = string.Empty;
    public string ProviderOrderId { get; set; } = string.Empty;
    public string ProviderToken { get; set; } = string.Empty;
    public string PayInAsset { get; set; } = string.Empty;
    public string DepositAddress { get; set; } = string.Empty;
    public string? DepositMemo { get; set; }
    /// <summary>Decimal string in the pay-in asset.</summary>
    public string DepositAmount { get; set; } = string.Empty;
    public long ProviderExpiresAt { get; set; }
    /// <summary>One of OpenReceiveTables.SwapProviderStates.</summary>
    public string State { get; set; } = "creating_provider_order";
    public string? StateReason { get; set; }
    public bool Attention { get; set; }
    public string? AttentionReason { get; set; }
    /// <summary>Plugin-only annotation (e.g. invoice_reminted_after_partial_payment); never a shared attention reason.</summary>
    public string? PluginReason { get; set; }
    public string? RefundReason { get; set; }
    public string? RefundAddress { get; set; }
    public string? RefundTxId { get; set; }
    public string? DepositTxId { get; set; }
    public string? PayoutTxId { get; set; }
    public string? DepositReceivedAmount { get; set; }
    public string? RefundAmount { get; set; }
    public bool EmergencyRepeat { get; set; }
    public string? FeeCurrency { get; set; }
    public string? PayInFiat { get; set; }
    public string? PayoutFiat { get; set; }
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    /// <summary>When <see cref="State"/> last changed; drives the completed-without-settlement timer.</summary>
    public long StateChangedAt { get; set; }
    public long? LastPolledAt { get; set; }
    /// <summary>Set when BTCPay recorded the Lightning payment for this row's hash.</summary>
    public long? WalletSettledAt { get; set; }

    public bool IsTerminal => OpenReceiveTables.SwapStates.TryGetValue(State, out var info) && info.Terminal;

    /// <summary>26-character, time-ordered, Crockford base32 (ULID-shaped) id.</summary>
    public static string NewId()
    {
        const string alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        var time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Span<byte> random = stackalloc byte[10];
        RandomNumberGenerator.Fill(random);
        var builder = new StringBuilder(26);
        for (var i = 9; i >= 0; i--)
        {
            builder.Append(alphabet[(int)((time >> (i * 5)) & 31)]);
        }
        // 10 random bytes = 80 bits = 16 base32 characters.
        var acc = 0;
        var bits = 0;
        foreach (var b in random)
        {
            acc = (acc << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                bits -= 5;
                builder.Append(alphabet[(acc >> bits) & 31]);
            }
        }
        return builder.ToString()[..26];
    }
}
