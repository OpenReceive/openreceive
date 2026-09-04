#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Abstractions.Constants;
using BTCPayServer.Client;
using BTCPayServer.Data;
using BTCPayServer.Plugins.OpenReceive.Generated;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using BTCPayServer.Plugins.OpenReceive.Settings;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using BTCPayServer.Services.Stores;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BTCPayServer.Plugins.OpenReceive.Controllers;

/// <summary>
/// Greenfield-style API for the plugin's settings, so a store can be configured with an
/// API key (and so the end-to-end tests drive the same code the setup page does).
/// </summary>
[ApiController]
[Authorize(AuthenticationSchemes = AuthenticationSchemes.Greenfield)]
[Route("api/v1/stores/{storeId}/openreceive")]
public sealed class GreenfieldOpenReceiveController : ControllerBase
{
    private readonly OpenReceiveSettingsService _settings;
    private readonly SwapProviderPool _providers;
    private readonly SwapService _swaps;
    private readonly StoreRepository _stores;

    public GreenfieldOpenReceiveController(OpenReceiveSettingsService settings, SwapProviderPool providers, SwapService swaps, StoreRepository stores)
    {
        _settings = settings;
        _providers = providers;
        _swaps = swaps;
        _stores = stores;
    }

    public sealed class SettingsResponse
    {
        public bool LightningNodeIsOpenReceive { get; set; }
        public string? LightningNode { get; set; }
        public bool AllowSpendCapableWallet { get; set; }
        public bool SwapsEnabled { get; set; }
        public bool LscPrimaryConfigured { get; set; }
        public bool LscBackupConfigured { get; set; }
        public List<string> EnabledPayInAssets { get; set; } = new();
        public int InvoiceExpirationMinutes { get; set; }
        public OpenReceiveStoreSettings.PreflightSnapshot? LastPreflight { get; set; }
    }

    public sealed class UpdateSettingsRequest
    {
        /// <summary>Receive-only NWC code; when set, becomes the store's Lightning node (validated).</summary>
        public string? NwcUri { get; set; }
        /// <summary>With no <see cref="NwcUri"/>, re-saves the store's current connection with this override (re-validated).</summary>
        public bool? AllowSpendCapableWallet { get; set; }
        public string? LscPrimary { get; set; }
        public string? LscBackup { get; set; }
        /// <summary>Optional: when omitted, swaps follow the primary code (a saved code means on, none means off).</summary>
        public bool? SwapsEnabled { get; set; }
        public List<string>? EnabledPayInAssets { get; set; }
    }

    [HttpGet("settings")]
    [Authorize(Policy = Policies.CanViewStoreSettings, AuthenticationSchemes = AuthenticationSchemes.Greenfield)]
    public async Task<IActionResult> GetSettings(string storeId)
    {
        var store = await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        return Ok(await BuildAsync(store));
    }

    [HttpPut("settings")]
    [Authorize(Policy = Policies.CanModifyStoreSettings, AuthenticationSchemes = AuthenticationSchemes.Greenfield)]
    public async Task<IActionResult> UpdateSettings(string storeId, [FromBody] UpdateSettingsRequest request, CancellationToken cancellationToken)
    {
        var store = await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        // Everything is checked before anything is written: a refused field never leaves a
        // half-applied store (a wallet saved, a provider not).
        var settings = await _settings.GetAsync(store.Id);
        var lscPrimary = settings.LscPrimary;
        var lscBackup = settings.LscBackup;
        foreach (var (uri, apply) in new (string?, Action<string?>)[] { (request.LscPrimary, v => lscPrimary = v), (request.LscBackup, v => lscBackup = v) })
        {
            if (uri is null) continue;
            if (!Validate(uri, out var connection, out var lscError)) return UnprocessableEntity(new { code = "invalid_lsc_uri", message = lscError });
            if (connection is not null && await _settings.LocalEndpointErrorAsync(new[] { connection.Host }, User) is { } localError)
                return UnprocessableEntity(new { code = "endpoint_not_allowed", message = localError });
            apply(Trimmed(uri));
        }
        List<string>? assets = null;
        if (request.EnabledPayInAssets is not null)
        {
            var unknown = request.EnabledPayInAssets.Where(asset => !OpenReceiveTables.SwapPayInAssets.Contains(asset)).ToList();
            if (unknown.Count > 0)
                return UnprocessableEntity(new { code = "invalid_pay_in_asset", message = $"Unknown pay-in asset(s): {string.Join(", ", unknown)}. Known: {string.Join(", ", OpenReceiveTables.SwapPayInAssets)}. An empty list offers every asset." });
            assets = request.EnabledPayInAssets.Distinct(StringComparer.Ordinal).ToList();
        }
        var current = _settings.GetConnection(store);
        var nwc = string.IsNullOrWhiteSpace(request.NwcUri)
            ? request.AllowSpendCapableWallet is null ? null : current?.NwcUri
            : request.NwcUri;
        var walletAfter = current is not null;
        if (nwc is not null)
        {
            var error = await _settings.UseAsLightningNodeAsync(store, nwc, request.AllowSpendCapableWallet ?? current?.AllowSpendCapableWallet ?? false, User);
            if (error is not null) return UnprocessableEntity(new { code = "wallet_refused", message = error });
            store = await _stores.FindStore(storeId) ?? store;
            walletAfter = true;
        }
        var swapsEnabled = request.SwapsEnabled ?? (request.LscPrimary is null ? (bool?)null : lscPrimary is not null);
        if (swapsEnabled is { } enabled)
        {
            if (enabled && !walletAfter)
                return UnprocessableEntity(new { code = "wallet_required", message = "Swaps settle into your OpenReceive wallet. Connect a receive-only NWC code first." });
            if (enabled && string.IsNullOrWhiteSpace(lscPrimary))
                return UnprocessableEntity(new { code = "lsc_required", message = "Swaps need a Lightning Swap Connect code." });
            settings.SwapsEnabled = enabled;
        }
        settings.LscPrimary = lscPrimary;
        settings.LscBackup = lscBackup;
        if (assets is not null) settings.EnabledPayInAssets = assets;
        await _settings.SetAsync(store.Id, settings);
        if (settings.SwapsEnabled) await _settings.EnsureInvoiceExpirationAsync(store, SwapService.RecommendedInvoiceExpiration);
        return Ok(await BuildAsync(await _stores.FindStore(storeId) ?? store));
    }

