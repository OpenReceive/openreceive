using System.Text.Json.Nodes;

namespace OpenReceive.IntegrationTests;

/// <summary>
/// The regtest legs from the plugin plan (2.7), against the docker stack. Order matters
/// within the class: the wallet is connected first, then swaps are enabled.
/// </summary>
[Trait("Category", "Integration")]
[Collection("e2e")]
public sealed class BtcPayPluginE2eTests : IClassFixture<E2eStack>
{
    private readonly E2eStack _stack;

    public BtcPayPluginE2eTests(E2eStack stack)
    {
        _stack = stack;
    }

    private static void RequireStack() => Assert.SkipUnless(E2eStack.Enabled, "OPENRECEIVE_E2E_BTCPAY_URL is not set: start packages/dotnet/docker/up.sh and export it.");

    private async Task ConnectWalletAsync()
    {
        // Always exercise saving, including on a reused stack: preflight alone does
        // not construct BTCPay's PaymentMethodConfigValidationContext.
        var nwc = await _stack.TestkitNwcUri();
        var preflight = await _stack.BtcPay(HttpMethod.Post, $"/api/v1/stores/{_stack.StoreId}/openreceive/wallet/test", new { nwcUri = nwc });
        Assert.True(preflight!["ok"]!.GetValue<bool>(), preflight["message"]?.GetValue<string>());
        Assert.Equal("nip44_v2", preflight["encryption"]!.GetValue<string>());
        Assert.Contains("payment_received", preflight["notifications"]!.AsArray().Select(n => n!.GetValue<string>()));
        var updated = await _stack.BtcPay(HttpMethod.Put, $"/api/v1/stores/{_stack.StoreId}/openreceive/settings", new { nwcUri = nwc });
        Assert.True(updated!["lightningNodeIsOpenReceive"]!.GetValue<bool>());
        // BTCPay's Greenfield hides the Lightning config body; the plugin's settings endpoint describes it (redacted).
        Assert.StartsWith("type=openreceive;nwc=nostr+walletconnect://", updated["lightningNode"]!.GetValue<string>());
        Assert.Contains("secret=[REDACTED]", updated["lightningNode"]!.GetValue<string>());
    }

    [Fact]
    public async Task Receive_only_wallet_preflight_and_save_persist_the_store_lightning_backend()
    {
        RequireStack();
        // A two-day store timer: BTCPay permits it, the backend mints at most a day, so saving the wallet lowers it.
        var store = (await _stack.BtcPay(HttpMethod.Get, $"/api/v1/stores/{_stack.StoreId}"))!.AsObject();
        store["invoiceExpiration"] = 2 * 24 * 3600; // Greenfield's unit is seconds; the plugin reports minutes
        await _stack.BtcPay(HttpMethod.Put, $"/api/v1/stores/{_stack.StoreId}", store);
        await ConnectWalletAsync();
        var saved = await _stack.BtcPay(HttpMethod.Get, $"/api/v1/stores/{_stack.StoreId}/openreceive/settings");
        Assert.True(saved!["lightningNodeIsOpenReceive"]!.GetValue<bool>());
        Assert.StartsWith("type=openreceive;nwc=nostr+walletconnect://", saved["lightningNode"]!.GetValue<string>());
        Assert.Contains("secret=[REDACTED]", saved["lightningNode"]!.GetValue<string>());
        Assert.Equal(24 * 60, saved["invoiceExpirationMinutes"]!.GetValue<int>());
    }

    [Fact]
    public async Task Lightning_invoice_settles_through_the_receive_only_nwc_backend()
    {
        RequireStack();
        await ConnectWalletAsync();
        var invoiceId = await _stack.CreateInvoiceAsync("2.50");
        var bolt11 = await _stack.Bolt11Of(invoiceId);
        Assert.StartsWith("lnbcrt", bolt11);
        var pay = await _stack.PayFromCustomer(bolt11);
        Assert.Equal("SUCCEEDED", pay?["result"]?["status"]?.GetValue<string>());
        var status = await _stack.WaitForInvoiceStatus(invoiceId, "Settled", TimeSpan.FromSeconds(45));
        Assert.Equal("Settled", status);
    }

    [Fact]
    public async Task Spend_capable_code_is_refused_unless_overridden()
    {
        RequireStack();
        var spend = await _stack.TestkitSpendNwcUri();
        var refused = await _stack.BtcPay(HttpMethod.Post, $"/api/v1/stores/{_stack.StoreId}/openreceive/wallet/test", new { nwcUri = spend });
        Assert.False(refused!["ok"]!.GetValue<bool>());
        Assert.Equal("spend_capability_advertised", refused["code"]!.GetValue<string>());
        Assert.Contains("pay_invoice", refused["spendMethods"]!.AsArray().Select(m => m!.GetValue<string>()));
        Assert.DoesNotContain("secret=", refused["message"]!.GetValue<string>());
        var admitted = await _stack.BtcPay(HttpMethod.Post, $"/api/v1/stores/{_stack.StoreId}/openreceive/wallet/test", new { nwcUri = spend, allowSpendCapableWallet = true });
        Assert.True(admitted!["ok"]!.GetValue<bool>());
        // BTCPay's own Lightning config path runs the same preflight: the string is refused on save.
        var (status, _) = await _stack.BtcPayRaw(HttpMethod.Put, $"/api/v1/stores/{_stack.StoreId}/payment-methods/BTC-LN",
            new { enabled = true, config = new { connectionString = $"type=openreceive;nwc={spend}" } });
        Assert.Equal(422, status);
    }

