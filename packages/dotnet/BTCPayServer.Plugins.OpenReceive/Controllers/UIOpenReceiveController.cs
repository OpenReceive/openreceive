#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Abstractions.Constants;
using BTCPayServer.Abstractions.Extensions;
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
/// The merchant's one page (wallet + swaps) and the doctor. The user never visits
/// BTCPay's Lightning node screen: saving here writes the canonical connection string
/// through the Lightning handler's own validation path.
/// </summary>
[Authorize(AuthenticationSchemes = AuthenticationSchemes.Cookie)]
[Authorize(Policy = Policies.CanModifyStoreSettings, AuthenticationSchemes = AuthenticationSchemes.Cookie)]
[Route("plugins/{storeId}/openreceive")]
public sealed class UIOpenReceiveController : Controller
{
    private readonly OpenReceiveSettingsService _settings;
    private readonly SwapProviderPool _providers;
    private readonly SwapService _swaps;
    private readonly StoreRepository _stores;

    public UIOpenReceiveController(OpenReceiveSettingsService settings, SwapProviderPool providers, SwapService swaps, StoreRepository stores)
    {
        _settings = settings;
        _providers = providers;
        _swaps = swaps;
        _stores = stores;
    }

    private StoreData? CurrentStore => HttpContext.GetStoreData();

    [HttpGet("")]
    public async Task<IActionResult> Setup(string storeId, CancellationToken cancellationToken)
    {
        var store = CurrentStore ?? await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        return View(await BuildSetupAsync(store, new SetupViewModel(), cancellationToken));
    }

    [HttpPost("")]
    public async Task<IActionResult> Setup(string storeId, SetupViewModel vm, string command, CancellationToken cancellationToken)
    {
        var store = CurrentStore ?? await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        switch (command)
        {
            case "test-wallet":
                await TestWalletAsync(vm, store, cancellationToken);
                break;
            case "health-check":
                vm.HealthCheck = await BuildDoctorAsync(store, cancellationToken); // the probes carry the preflight; no separate card
                break;
            case "use-wallet":
                if (await UseWalletAsync(vm, store, cancellationToken))
                {
                    TempData[WellKnownTempData.SuccessMessage] = "This store now receives Lightning payments into your NWC wallet. Invoices are minted there; the saved code is never shown again.";
                    return RedirectToAction(nameof(Setup), new { storeId });
                }
                break;
            case "test-provider":
                await TestProviderAsync(vm, store, cancellationToken);
                break;
            case "save-swaps":
                if (await SaveSwapsAsync(vm, store, cancellationToken) is { } swapsOn)
                {
                    TempData[WellKnownTempData.SuccessMessage] = swapsOn ? "Swap settings saved. Payers can now pay with USDT, USDC, ETH or SOL." : "Swap settings saved. Swaps are off until a provider code is saved.";
                    return RedirectToAction(nameof(Setup), new { storeId });
                }
                break;
        }
        return View(await BuildSetupAsync(store, vm, cancellationToken));
    }

    [HttpGet("doctor")]
    public async Task<IActionResult> Doctor(string storeId, CancellationToken cancellationToken)
    {
        var store = CurrentStore ?? await _stores.FindStore(storeId);
        if (store is null) return NotFound();
        return View(await BuildDoctorAsync(store, cancellationToken));
    }

