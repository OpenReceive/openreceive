#nullable enable
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>Indicative quote for paying one invoice with one pay-in asset.</summary>
public sealed record SwapQuote
{
    public string? PayAmount { get; init; }
    public string? MinimumPayAmount { get; init; }
    public string? MaximumPayAmount { get; init; }
    public long? MinimumInvoiceAmountMsats { get; init; }
    public long? MaximumInvoiceAmountMsats { get; init; }
    public required string PayAsset { get; init; }
    public required bool Available { get; init; }
    /// <summary>One of OpenReceiveTables.SwapAvailabilityReasons when unavailable.</summary>
    public string? UnavailableReason { get; init; }
    public string? UnavailableMessage { get; init; }
    public required string Provider { get; init; }
}

public sealed record SwapProviderAsset
{
    public required string PayAsset { get; init; }
    public bool? Available { get; init; }
    public string? UnavailableReason { get; init; }
    public string? UnavailableMessage { get; init; }
    public string? MinimumPayAmount { get; init; }
    public string? MaximumPayAmount { get; init; }
    public long? MinimumInvoiceAmountMsats { get; init; }
    public long? MaximumInvoiceAmountMsats { get; init; }
}

/// <summary>Fiat equivalents of both sides of the exchange; the gap is the fee the payer absorbs.</summary>
public sealed record SwapFee(string Currency, string PayInFiat, string PayoutFiat);

/// <summary>
/// One provider order as OpenReceive persists it. <see cref="ProviderToken"/> is
/// server-only and must never be serialized toward a browser or a log line.
/// </summary>
public sealed record SwapOrder
{
    public required string Provider { get; init; }
    public required string ProviderOrderId { get; init; }
    public required string ProviderToken { get; init; }
    public required string PayInAsset { get; init; }
    public required string DepositAddress { get; init; }
    public string? DepositMemo { get; init; }
    public required string DepositAmount { get; init; }
    public required long ExpiresAt { get; init; }
    /// <summary>One of OpenReceiveTables.SwapProviderStates.</summary>
    public required string State { get; init; }
    public string? DepositTxId { get; init; }
    public string? PayoutTxId { get; init; }
    public string? RefundTxId { get; init; }
    public bool? Attention { get; init; }
    public string? AttentionReason { get; init; }
    public string? RefundReason { get; init; }
    public string? DepositReceivedAmount { get; init; }
    public string? RefundAmount { get; init; }
    public bool? EmergencyRepeat { get; init; }
    public SwapFee? Fee { get; init; }
}

public sealed record SwapQuoteInput(string PayInAsset, long InvoiceAmountMsats);
public sealed record CreateSwapInput(string PayInAsset, string Bolt11, long InvoiceAmountMsats);

/// <summary>Process-local request weight guard the service attaches to a provider.</summary>
public interface ISwapWeightBudget
{
    void Reserve(string path);
    void MarkRateLimited();
}

public sealed record SwapProviderApiRequestLog(string Provider, string Path, string? BodyJson);
public sealed record SwapProviderApiResponseLog(string Provider, string Path, int Status, bool Ok, string? Code, string? Message);

public interface ISwapProvider
{
    string Name { get; }
    void AttachSwapCache(TransientSwapCache cache);
    void AttachWeightBudget(ISwapWeightBudget budget);
    void AttachApiRequestLogger(System.Action<SwapProviderApiRequestLog> log);
    void AttachApiResponseLogger(System.Action<SwapProviderApiResponseLog> log);
    /// <summary>Seconds the Lightning invoice must stay payable for a swap through this provider.</summary>
    int InvoiceExpirySeconds { get; }
    Task<IReadOnlySet<string>> SupportedPayInAssetsAsync(CancellationToken cancellationToken);
    Task<IReadOnlyList<SwapProviderAsset>> PayInAssetCatalogAsync(CancellationToken cancellationToken);
    Task<SwapQuote> QuoteAsync(SwapQuoteInput input, CancellationToken cancellationToken);
    Task<SwapOrder> CreateSwapAsync(CreateSwapInput input, CancellationToken cancellationToken);
    Task<SwapOrder> GetStatusAsync(SwapOrder order, CancellationToken cancellationToken);
    Task RequestRefundAsync(SwapOrder order, string refundAddress, CancellationToken cancellationToken);
}