    [Fact]
    public async Task Swap_pays_the_invoice_and_refund_path_works()
    {
        RequireStack();
        await ConnectWalletAsync();
        var lsc = await _stack.FakeLscUri();
        var settings = await _stack.BtcPay(HttpMethod.Put, $"/api/v1/stores/{_stack.StoreId}/openreceive/settings", new { lscPrimary = lsc, swapsEnabled = true });
        Assert.True(settings!["swapsEnabled"]!.GetValue<bool>());
        Assert.True(settings["invoiceExpirationMinutes"]!.GetValue<int>() >= 45);

        // Happy path: the provider completes and pays the BOLT11 from the payer node; BTCPay's listener settles.
        await _stack.FakeLsc("script", new { selector = "USDT_TRON", states = new[] { "confirming", "exchanging", "completed" } });
        var invoiceId = await _stack.CreateInvoiceAsync("25.00");
        var (createStatus, swap) = await _stack.Public(HttpMethod.Post, "/api/plugins/openreceive/swaps", new { invoiceId, payInAsset = "USDT_TRON" });
        Assert.Equal(200, createStatus);
        Assert.Equal("awaiting_deposit", swap!["state"]!.GetValue<string>());
        Assert.StartsWith("T", swap["deposit_address"]!.GetValue<string>());
        Assert.DoesNotContain("token", swap.ToJsonString());
        var swapId = swap["swap_id"]!.GetValue<string>();
        var again = await _stack.Public(HttpMethod.Post, "/api/plugins/openreceive/swaps", new { invoiceId, payInAsset = "USDT_TRON" });
        Assert.Equal(swapId, again.Body!["swap_id"]!.GetValue<string>());

        JsonNode? snapshot = null;
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < deadline)
        {
            (_, snapshot) = await _stack.Public(HttpMethod.Get, $"/api/plugins/openreceive/swaps/{invoiceId}/{swapId}");
            if (snapshot!["invoice_status"]!.GetValue<string>() == "Settled" && snapshot["wallet_settled"]!.GetValue<bool>()) break;
            await Task.Delay(1000, TestContext.Current.CancellationToken);
        }
        Assert.Equal("Settled", snapshot!["invoice_status"]!.GetValue<string>());
        Assert.True(snapshot["wallet_settled"]!.GetValue<bool>());
        Assert.Equal("completed", snapshot["state"]!.GetValue<string>());