    /// <summary>The read-only probes, run now: the setup page shows them in place, the doctor page on its own.</summary>
    private async Task<DoctorViewModel> BuildDoctorAsync(StoreData store, CancellationToken cancellationToken)
    {
        var vm = new DoctorViewModel { StoreId = store.Id };
        var settings = await _settings.GetAsync(store.Id);
        var connection = _settings.GetConnection(store);
        vm.LightningNode = _settings.DescribeLightningNode(store);
        vm.Probes.Add(Probe("Lightning node is an OpenReceive connection", connection is not null,
            connection is null ? "The store's Lightning node is not a receive-only NWC connection." : "BTCPay mints invoices in your NWC wallet.",
            connection is null ? Url.Action(nameof(Setup), new { storeId = store.Id }) : null));
        if (connection is not null)
        {
            var client = _settings.CreateClient(store);
            var report = client is null ? null : await client.PreflightAsync(cancellationToken);
            vm.Preflight = report;
            vm.Probes.Add(Probe("Wallet preflight (now)", report?.Ok == true, report?.Ok == true
                ? $"Methods: {string.Join(", ", report.Summary!.Methods)}; encryption {report.Summary.Encryption}; relay round trip {report.RelayRoundTrip?.TotalMilliseconds:0} ms."
                : report?.Message ?? "Could not run the preflight.", null));
            vm.Probes.Add(Probe("Wallet pushes payment notifications", report?.Summary?.Notifications.Contains("payment_received") == true,
                report?.Summary?.Notifications.Contains("payment_received") == true
                    ? "payment_received notifications settle invoices instantly; the scan is the safety net."
                    : "No notifications: settlement relies on the periodic wallet scan (2–12 s).", null));
            var state = _settings.GetConnectionState(store);
            vm.Probes.Add(Probe("Last wallet scan", state?.Memo.RefreshedAt is not null,
                state?.Memo.RefreshedAt is { } at
                    ? $"{DateTimeOffset.FromUnixTimeSeconds(at):u}{(state.Memo.Complete ? string.Empty : " (walk was truncated: BTCPay keeps watching every hash)")}"
                    : "No scan yet in this process — the first invoice triggers one.", null));
            if (connection.AllowSpendCapableWallet)
            {
                vm.Probes.Add(Probe("Spend-capable override is ON", false, "This connection may be able to spend. Replace it with a receive-only code when you can.", Url.Action(nameof(Setup), new { storeId = store.Id })));
            }
        }
        var blob = store.GetStoreBlob();
        vm.Probes.Add(Probe("Top-up invoices are not supported on this backend", true, "Every invoice needs an amount; top-up (amountless) invoices fail with a clear message.", null));
        if (settings.SwapsEnabled)
        {
            var providers = await _providers.ProvidersAsync(store.Id, cancellationToken);
            vm.Probes.Add(Probe("Swap provider configured", providers.Count > 0, providers.Count > 0 ? string.Join(", ", providers.Select(p => p.Name)) : "No LSC URI saved.", Url.Action(nameof(Setup), new { storeId = store.Id })));
            foreach (var provider in providers)
            {
                try
                {
                    var catalog = await provider.PayInAssetCatalogAsync(cancellationToken);
                    var available = catalog.Where(c => c.Available != false).Select(c => c.PayAsset).ToList();
                    vm.Probes.Add(Probe($"Provider {provider.Name} reachable", true, $"Available assets: {(available.Count == 0 ? "none" : string.Join(", ", available))}", null));
                }
                catch (Exception e)
                {
                    vm.Probes.Add(Probe($"Provider {provider.Name} reachable", false, e.Message, null));
                }
            }
            vm.Probes.Add(Probe("Invoice expiration covers the provider window", blob.InvoiceExpiration >= SwapService.MinimumInvoiceExpiration,
                $"Store → Checkout → Invoice expiration is {blob.InvoiceExpiration.TotalMinutes:0} minutes; swaps need at least {SwapService.MinimumInvoiceExpiration.TotalMinutes:0} (60 recommended).",
                Url.Action(nameof(Setup), new { storeId = store.Id })));
            var attention = await _swaps.CountAttentionAsync(store.Id, cancellationToken);
            vm.Probes.Add(Probe("Swaps needing attention", attention == 0, attention == 0 ? "None." : $"{attention} swap(s) need a human: open the invoice pages to review them.", null));
        }
        vm.Probes.Add(Probe("Invoice expiration within the scan window", blob.InvoiceExpiration <= TimeSpan.FromHours(24),
            $"Invoice expiration is {blob.InvoiceExpiration.TotalHours:0.#} h; the wallet scan covers 24 h.", null));
        vm.RecentSwaps = (await _swaps.ForStoreAsync(store.Id, 20, cancellationToken)).ToList();
        return vm;
    }

    private static DoctorProbe Probe(string name, bool ok, string detail, string? fixUrl) => new(name, ok, detail, fixUrl);

    private async Task TestWalletAsync(SetupViewModel vm, StoreData store, CancellationToken cancellationToken)
    {
        var nwc = ResolveNwcInput(vm, store);
        if (nwc is null)
        {
            ModelState.AddModelError(nameof(vm.NwcUri), "Paste your NWC code first.");
            return;
        }
        var client = _settings.CreateClient(nwc, vm.AllowSpendCapableWallet, out var error);
        if (client is null)
        {
            ModelState.AddModelError(nameof(vm.NwcUri), error ?? "Invalid NWC code.");
            return;
        }
        vm.Preflight = await client.PreflightAsync(cancellationToken);
        var settings = await _settings.GetAsync(store.Id);
        settings.LastPreflight = OpenReceiveSettingsService.Snapshot(vm.Preflight);
        await _settings.SetAsync(store.Id, settings);
        if (!vm.Preflight.Ok)
        {
            ModelState.AddModelError(nameof(vm.NwcUri), vm.Preflight.Message ?? "The wallet failed the preflight.");
        }
    }