    [HttpPost("wallet/test")]
    [Authorize(Policy = Policies.CanModifyStoreSettings, AuthenticationSchemes = AuthenticationSchemes.Greenfield)]
    public async Task<IActionResult> TestWallet(string storeId, [FromBody] UpdateSettingsRequest request, CancellationToken cancellationToken)
    {
        var store = await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        var current = _settings.GetConnection(store);
        var nwc = string.IsNullOrWhiteSpace(request.NwcUri) ? current?.NwcUri : request.NwcUri;
        if (nwc is null) return UnprocessableEntity(new { code = "nwc_required", message = "nwcUri is required." });
        // The saved override applies to a test of the saved code, exactly as it does on save.
        var client = _settings.CreateClient(nwc, request.AllowSpendCapableWallet ?? current?.AllowSpendCapableWallet ?? false, out var error);
        if (client is null) return UnprocessableEntity(new { code = "invalid_nwc_uri", message = error });
        var report = await client.PreflightAsync(cancellationToken);
        var settings = await _settings.GetAsync(store.Id);
        settings.LastPreflight = OpenReceiveSettingsService.Snapshot(report);
        await _settings.SetAsync(store.Id, settings);
        return Ok(settings.LastPreflight);
    }

    [HttpGet("swaps")]
    [Authorize(Policy = Policies.CanViewStoreSettings, AuthenticationSchemes = AuthenticationSchemes.Greenfield)]
    public async Task<IActionResult> ListSwaps(string storeId, CancellationToken cancellationToken, int limit = 50)
    {
        var store = await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        var rows = await _swaps.ForStoreAsync(store.Id, Math.Clamp(limit, 1, 500), cancellationToken);
        return Ok(rows.Select(Public));
    }

    [HttpGet("invoices/{invoiceId}/swaps")]
    [Authorize(Policy = Policies.CanViewStoreSettings, AuthenticationSchemes = AuthenticationSchemes.Greenfield)]
    public async Task<IActionResult> InvoiceSwaps(string storeId, string invoiceId, CancellationToken cancellationToken)
    {
        var store = await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        var rows = await _swaps.ForInvoiceAsync(invoiceId, cancellationToken);
        return Ok(rows.Where(r => r.StoreId == store.Id).Select(Public));
    }

    private static object Public(Data.OpenReceiveSwap row) => new
    {
        id = row.Id,
        invoiceId = row.InvoiceId,
        paymentHash = row.PaymentHash,
        provider = row.Provider,
        providerOrderId = row.ProviderOrderId,
        payInAsset = row.PayInAsset,
        depositAddress = row.DepositAddress,
        depositAmount = row.DepositAmount,
        providerExpiresAt = row.ProviderExpiresAt,
        state = row.State,
        stateReason = row.StateReason,
        attention = row.Attention,
        attentionReason = row.AttentionReason,
        pluginReason = row.PluginReason,
        refundReason = row.RefundReason,
        refundAddress = row.RefundAddress,
        refundTxId = row.RefundTxId,
        depositTxId = row.DepositTxId,
        payoutTxId = row.PayoutTxId,
        walletSettledAt = row.WalletSettledAt,
        createdAt = row.CreatedAt,
        updatedAt = row.UpdatedAt,
    };

    private static bool Validate(string uri, out LscConnection? connection, out string? error)
    {
        if (string.IsNullOrWhiteSpace(uri)) { connection = null; error = null; return true; }
        return LscUri.TryParse(uri.Trim(), out connection, out error);
    }

    private static string? Trimmed(string uri) => string.IsNullOrWhiteSpace(uri) ? null : uri.Trim();

    private async Task<SettingsResponse> BuildAsync(StoreData store)
    {
        var settings = await _settings.GetAsync(store.Id);
        var connection = _settings.GetConnection(store);
        return new SettingsResponse
        {
            LightningNodeIsOpenReceive = connection is not null,
            LightningNode = _settings.DescribeLightningNode(store),
            AllowSpendCapableWallet = connection?.AllowSpendCapableWallet ?? false,
            SwapsEnabled = settings.SwapsEnabled,
            LscPrimaryConfigured = !string.IsNullOrEmpty(settings.LscPrimary),
            LscBackupConfigured = !string.IsNullOrEmpty(settings.LscBackup),
            EnabledPayInAssets = settings.EnabledPayInAssets,
            InvoiceExpirationMinutes = (int)store.GetStoreBlob().InvoiceExpiration.TotalMinutes,
            LastPreflight = settings.LastPreflight,
        };
    }
}