        // Refund path: underpaid deposit → refund_required → checksum-validated address → refund_pending.
        await _stack.FakeLsc("force-refund-required", new { selector = "USDT_TRON", reason = "underpaid" });
        var refundInvoice = await _stack.CreateInvoiceAsync("30.00");
        var (_, refundSwap) = await _stack.Public(HttpMethod.Post, "/api/plugins/openreceive/swaps", new { invoiceId = refundInvoice, payInAsset = "USDT_TRON" });
        var refundSwapId = refundSwap!["swap_id"]!.GetValue<string>();
        deadline = DateTime.UtcNow.AddSeconds(45);
        JsonNode? refundSnapshot = null;
        while (DateTime.UtcNow < deadline)
        {
            (_, refundSnapshot) = await _stack.Public(HttpMethod.Get, $"/api/plugins/openreceive/swaps/{refundInvoice}/{refundSwapId}");
            if (refundSnapshot!["state"]!.GetValue<string>() == "refund_required") break;
            await Task.Delay(1000, TestContext.Current.CancellationToken);
        }
        Assert.Equal("refund_required", refundSnapshot!["state"]!.GetValue<string>());
        Assert.Equal("underpaid", refundSnapshot["refund_reason"]!.GetValue<string>());
        var (badStatus, bad) = await _stack.Public(HttpMethod.Post, $"/api/plugins/openreceive/swaps/{refundInvoice}/{refundSwapId}/refund", new { refundAddress = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg" });
        Assert.Equal(400, badStatus);
        Assert.Equal("invalid_refund_address", bad!["code"]!.GetValue<string>());
        var (goodStatus, good) = await _stack.Public(HttpMethod.Post, $"/api/plugins/openreceive/swaps/{refundInvoice}/{refundSwapId}/refund", new { refundAddress = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf" });
        Assert.Equal(200, goodStatus);
        Assert.Equal("refund_pending", good!["state"]!.GetValue<string>());
        var (dupStatus, _) = await _stack.Public(HttpMethod.Post, $"/api/plugins/openreceive/swaps/{refundInvoice}/{refundSwapId}/refund", new { refundAddress = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf" });
        Assert.Equal(409, dupStatus);

        // Merchant view carries the refund fields and never the token.
        var merchant = await _stack.BtcPay(HttpMethod.Get, $"/api/v1/stores/{_stack.StoreId}/openreceive/invoices/{refundInvoice}/swaps");
        var row = merchant!.AsArray().Single();
        Assert.Equal("refund_pending", row!["state"]!.GetValue<string>());
        Assert.DoesNotContain("providerToken", merchant.ToJsonString());
        // A foreign invoice id cannot read the swap (the invoice id is the payer's bearer).
        var (foreign, _) = await _stack.Public(HttpMethod.Get, $"/api/plugins/openreceive/swaps/{invoiceId}/{refundSwapId}");
        Assert.Equal(404, foreign);
    }

    [Fact]
    public async Task View_only_key_never_sees_a_foreign_lightning_backends_credentials()
    {
        RequireStack();
        await ConnectWalletAsync();
        // The plugin's settings route exists for every store on the server, so it must not
        // hand a CanViewStoreSettings key what BTCPay's own Greenfield hides from it: the
        // Lightning config body. Point the store at a foreign backend with a known fake
        // credential and read the route back with a key that can only view settings.
        const string login = "e2elogin";
        const string password = "e2e-s3cret-password";
        var viewOnly = await _stack.CreateApiKeyAsync($"btcpay.store.canviewstoresettings:{_stack.StoreId}");
        try
        {
            // BTCPay's LNDhub handler accepts the URI form verbatim (its setup page documents
            // `lndhub://login:password@https://lndhub.io`); the key=value form is the fallback
            // should the URI form ever be refused by validation. Both put the credential in
            // the first ';'-separated field, which is what the old description leaked.
            var refusals = new List<string>();
            var configured = false;
            foreach (var connectionString in new[]
                     {
                         $"lndhub://{login}:{password}@https://lndhub.example.invalid",
                         $"type=lndhub;server=https://{login}:{password}@lndhub.example.invalid",
                     })
            {
                var (status, body) = await _stack.BtcPayRaw(HttpMethod.Put, $"/api/v1/stores/{_stack.StoreId}/payment-methods/BTC-LN",
                    new { enabled = true, config = new { connectionString } });
                if (status is >= 200 and < 300)
                {
                    configured = true;
                    break;
                }
                refusals.Add($"{connectionString.Split(login)[0]}… -> {status}: {body?.ToJsonString()}");
            }
            Assert.SkipWhen(!configured, "BTCPay refused both LNDhub connection-string forms on save, so the foreign-backend leg cannot run:\n" + string.Join("\n", refusals));

            var (viewStatus, view) = await _stack.BtcPayRaw(HttpMethod.Get, $"/api/v1/stores/{_stack.StoreId}/openreceive/settings", apiKey: viewOnly);
            Assert.Equal(200, viewStatus);
            Assert.False(view!["lightningNodeIsOpenReceive"]!.GetValue<bool>());
            Assert.Equal("lndhub", view["lightningNode"]!.GetValue<string>());
            var text = view.ToJsonString();
            Assert.DoesNotContain(login, text);
            Assert.DoesNotContain("s3cret", text);
            Assert.DoesNotContain("lndhub.example.invalid", text);

            // The write routes stay behind CanModifyStoreSettings.
            var (putStatus, _) = await _stack.BtcPayRaw(HttpMethod.Put, $"/api/v1/stores/{_stack.StoreId}/openreceive/settings", new { swapsEnabled = false }, apiKey: viewOnly);
            Assert.Equal(403, putStatus);
            var (testStatus, _) = await _stack.BtcPayRaw(HttpMethod.Post, $"/api/v1/stores/{_stack.StoreId}/openreceive/wallet/test", new { nwcUri = "nostr+walletconnect://" }, apiKey: viewOnly);
            Assert.Equal(403, testStatus);
        }
        finally
        {
            // The other tests connect the wallet themselves, but never leave a foreign backend behind.
            await ConnectWalletAsync();
        }
        var restored = await _stack.BtcPay(HttpMethod.Get, $"/api/v1/stores/{_stack.StoreId}/openreceive/settings", apiKey: viewOnly);
        Assert.True(restored!["lightningNodeIsOpenReceive"]!.GetValue<bool>());
        Assert.Contains("secret=[REDACTED]", restored["lightningNode"]!.GetValue<string>());
        Assert.DoesNotContain(login, restored.ToJsonString());
    }

    [Fact]
    public async Task Top_up_invoice_is_refused_with_a_clear_message()
    {
        RequireStack();
        await ConnectWalletAsync();
        // BTCPay activates the Lightning prompt while creating the invoice; our client refuses
        // an amountless make_invoice with a clear message, which BTCPay surfaces as a 400.
        var (status, body) = await _stack.BtcPayRaw(HttpMethod.Post, $"/api/v1/stores/{_stack.StoreId}/invoices", new { currency = "USD", checkout = new { paymentMethods = new[] { "BTC-LN" } } });
        Assert.Equal(400, status);
        Assert.Contains("top-up invoices are not supported", body!.ToJsonString());
    }
}
