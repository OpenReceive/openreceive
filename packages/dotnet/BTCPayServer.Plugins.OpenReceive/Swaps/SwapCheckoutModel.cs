#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text.Json.Serialization;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Generated;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// The payer-facing snapshot of one swap row: everything the checkout component needs
/// and nothing server-only (never the provider token). Field names are snake_case on
/// the wire like the OpenReceive HTTP contract.
/// </summary>
public sealed class SwapCheckoutModel
{
    [JsonPropertyName("swap_id")] public required string SwapId { get; init; }
    [JsonPropertyName("invoice_id")] public required string InvoiceId { get; init; }
    [JsonPropertyName("provider")] public required string Provider { get; init; }
    [JsonPropertyName("pay_in_asset")] public required string PayInAsset { get; init; }
    [JsonPropertyName("asset_label")] public required string AssetLabel { get; init; }
    [JsonPropertyName("network_label")] public required string NetworkLabel { get; init; }
    [JsonPropertyName("state")] public required string State { get; init; }
    [JsonPropertyName("phase")] public required string Phase { get; init; }
    [JsonPropertyName("terminal")] public required bool Terminal { get; init; }
    [JsonPropertyName("label")] public required string Label { get; init; }
    [JsonPropertyName("detail")] public required string Detail { get; init; }
    [JsonPropertyName("deposit_address")] public required string DepositAddress { get; init; }
    [JsonPropertyName("deposit_memo")] public string? DepositMemo { get; init; }
    [JsonPropertyName("deposit_amount")] public required string DepositAmount { get; init; }
    [JsonPropertyName("deposit_uri")] public required string DepositUri { get; init; }
    [JsonPropertyName("provider_expires_at")] public required long ProviderExpiresAt { get; init; }
    [JsonPropertyName("expires_in_seconds")] public required long ExpiresInSeconds { get; init; }
    [JsonPropertyName("invoice_expires_at")] public long? InvoiceExpiresAt { get; init; }
    [JsonPropertyName("invoice_status")] public string? InvoiceStatus { get; init; }
    [JsonPropertyName("wallet_settled")] public required bool WalletSettled { get; init; }
    [JsonPropertyName("deposit_risk")] public required string DepositRisk { get; init; }
    [JsonPropertyName("network_warning_title")] public required string NetworkWarningTitle { get; init; }
    [JsonPropertyName("network_warning")] public required string NetworkWarning { get; init; }
    [JsonPropertyName("fee")] public SwapFee? Fee { get; init; }
    [JsonPropertyName("refund_reason")] public string? RefundReason { get; init; }
    [JsonPropertyName("refund_address")] public string? RefundAddress { get; init; }
    [JsonPropertyName("refund_tx_id")] public string? RefundTxId { get; init; }
    [JsonPropertyName("refund_amount")] public string? RefundAmount { get; init; }
    [JsonPropertyName("deposit_tx_id")] public string? DepositTxId { get; init; }
    [JsonPropertyName("deposit_received_amount")] public string? DepositReceivedAmount { get; init; }
    [JsonPropertyName("payout_tx_id")] public string? PayoutTxId { get; init; }
    [JsonPropertyName("attention_reason")] public string? AttentionReason { get; init; }
    [JsonPropertyName("plugin_reason")] public string? PluginReason { get; init; }
    [JsonPropertyName("provider_order_id")] public required string ProviderOrderId { get; init; }

    public static SwapCheckoutModel From(OpenReceiveSwap row, long now, long? invoiceExpiresAt, string? invoiceStatus)
    {
        var asset = OpenReceiveTables.SwapAssetInfo[row.PayInAsset];
        var copy = SwapStateCopy.For(row.State);
        var risk = DepositRiskFor(row.PayInAsset);
        var emphasis = $"{row.DepositAmount} {asset.Label} on the {asset.NetworkLabel} network";
        var doubleSpend = $"Pay with one method only — if you already sent {asset.Label}, do not also pay the Lightning invoice.";
        var expiresAt = invoiceExpiresAt is { } inv ? Math.Min(row.ProviderExpiresAt, inv) : row.ProviderExpiresAt;
        return new SwapCheckoutModel
        {
            SwapId = row.Id,
            InvoiceId = row.InvoiceId,
            Provider = row.Provider,
            PayInAsset = row.PayInAsset,
            AssetLabel = asset.Label,
            NetworkLabel = asset.NetworkLabel,
            State = row.State,
            Phase = copy.Phase,
            Terminal = copy.Terminal,
            Label = copy.Label,
            Detail = copy.Detail,
            DepositAddress = row.DepositAddress,
            DepositMemo = row.DepositMemo,
            DepositAmount = row.DepositAmount,
            DepositUri = DepositUriFor(row.PayInAsset, row.DepositAddress, row.DepositAmount),
            ProviderExpiresAt = row.ProviderExpiresAt,
            ExpiresInSeconds = Math.Max(0, expiresAt - now),
            InvoiceExpiresAt = invoiceExpiresAt,
            InvoiceStatus = invoiceStatus,
            WalletSettled = row.WalletSettledAt is not null,
            DepositRisk = risk,
            NetworkWarningTitle = risk == "pinned" ? "Send exactly this amount" : "Wrong currency or network = lost funds",
            NetworkWarning = risk == "pinned"
                ? $"Send exactly {emphasis}. {doubleSpend}"
                : $"Be sure you are sending exactly {emphasis}. If you send the wrong currency or send on the wrong network, your funds will be lost! {doubleSpend}",
            Fee = row.FeeCurrency is not null && row.PayInFiat is not null && row.PayoutFiat is not null
                ? new SwapFee(row.FeeCurrency, row.PayInFiat, row.PayoutFiat)
                : null,
            RefundReason = row.RefundReason,
            RefundAddress = row.RefundAddress,
            RefundTxId = row.RefundTxId,
            RefundAmount = row.RefundAmount,
            DepositTxId = row.DepositTxId,
            DepositReceivedAmount = row.DepositReceivedAmount,
            PayoutTxId = row.PayoutTxId,
            AttentionReason = row.AttentionReason,
            PluginReason = row.PluginReason,
            ProviderOrderId = row.ProviderOrderId,
        };
    }

