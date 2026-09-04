#nullable enable
using System;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Abstractions.Contracts;
using BTCPayServer.Data;
using BTCPayServer.Payments;
using BTCPayServer.Payments.Lightning;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using BTCPayServer.Services.Invoices;
using BTCPayServer.Services.Stores;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace BTCPayServer.Plugins.OpenReceive.Settings;

/// <summary>
/// Reads and writes the plugin's per-store settings, and knows how a store's Lightning
/// node relates to this plugin: whether it IS an OpenReceive connection, and how to make
/// it one through BTCPay's own validation path (the same path the UI and Greenfield use),
/// so every invariant BTCPay enforces on Lightning config still holds.
/// </summary>
public sealed class OpenReceiveSettingsService : Swaps.ISwapSettingsSource
{
    private const string SettingName = "OpenReceive";
    private readonly IStoreRepository _storeRepository;
    private readonly StoreRepository _stores;
    private readonly IMemoryCache _cache;
    private readonly PaymentMethodHandlerDictionary _handlers;
    private readonly BTCPayNetworkProvider _networks;
    private readonly IAuthorizationService _authorization;
    private readonly NwcConnectionRegistry _registry;
    private readonly ILogger<OpenReceiveSettingsService> _logger;

    public OpenReceiveSettingsService(
        IStoreRepository storeRepository,
        StoreRepository stores,
        IMemoryCache cache,
        PaymentMethodHandlerDictionary handlers,
        BTCPayNetworkProvider networks,
        IAuthorizationService authorization,
        NwcConnectionRegistry registry,
        ILogger<OpenReceiveSettingsService> logger)
    {
        _storeRepository = storeRepository;
        _stores = stores;
        _cache = cache;
        _handlers = handlers;
        _networks = networks;
        _authorization = authorization;
        _registry = registry;
        _logger = logger;
    }

    public BTCPayNetwork BitcoinNetwork => _networks.GetNetwork<BTCPayNetwork>("BTC")!;
    public PaymentMethodId LightningPaymentMethodId => PaymentTypes.LN.GetPaymentMethodId("BTC");

    private static string CacheKey(string storeId) => $"openreceive:settings:{storeId}";