    private async Task<bool> UseWalletAsync(SetupViewModel vm, StoreData store, CancellationToken cancellationToken)
    {
        var nwc = ResolveNwcInput(vm, store);
        if (nwc is null)
        {
            ModelState.AddModelError(nameof(vm.NwcUri), "Paste your NWC code first.");
            return false;
        }
        // The preflight first, as its own report: a refusal shows the capability card (and the
        // risk checkbox when a spend method is the reason), not just an error line.
        var client = _settings.CreateClient(nwc, vm.AllowSpendCapableWallet, out var parseError);
        if (client is null)
        {
            ModelState.AddModelError(nameof(vm.NwcUri), parseError ?? "Invalid NWC code.");
            return false;
        }
        vm.Preflight = await client.PreflightAsync(cancellationToken);
        if (!vm.Preflight.Ok)
        {
            ModelState.AddModelError(nameof(vm.NwcUri), vm.Preflight.Message ?? "The wallet failed the preflight.");
            return false;
        }
        var error = await _settings.UseAsLightningNodeAsync(store, nwc, vm.AllowSpendCapableWallet, User);
        if (error is not null)
        {
            ModelState.AddModelError(nameof(vm.NwcUri), error);
            return false;
        }
        return true;
    }

    /// <summary>The textarea is masked after save: an empty field means "keep the saved code".</summary>
    private string? ResolveNwcInput(SetupViewModel vm, StoreData store)
    {
        if (!string.IsNullOrWhiteSpace(vm.NwcUri)) return vm.NwcUri.Trim();
        return _settings.GetConnection(store)?.NwcUri;
    }

    private async Task TestProviderAsync(SetupViewModel vm, StoreData store, CancellationToken cancellationToken)
    {
        var settings = await _settings.GetAsync(store.Id);
        var uri = string.IsNullOrWhiteSpace(vm.LscPrimary) ? settings.LscPrimary : vm.LscPrimary.Trim();
        if (string.IsNullOrEmpty(uri))
        {
            ModelState.AddModelError(nameof(vm.LscPrimary), "Paste an LSC code first.");
            return;
        }
        if (await LscEndpointErrorAsync(uri) is { } localError)
        {
            ModelState.AddModelError(nameof(vm.LscPrimary), localError);
            return;
        }
        try
        {
            var provider = _providers.Build(uri) ?? throw new FormatException("Invalid LSC code.");
            var catalog = await provider.PayInAssetCatalogAsync(cancellationToken);
            vm.ProviderTest = catalog.Select(c => new ProviderAssetStatus(c.PayAsset,
                OpenReceiveTables.SwapAssetInfo.TryGetValue(c.PayAsset, out var info) ? $"{info.Label} · {info.NetworkLabel}" : c.PayAsset,
                c.Available != false, c.UnavailableMessage, c.MinimumPayAmount, c.MaximumPayAmount)).ToList();
            vm.ProviderTestName = provider.Name;
        }
        catch (Exception e)
        {
            ModelState.AddModelError(nameof(vm.LscPrimary), $"Provider test failed: {e.Message}");
        }
    }

    /// <summary>Saves the provider codes; a saved primary code IS "swaps on". Returns whether swaps are on, or null when the form was refused.</summary>
    private async Task<bool?> SaveSwapsAsync(SetupViewModel vm, StoreData store, CancellationToken cancellationToken)
    {
        var settings = await _settings.GetAsync(store.Id);
        // Like the NWC code: the saved LSC codes never come back into the form. An empty
        // field keeps the saved code; the "remove" checkbox clears it; a pasted code replaces it.
        var primary = string.IsNullOrWhiteSpace(vm.LscPrimary) ? (vm.RemoveLscPrimary ? null : settings.LscPrimary) : vm.LscPrimary.Trim();
        var backup = string.IsNullOrWhiteSpace(vm.LscBackup) ? (vm.RemoveLscBackup ? null : settings.LscBackup) : vm.LscBackup.Trim();
        foreach (var (field, value) in new[] { (nameof(vm.LscPrimary), vm.LscPrimary), (nameof(vm.LscBackup), vm.LscBackup) })
        {
            if (string.IsNullOrWhiteSpace(value)) continue;
            if (!LscUri.TryParse(value.Trim(), out _, out var error))
            {
                ModelState.AddModelError(field, error ?? "Invalid LSC code.");
            }
            else if (await LscEndpointErrorAsync(value.Trim()) is { } localError)
            {
                ModelState.AddModelError(field, localError);
            }
        }
        if (primary is not null && _settings.GetConnection(store) is null)
        {
            ModelState.AddModelError(nameof(vm.LscPrimary), "Swaps settle into your OpenReceive wallet. Connect a receive-only NWC code first.");
        }
        if (!ModelState.IsValid) return null;
        settings.LscPrimary = primary;
        settings.LscBackup = backup;
        settings.SwapsEnabled = primary is not null;
        settings.EnabledPayInAssets = (vm.EnabledPayInAssets ?? new List<string>()).Where(OpenReceiveTables.SwapPayInAssets.Contains).ToList();
        await _settings.SetAsync(store.Id, settings);
        if (settings.SwapsEnabled && await _settings.EnsureInvoiceExpirationAsync(store, SwapService.RecommendedInvoiceExpiration))
        {
            TempData[WellKnownTempData.SuccessMessage] = "Invoice expiration raised to 60 minutes so swaps have time to settle.";
        }
        return settings.SwapsEnabled;
    }