    /// <summary>
    /// checkout-ux.md's deposit risk: EVM addresses are chain-ambiguous, a token on a
    /// pinned chain is asset-ambiguous, and a chain's native coin (SOL_SOL) is pinned.
    /// </summary>
    public static string DepositRiskFor(string payInAsset)
    {
        var network = SwapAddress.NetworkForPayInAsset(payInAsset);
        if (network is null || network == "ETH") return "chain_ambiguous";
        var symbol = payInAsset[..payInAsset.LastIndexOf('_')];
        return SwapAddress.NetworkForPayInAsset($"{symbol}_{symbol}") == network ? "pinned" : "asset_only";
    }

    /// <summary>Native rails put the amount in the QR; token rails encode the address only (wallets ignore token amounts).</summary>
    public static string DepositUriFor(string payInAsset, string address, string amount)
    {
        return payInAsset switch
        {
            "SOL_SOL" => $"solana:{address}?amount={amount}",
            "ETH_ETH" => $"ethereum:{address}?value={ToWei(amount)}",
            _ => address,
        };
    }

    private static string ToWei(string amount)
    {
        var parts = amount.Split('.');
        var whole = BigInteger.Parse(parts[0], CultureInfo.InvariantCulture);
        var fraction = parts.Length > 1 ? parts[1] : string.Empty;
        fraction = fraction.Length > 18 ? fraction[..18] : fraction.PadRight(18, '0');
        return (whole * BigInteger.Pow(10, 18) + BigInteger.Parse(fraction, CultureInfo.InvariantCulture)).ToString(CultureInfo.InvariantCulture);
    }
}

/// <summary>
/// One pill on the checkout: an asset and whether it can be paid with right now.
/// <see cref="Limit"/> is the shopper-facing bound behind an amount refusal ("at least
/// 9.12 USD"), in the invoice's currency at the invoice's own rate, like the JS checkout's
/// "your cart total must be at least $2.43".
/// </summary>
public sealed record SwapAssetOffer(string PayInAsset, string AssetLabel, string NetworkLabel, bool Available, string? Reason, string? Message, SwapOfferLimit? Limit = null);

/// <summary>An amount bound behind a refusal: "at least" / "at most", the figure, and its unit (the invoice currency, or the pay asset).</summary>
public sealed record SwapOfferLimit(string Word, decimal Amount, string Unit)
{
    public string AmountText => Amount.ToString(Amount == decimal.Truncate(Amount) && Unit.Length > 3 ? "0.##" : "0.00", System.Globalization.CultureInfo.InvariantCulture);
    public override string ToString() => $"{Word} {AmountText} {Unit}";
}

/// <summary>Whether swaps are offered for one invoice, and why not.</summary>
public sealed record SwapAvailability(
    bool Offered,
    string? Reason,
    IReadOnlyList<SwapAssetOffer> Assets,
    string? Bolt11,
    string? PaymentHash,
    long InvoiceAmountMsats,
    int MinimumInvoiceSeconds)
{
    public static SwapAvailability NotOffered(string reason) => new(false, reason, Array.Empty<SwapAssetOffer>(), null, null, 0, 0);
}

/// <summary>A payer-facing refusal with the HTTP status the API answers.</summary>
public sealed class SwapRequestException : Exception
{
    public int Status { get; }
    public string Code { get; }

    public SwapRequestException(int status, string code, string message) : base(message)
    {
        Status = status;
        Code = code;
    }
}