    public async Task<OpenReceiveStoreSettings> GetAsync(string storeId)
    {
        var settings = await _cache.GetOrCreateAsync(CacheKey(storeId), async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(10);
            return await _storeRepository.GetSettingAsync<OpenReceiveStoreSettings>(storeId, SettingName) ?? new OpenReceiveStoreSettings();
        });
        return settings ?? new OpenReceiveStoreSettings();
    }

    public async Task SetAsync(string storeId, OpenReceiveStoreSettings settings)
    {
        await _storeRepository.UpdateSetting(storeId, SettingName, settings);
        _cache.Remove(CacheKey(storeId));
    }

    /// <summary>The store's Lightning connection when it is an OpenReceive connection, else null.</summary>
    public OpenReceiveConnectionString? GetConnection(StoreData store)
    {
        var config = _handlers.GetLightningConfig(store, BitcoinNetwork);
        var connectionString = config?.GetExternalLightningUrl();
        if (string.IsNullOrEmpty(connectionString)) return null;
        try
        {
            return OpenReceiveConnectionString.Parse(connectionString);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>The raw Lightning connection string BTCPay holds for the store (redacted for display).</summary>
    public string? DescribeLightningNode(StoreData store)
    {
        var config = _handlers.GetLightningConfig(store, BitcoinNetwork);
        if (config is null) return null;
        if (config.IsInternalNode) return "Internal node";
        var external = config.GetExternalLightningUrl();
        if (string.IsNullOrEmpty(external)) return null;
        return OpenReceiveConnectionString.IsOurs(external) ? OpenReceiveConnectionString.Redact(external) : external.Split(';').FirstOrDefault();
    }

    /// <summary>The shared per-connection state (memo, capabilities) for a store, when it uses our backend.</summary>
    public NwcConnectionState? GetConnectionState(StoreData store)
    {
        var connection = GetConnection(store);
        if (connection is null) return null;
        return NwcUri.TryParse(connection.NwcUri, out var uri, out _) && uri is not null ? _registry.GetOrAdd(connection, uri) : null;
    }

    public ReceiveOnlyNwcClient? CreateClient(StoreData store)
    {
        var state = GetConnectionState(store);
        return state is null ? null : new ReceiveOnlyNwcClient(state, BitcoinNetwork.NBitcoinNetwork, _logger);
    }

    /// <summary>A client for a connection string that is not (yet) saved on a store, e.g. the setup page's "Test".</summary>
    public ReceiveOnlyNwcClient? CreateClient(string nwcUri, bool allowSpendCapableWallet, out string? error)
    {
        if (!NwcUri.TryParse(nwcUri, out var uri, out var parseError) || uri is null)
        {
            error = NwcUri.FormatInvalidNwcMessage(parseError?.Message, "The NWC code");
            return null;
        }
        error = null;
        var state = _registry.GetOrAdd(new OpenReceiveConnectionString(nwcUri.Trim(), allowSpendCapableWallet), uri);
        return new ReceiveOnlyNwcClient(state, BitcoinNetwork.NBitcoinNetwork, _logger);
    }

    /// <summary>
    /// Writes the NWC code into the store's BTC-LN config as the canonical connection string,
    /// through the Lightning handler's own validation (which runs our receive-only preflight),
    /// and enables LNURL like BTCPay's own Lightning settings page does. Returns the validation
    /// error text when the save was refused.
    /// </summary>
    public async Task<string?> UseAsLightningNodeAsync(StoreData store, string nwcUri, bool allowSpendCapableWallet, ClaimsPrincipal user)
    {
        var connectionString = OpenReceiveConnectionString.Format(nwcUri.Trim(), allowSpendCapableWallet);
        var network = BitcoinNetwork;
        var paymentMethodId = LightningPaymentMethodId;
        var handler = (LightningLikePaymentHandler)_handlers[paymentMethodId];
        var oldConfig = _handlers.GetLightningConfig(store, network);
        var config = new LightningPaymentMethodConfig { ConnectionString = connectionString };
        var modelState = new ModelStateDictionary();
        var context = new PaymentMethodConfigValidationContext(_authorization, modelState,
            JToken.FromObject(config, handler.Serializer), user,
            oldConfig is null ? null : JToken.FromObject(oldConfig, handler.Serializer));
        await handler.ValidatePaymentMethodConfig(context);
        if (context.MissingPermission is not null)
        {
            return "You do not have the permissions to change this store's Lightning node.";
        }
        if (!modelState.IsValid)
        {
            return string.Join("\n", modelState.Values.SelectMany(v => v.Errors).Select(e => e.ErrorMessage));
        }
        store.SetPaymentMethodConfig(_handlers[paymentMethodId], config);
        var lnurl = PaymentTypes.LNURL.GetPaymentMethodId(network.CryptoCode);
        store.SetPaymentMethodConfig(_handlers[lnurl], new LNURLPaymentMethodConfig
        {
            UseBech32Scheme = true,
            LUD12Enabled = false,
            LUD21Enabled = true,
        });
        var blob = store.GetStoreBlob();
        blob.SetExcluded(paymentMethodId, false);
        blob.SetExcluded(lnurl, false);
        store.SetStoreBlob(blob);
        await _stores.UpdateStore(store);
        _logger.LogInformation("openreceive.setup.lightning_node_set store={Store} wallet={Wallet}", store.Id, NwcUri.Redact(nwcUri));
        return null;
    }

    /// <summary>Swaps need the invoice to outlive the provider window: raise the store's invoice expiration when it is shorter.</summary>
    public async Task<bool> EnsureInvoiceExpirationAsync(StoreData store, TimeSpan minimum)
    {
        var blob = store.GetStoreBlob();
        if (blob.InvoiceExpiration >= minimum) return false;
        blob.InvoiceExpiration = minimum;
        store.SetStoreBlob(blob);
        await _stores.UpdateStore(store);
        _logger.LogInformation("openreceive.setup.invoice_expiration_raised store={Store} minutes={Minutes}", store.Id, minimum.TotalMinutes);
        return true;
    }

    public static OpenReceiveStoreSettings.PreflightSnapshot Snapshot(WalletPreflightReport report)
    {
        var summary = report.Summary;
        return new OpenReceiveStoreSettings.PreflightSnapshot
        {
            CheckedAt = report.CheckedAt,
            Ok = report.Ok,
            Code = report.Code,
            Message = report.Message,
            WalletPubkey = summary?.WalletPubkey,
            Relays = summary?.Relays.ToList() ?? new(),
            Methods = summary?.Methods.ToList() ?? new(),
            SpendMethods = summary?.SpendMethods.ToList() ?? new(),
            Notifications = summary?.Notifications.ToList() ?? new(),
            Encryption = summary?.Encryption,
            Network = summary?.Network,
            RelayRoundTripMs = report.RelayRoundTrip?.TotalMilliseconds,
        };
    }
}