    /// <summary>A store owner cannot point the server at a local-network provider; a server admin can.</summary>
    private Task<string?> LscEndpointErrorAsync(string lscUri) =>
        LscUri.TryParse(lscUri, out var connection, out _) && connection is not null
            ? _settings.LocalEndpointErrorAsync(new[] { connection.Host }, User)
            : Task.FromResult<string?>(null);

    private async Task<SetupViewModel> BuildSetupAsync(StoreData store, SetupViewModel vm, CancellationToken cancellationToken)
    {
        var settings = await _settings.GetAsync(store.Id);
        var connection = _settings.GetConnection(store);
        vm.StoreId = store.Id;
        vm.HasWallet = connection is not null;
        vm.LightningNode = _settings.DescribeLightningNode(store);
        vm.SavedRedactedNwc = connection is null ? null : NwcUri.Redact(connection.NwcUri);
        if (connection is not null && !Request.HasFormContentType) vm.AllowSpendCapableWallet = connection.AllowSpendCapableWallet;
        vm.LastPreflight = settings.LastPreflight;
        // Saved LSC codes are shown redacted and never put back into the inputs (they carry a key and a secret).
        vm.SavedRedactedLscPrimary = settings.LscPrimary is null ? null : LscUri.Redact(settings.LscPrimary);
        vm.SavedRedactedLscBackup = settings.LscBackup is null ? null : LscUri.Redact(settings.LscBackup);
        if (!Request.HasFormContentType)
        {
            vm.EnabledPayInAssets = settings.EnabledPayInAssets.Count == 0 ? OpenReceiveTables.SwapPayInAssets.ToList() : settings.EnabledPayInAssets;
        }
        vm.InvoiceExpirationMinutes = (int)store.GetStoreBlob().InvoiceExpiration.TotalMinutes;
        vm.Assets = OpenReceiveTables.SwapPayInAssets.Select(a => OpenReceiveTables.SwapAssetInfo[a]).ToList();
        vm.MinimumSwapInvoiceMinutes = (int)SwapService.MinimumInvoiceExpiration.TotalMinutes;
        return vm;
    }
}

public sealed class SetupViewModel
{
    public string StoreId { get; set; } = string.Empty;
    public bool HasWallet { get; set; }
    public string? LightningNode { get; set; }
    public string? SavedRedactedNwc { get; set; }
    public string? NwcUri { get; set; }
    public bool AllowSpendCapableWallet { get; set; }
    public WalletPreflightReport? Preflight { get; set; }
    /// <summary>The probes, when "Run a health check" was clicked on this page.</summary>
    public DoctorViewModel? HealthCheck { get; set; }
    /// <summary>The risk checkbox only exists once it is relevant: a test found a spend method, or the override is already on.</summary>
    public bool ShowSpendOverride => AllowSpendCapableWallet || Preflight?.Code == "spend_capability_advertised";
    /// <summary>The "Change wallet" disclosure stays open while a new code is being worked on (typed, tested, or refused).</summary>
    public bool ChangeWalletOpen => !string.IsNullOrWhiteSpace(NwcUri) || Preflight is not null;
    public OpenReceiveStoreSettings.PreflightSnapshot? LastPreflight { get; set; }
    public string? LscPrimary { get; set; }
    public string? LscBackup { get; set; }
    public string? SavedRedactedLscPrimary { get; set; }
    public string? SavedRedactedLscBackup { get; set; }
    public bool RemoveLscPrimary { get; set; }
    public bool RemoveLscBackup { get; set; }
    public List<string>? EnabledPayInAssets { get; set; }
    public List<OpenReceiveSwapAssetInfo> Assets { get; set; } = new();
    public List<ProviderAssetStatus>? ProviderTest { get; set; }
    public string? ProviderTestName { get; set; }
    public int InvoiceExpirationMinutes { get; set; }
    public int MinimumSwapInvoiceMinutes { get; set; }
}

public sealed record ProviderAssetStatus(string PayInAsset, string Label, bool Available, string? Message, string? Minimum, string? Maximum);

public sealed record DoctorProbe(string Name, bool Ok, string Detail, string? FixUrl);

public sealed class DoctorViewModel
{
    public string StoreId { get; set; } = string.Empty;
    public string? LightningNode { get; set; }
    public WalletPreflightReport? Preflight { get; set; }
    public List<DoctorProbe> Probes { get; } = new();
    public List<Data.OpenReceiveSwap> RecentSwaps { get; set; } = new();
}
