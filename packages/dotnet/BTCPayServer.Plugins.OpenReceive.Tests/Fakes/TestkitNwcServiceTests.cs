using System.Text.Json;
using System.Text.Json.Nodes;
using NBitcoin.Secp256k1;
using NNostr.Client;
using NNostr.Client.Protocols;
using OpenReceive.TestkitNwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Fakes;

/// <summary>Drives the NIP-47 protocol core in-process, without a relay.</summary>
public class TestkitNwcServiceTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private static (TestkitWalletService service, InMemoryWalletBackend backend) NewService(TestkitWalletOptions? options = null, long clock = 1_700_000_000)
    {
        var backend = new InMemoryWalletBackend { Clock = () => clock };
        var service = new TestkitWalletService(backend, options ?? new TestkitWalletOptions(), clock: () => clock);
        return (service, backend);
    }

    private static JsonObject Request(string method, object? parameters = null) => new()
    {
        ["method"] = method,
        ["params"] = parameters is null ? new JsonObject() : JsonNode.Parse(JsonSerializer.Serialize(parameters))!.AsObject(),
    };

    private static async Task<JsonObject> Call(TestkitWalletService service, string method, object? parameters = null)
    {
        var response = await service.HandleRequestAsync(Request(method, parameters), None);
        Assert.Equal(method, response["result_type"]!.GetValue<string>());
        return response;
    }

    private static JsonObject ResultOf(JsonObject response)
    {
        Assert.Null(response["error"]);
        return response["result"]!.AsObject();
    }

    private static string ErrorCodeOf(JsonObject response)
    {
        Assert.Null(response["result"]);
        return response["error"]!["code"]!.GetValue<string>();
    }

    private static ECPrivKey Secret(TestkitWalletService service) => NostrExtensions.ParseKey(service.ConnectionSecretHex);
    private static ECXOnlyPubKey WalletPub(TestkitWalletService service) => NostrExtensions.ParsePubKey(service.WalletPubKeyHex);

    // ---- make_invoice / lookup_invoice ----------------------------------------------------------

    [Fact]
    public async Task MakeInvoice_then_LookupInvoice_round_trips_and_settlement_adds_preimage()
    {
        var (service, backend) = NewService(clock: 1_700_000_000);

        var made = ResultOf(await Call(service, "make_invoice", new { amount = 21_000, description = "coffee", expiry = 600, metadata = new { order = "A1" } }));
        var hash = made["payment_hash"]!.GetValue<string>();
        Assert.Equal(64, hash.Length);
        Assert.Equal("incoming", made["type"]!.GetValue<string>());
        Assert.Equal(21_000, made["amount"]!.GetValue<long>());
        Assert.Equal("coffee", made["description"]!.GetValue<string>());
        Assert.Equal(1_700_000_000, made["created_at"]!.GetValue<long>());
        Assert.Equal(1_700_000_600, made["expires_at"]!.GetValue<long>());
        Assert.Equal("pending", made["state"]!.GetValue<string>());
        Assert.Equal(0, made["fees_paid"]!.GetValue<long>());
        Assert.Equal("A1", made["metadata"]!["order"]!.GetValue<string>());
        Assert.False(made.ContainsKey("preimage"));
        Assert.False(made.ContainsKey("settled_at"));
        Assert.StartsWith("lnbcrt", made["invoice"]!.GetValue<string>());

        var byHash = ResultOf(await Call(service, "lookup_invoice", new { payment_hash = hash }));
        Assert.Equal(hash, byHash["payment_hash"]!.GetValue<string>());
        var byBolt11 = ResultOf(await Call(service, "lookup_invoice", new { invoice = made["invoice"]!.GetValue<string>() }));
        Assert.Equal(hash, byBolt11["payment_hash"]!.GetValue<string>());

        WalletInvoice? settledEvent = null;
        service.OnInvoiceSettled += i => settledEvent = i;
        await backend.SettleAsync(hash);
        Assert.Equal(hash, settledEvent?.PaymentHash);

        var settled = ResultOf(await Call(service, "lookup_invoice", new { payment_hash = hash }));
        Assert.Equal("settled", settled["state"]!.GetValue<string>());
        Assert.Equal(1_700_000_000, settled["settled_at"]!.GetValue<long>());
        var preimage = settled["preimage"]!.GetValue<string>();
        Assert.Equal(hash, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Convert.FromHexString(preimage))));
        Assert.Equal("A1", settled["metadata"]!["order"]!.GetValue<string>());

        Assert.Equal("NOT_FOUND", ErrorCodeOf(await Call(service, "lookup_invoice", new { payment_hash = new string('0', 64) })));
        Assert.Equal("OTHER", ErrorCodeOf(await Call(service, "make_invoice", new { description = "no amount" })));
        Assert.Equal(21_000, ResultOf(await Call(service, "get_balance"))["balance"]!.GetValue<long>());
    }

    [Fact]
    public async Task ExpirySecondsDelta_shifts_expires_at()
    {
        var (service, _) = NewService(new TestkitWalletOptions { ExpirySecondsDelta = 90 }, clock: 1_000);
        var made = ResultOf(await Call(service, "make_invoice", new { amount = 1, expiry = 600 }));
        Assert.Equal(1_000 + 600 + 90, made["expires_at"]!.GetValue<long>());
    }

    // ---- list_transactions ---------------------------------------------------------------------

    private static async Task<string[]> Hashes(TestkitWalletService service, object parameters)
    {
        var result = ResultOf(await Call(service, "list_transactions", parameters));
        return result["transactions"]!.AsArray().Select(t => t!["payment_hash"]!.GetValue<string>()).ToArray();
    }

    [Fact]
    public async Task ListTransactions_unpaid_false_is_settled_only_and_unpaid_true_adds_pending()
    {
        var (service, backend) = NewService();
        var a = (await backend.MakeInvoiceAsync(1_000, "a", null, 3600, None)).PaymentHash;
        var b = (await backend.MakeInvoiceAsync(2_000, "b", null, 3600, None)).PaymentHash;
        await backend.SettleAsync(b);

        Assert.Equal([b], await Hashes(service, new { }));
        Assert.Equal([b], await Hashes(service, new { unpaid = false, type = "incoming" }));
        Assert.Equal([b, a], await Hashes(service, new { unpaid = true }));
        Assert.Empty(await Hashes(service, new { unpaid = true, type = "outgoing" }));

        var rows = ResultOf(await Call(service, "list_transactions", new { unpaid = true }))["transactions"]!.AsArray();
        Assert.Equal("settled", rows[0]!["state"]!.GetValue<string>());
        Assert.Equal("pending", rows[1]!["state"]!.GetValue<string>());
    }

    [Fact]
    public async Task ListTransactions_pages_newest_first_and_caps_limit()
    {
        var clock = 1_000L;
        var backend = new InMemoryWalletBackend { Clock = () => clock };
        var service = new TestkitWalletService(backend, new TestkitWalletOptions { PageLimitCap = 3 });
        var all = new List<string>();
        for (var i = 0; i < 7; i++)
        {
            clock = 1_000 + i;
            var invoice = await backend.MakeInvoiceAsync(1_000, $"#{i}", null, 3600, None);
            await backend.SettleAsync(invoice.PaymentHash);
            all.Add(invoice.PaymentHash);
        }
        all.Reverse(); // newest first

        Assert.Equal(all.Take(3), await Hashes(service, new { limit = 50 }));            // capped to 3
        Assert.Equal(all.Skip(3).Take(3), await Hashes(service, new { limit = 3, offset = 3 }));
        Assert.Equal(all.Skip(6), await Hashes(service, new { limit = 3, offset = 6 }));
        Assert.Empty(await Hashes(service, new { limit = 3, offset = 9 }));
        Assert.Equal(all.Where((_, i) => i is >= 1 and <= 3).Take(3), await Hashes(service, new { from = 1_003, until = 1_005 }));
    }

    [Fact]
    public async Task DropOffset_serves_page_zero_for_every_offset()
    {
        var clock = 1_000L;
        var backend = new InMemoryWalletBackend { Clock = () => clock };
        var service = new TestkitWalletService(backend, new TestkitWalletOptions { DropOffset = true, PageLimitCap = 2 });
        for (var i = 0; i < 5; i++)
        {
            clock = 1_000 + i;
            var invoice = await backend.MakeInvoiceAsync(1_000, null, null, 3600, None);
            await backend.SettleAsync(invoice.PaymentHash);
        }

        var page0 = await Hashes(service, new { limit = 2, offset = 0 });
        var page1 = await Hashes(service, new { limit = 2, offset = 2 });
        Assert.Equal(2, page0.Length);
        Assert.Equal(page0, page1);
    }

    // ---- encrypted request events ---------------------------------------------------------------

    private static async Task<NostrEvent> ClientRequest(TestkitWalletService service, ECPrivKey secret,
        NIP47.INIP47Request request, NIP47.EncryptionScheme scheme)
    {
        // Mirrors NIP47.SendNIP47Request's event construction.
        var evt = NIP47.CreateRequestEvent(request.ToNip47Request(), WalletPub(service));
        if (scheme == NIP47.EncryptionScheme.Nip44V2)
        {
            evt.SetTag(NIP47.EncryptionTag, NIP47.EncryptionSchemeNip44V2);
            evt.Content = NIP44.Encrypt(secret, WalletPub(service), evt.Content!);
        }
        else
        {
            await evt.EncryptNip04EventAsync(secret, null, true);
        }
        return await evt.ComputeIdAndSignAsync(secret, false);
    }

    private static async Task<NIP47.Nip47Response> ClientDecrypt(TestkitWalletService service, ECPrivKey secret,
        NostrEvent response, NIP47.EncryptionScheme scheme)
    {
        var plaintext = scheme == NIP47.EncryptionScheme.Nip44V2
            ? NIP44.Decrypt(secret, WalletPub(service), response.Content!)
            : await response.DecryptNip04EventAsync(secret, null, true);
        return JsonSerializer.Deserialize<NIP47.Nip47Response>(plaintext)!;
    }

    [Theory]
    [InlineData(NIP47.EncryptionScheme.Nip44V2)]
    [InlineData(NIP47.EncryptionScheme.Nip04)]
    public async Task HandleRequestEventAsync_answers_in_the_request_scheme(NIP47.EncryptionScheme scheme)
    {
        var (service, _) = NewService();
        var secret = Secret(service);

        var request = await ClientRequest(service, secret,
            new NIP47.MakeInvoiceRequest { AmountMsats = 5_000, Description = "event" }, scheme);
        var response = await service.HandleRequestEventAsync(request, None);

        Assert.Equal(NIP47.ResponseEventKind, response.Kind);
        Assert.Equal(service.WalletPubKeyHex, response.PublicKey);
        Assert.True(response.Verify());
        Assert.Equal([service.ConnectionPubKeyHex], response.GetTaggedPublicKeys());
        Assert.Equal([request.Id], response.GetTaggedEvents());
        var tag = response.GetTaggedData(NIP47.EncryptionTag);
        if (scheme == NIP47.EncryptionScheme.Nip44V2)
            Assert.Equal([NIP47.EncryptionSchemeNip44V2], tag);
        else
            Assert.Empty(tag);

        var decoded = await ClientDecrypt(service, secret, response, scheme);
        Assert.Null(decoded.Error);
        Assert.Equal("make_invoice", decoded.ResultType);
        var tx = decoded.Deserialize<NIP47.Nip47Transaction>()!;
        Assert.Equal(5_000, tx.AmountMsats);
        Assert.Equal("event", tx.Description);
        Assert.Equal(scheme == NIP47.EncryptionScheme.Nip44V2 ? "nip44_v2" : "nip04", service.LastUsedScheme);

        // A second request in the same scheme round-trips the hash through lookup_invoice.
        var lookup = await ClientRequest(service, secret, new NIP47.LookupInvoiceRequest { PaymentHash = tx.PaymentHash }, scheme);
        var found = await ClientDecrypt(service, secret, await service.HandleRequestEventAsync(lookup, None), scheme);
        Assert.Equal(tx.PaymentHash, found.Deserialize<NIP47.Nip47Transaction>()!.PaymentHash);
    }

    [Fact]
    public async Task HandleRequestEventAsync_rejects_a_foreign_sender_with_UNAUTHORIZED()
    {
        var (service, _) = NewService();
        var stranger = ECPrivKey.Create(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var request = await ClientRequest(service, stranger, new NIP47.GetInfoRequest(), NIP47.EncryptionScheme.Nip44V2);

        var response = await service.HandleRequestEventAsync(request, None);
        var decoded = await ClientDecrypt(service, stranger, response, NIP47.EncryptionScheme.Nip44V2);
        Assert.Equal("UNAUTHORIZED", decoded.Error?.Code);
        Assert.Equal("get_info", decoded.ResultType);
        Assert.Equal("nip44_v2", service.LastUsedScheme); // unchanged default, the stranger never counts
    }

    // ---- notifications ---------------------------------------------------------------------------

    [Theory]
    [InlineData("nip44_v2", NIP47.Nip44NotificationEventKind, true)]
    [InlineData("nip04", NIP47.NotificationEventKind, false)]
    public async Task Notification_event_kind_and_encryption_tag_follow_the_scheme(string scheme, int kind, bool taggedNip44)
    {
        var (service, backend) = NewService(clock: 2_000);
        var invoice = await backend.MakeInvoiceAsync(7_000, "push", null, 3600, None);
        await backend.SettleAsync(invoice.PaymentHash);
        var settled = (await backend.LookupAsync(invoice.PaymentHash, null, None))!;

        var evt = await service.BuildNotificationEventAsync(settled, scheme);
        Assert.Equal(kind, evt.Kind);
        Assert.Equal(service.WalletPubKeyHex, evt.PublicKey);
        Assert.True(evt.Verify());
        Assert.Equal([service.ConnectionPubKeyHex], evt.GetTaggedPublicKeys());
        Assert.Equal(taggedNip44 ? ["nip44_v2"] : [], evt.GetTaggedData(NIP47.EncryptionTag));

        var secret = Secret(service);
        var plaintext = taggedNip44
            ? NIP44.Decrypt(secret, WalletPub(service), evt.Content!)
            : await evt.DecryptNip04EventAsync(secret, null, true);
        var notification = JsonSerializer.Deserialize<NIP47.Nip47Notification>(plaintext)!;
        Assert.Equal("payment_received", notification.NotificationType);
        var tx = notification.Deserialize<NIP47.Nip47Transaction>()!;
        Assert.Equal(invoice.PaymentHash, tx.PaymentHash);
        Assert.Equal(2_000, tx.SettledAt);
        Assert.Equal(invoice.Preimage, tx.Preimage);
        Assert.Equal("settled", notification.Notification!["state"]!.GetValue<string>());
    }

    // ---- advertised-but-never-executed grants ----------------------------------------------------

    [Fact]
    public async Task Granted_pay_invoice_is_advertised_but_answers_NOT_IMPLEMENTED()
    {
        var (service, backend) = NewService(new TestkitWalletOptions { ExtraGrantedMethods = ["pay_invoice"] });

        var info = service.BuildInfoEvent();
        Assert.Equal(NIP47.InfoEvent, info.Kind);
        Assert.True(info.Verify());
        Assert.Contains("pay_invoice", info.Content!.Split(' '));
        Assert.Equal(["payment_received"], info.GetTaggedData("notifications"));
        Assert.Equal(["nip44_v2 nip04"], info.GetTaggedData(NIP47.EncryptionTag));

        var getInfo = ResultOf(await Call(service, "get_info"));
        Assert.Contains("pay_invoice", getInfo["methods"]!.AsArray().Select(m => m!.GetValue<string>()));
        Assert.Equal("regtest", getInfo["network"]!.GetValue<string>());

        var response = await Call(service, "pay_invoice", new { invoice = "lnbcrt1nevermind" });
        Assert.Equal("NOT_IMPLEMENTED", ErrorCodeOf(response));
        Assert.Equal(0, await backend.BalanceMsatsAsync(None));

        Assert.Equal("RESTRICTED", ErrorCodeOf(await Call(service, "pay_keysend", new { amount = 1 })));
        Assert.Equal("NOT_IMPLEMENTED", ErrorCodeOf(await Call(service, "teleport_funds")));
    }

    [Fact]
    public void Info_event_and_uri_follow_the_options()
    {
        var (service, _) = NewService(new TestkitWalletOptions { EncryptionSchemes = [], Notifications = false, Lud16 = "pay@example.org" });
        var info = service.BuildInfoEvent();
        Assert.Empty(info.GetTaggedData(NIP47.EncryptionTag));
        Assert.Empty(info.GetTaggedData("notifications"));

        var uri = service.NwcUri(new Uri("wss://relay.example/"), new Uri("wss://relay2.example/"));
        var parsed = NIP47.ParseUri(new Uri(uri));
        Assert.Equal(service.WalletPubKeyHex, parsed.pubkey.ToHex());
        Assert.Equal(service.ConnectionSecretHex, parsed.secret.ToHex());
        Assert.Equal(2, parsed.relays.Length);
        Assert.Equal("pay@example.org", parsed.lud16);
        Assert.DoesNotContain(service.ConnectionSecretHex, TestkitWalletService.RedactUri(uri));
    }
}
