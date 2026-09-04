using System;
using BTCPayServer.Abstractions.Contracts;
using BTCPayServer.Abstractions.Models;
using BTCPayServer.Abstractions.Services;
using BTCPayServer.Lightning;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Nwc;
using BTCPayServer.Plugins.OpenReceive.Settings;
using BTCPayServer.Plugins.OpenReceive.Swaps;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using NNostr.Client;

namespace BTCPayServer.Plugins.OpenReceive;

/// <summary>
/// OpenReceive for BTCPay Server: a receive-only NWC Lightning backend
/// (<c>type=openreceive;nwc=…</c>), an optional swap rail (USDT/USDC/ETH/SOL through a
/// Lightning Swap Connect provider, settling into the same wallet), and a guided setup
/// page with a doctor.
/// </summary>
public class OpenReceivePlugin : BaseBTCPayServerPlugin
{
    public override IBTCPayServerPlugin.PluginDependency[] Dependencies { get; } =
    {
        new() { Identifier = nameof(BTCPayServer), Condition = ">=2.4.2" },
    };

    public override void Execute(IServiceCollection services)
    {
        // Lightning backend. NostrClientPool is TryAdd so the Nostr plugin and this one share relay sockets.
        services.TryAddSingleton<NostrClientPool>();
        services.AddSingleton<NwcConnectionRegistry>();
        services.AddSingleton<NwcConnectionStringHandler>();
        services.AddSingleton<ILightningConnectionStringHandler>(provider => provider.GetRequiredService<NwcConnectionStringHandler>());

        // Settings and swaps.
        services.AddSingleton<OpenReceiveSettingsService>();
        services.AddSingleton<ISwapSettingsSource>(provider => provider.GetRequiredService<OpenReceiveSettingsService>());
        services.AddSingleton<BtcPayInvoiceSource>();
        services.AddSingleton<ISwapInvoiceSource>(provider => provider.GetRequiredService<BtcPayInvoiceSource>());
        services.AddHttpClient("openreceive-swap", client => client.Timeout = TimeSpan.FromSeconds(30));
        services.AddSingleton<SwapProviderPool>();
        services.AddSingleton<ISwapStore, EfSwapStore>();
        services.AddSingleton<SwapService>();
        services.AddScheduledTask<SwapPoller>(TimeSpan.FromSeconds(5));
        services.AddSingleton<SwapInvoiceEventsService>();
        services.AddHostedService(provider => provider.GetRequiredService<SwapInvoiceEventsService>());

        // The plugin's own table inside BTCPay's database, migrated by BTCPay at startup.
        services.AddSingleton<OpenReceiveDbContextFactory>();
        services.AddDbContext<OpenReceivePluginDbContext>((provider, options) =>
        {
            var factory = provider.GetRequiredService<OpenReceiveDbContextFactory>();
            factory.ConfigureBuilder(options);
        });
        services.AddHostedService<PluginMigrationRunner>();

        // UI.
        services.AddUIExtension("store-integrations-nav", "OpenReceive/Nav");
        services.AddUIExtension("store-wallets-nav", "OpenReceive/WalletsNav");
        services.AddUIExtension("ln-payment-method-setup-tab", "OpenReceive/LNPaymentMethodSetupTab");
        services.AddUIExtension("dashboard-setup-guide-wallet", "OpenReceive/DashboardSetupGuide");
        services.AddUIExtension("checkout-payment-method", "OpenReceive/CheckoutPaymentMethodExtension");
        services.AddUIExtension("checkout-payment", "OpenReceive/CheckoutPaymentExtension");
        services.AddUIExtension("store-invoices-payments", "OpenReceive/InvoiceSwapPayments");

        base.Execute(services);
    }
}
