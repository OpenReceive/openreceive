using BTCPayServer.Plugins.OpenReceive.Nwc;
using Microsoft.Extensions.Logging.Abstractions;
using NBitcoin;
using NNostr.Client;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Nwc;

/// <summary>
/// The one BTCPay connection string this plugin answers to (<c>type=openreceive;nwc=…</c>)
/// and the handler that claims it — and nothing else, so the Nostr plugin's forms stay theirs.
/// </summary>
public sealed class ConnectionStringTests
{
    private const string Pubkey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Secret = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string Relay = "wss%3A%2F%2Frelay.example.com";
    private const string NwcUriText = "nostr+walletconnect://" + Pubkey + "?relay=" + Relay + "&secret=" + Secret;

    // ---- OpenReceiveConnectionString ----

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Format_and_Parse_round_trip(bool allowSpend)
    {
        var text = OpenReceiveConnectionString.Format(NwcUriText, allowSpend);
        Assert.StartsWith("type=openreceive;nwc=", text);
        Assert.Equal(allowSpend, text.EndsWith(";allow-spend=true", StringComparison.Ordinal));

        var parsed = OpenReceiveConnectionString.Parse(text);
        Assert.NotNull(parsed);
        Assert.Equal(NwcUriText, parsed.NwcUri);
        Assert.Equal(allowSpend, parsed.AllowSpendCapableWallet);
        Assert.Equal(text, parsed.Format());
        Assert.True(OpenReceiveConnectionString.IsOurs(text));
    }

    [Fact]
    public void Parse_keeps_the_nwc_query_string_intact()
    {
        // `;` splits fields and only the first `=` splits key from value, so the NWC URI's
        // own `?relay=…&secret=…` survives even though it carries `=` signs of its own.
        var parsed = OpenReceiveConnectionString.Parse($"type=openreceive;nwc={NwcUriText}");
        Assert.Equal(NwcUriText, parsed!.NwcUri);
        Assert.Contains("&secret=", parsed.NwcUri);
    }

    [Theory]
    [InlineData("type=nwc;key=" + NwcUriText)]
    [InlineData(NwcUriText)]
    [InlineData("type=lnd-rest;server=https://lnd.example")]
    public void Parse_returns_null_for_strings_that_are_not_ours(string connectionString)
    {
        Assert.False(OpenReceiveConnectionString.IsOurs(connectionString));
        Assert.Null(OpenReceiveConnectionString.Parse(connectionString));
        // Redact leaves a foreign string alone: it has no idea where its secrets are.
        Assert.Equal(connectionString, OpenReceiveConnectionString.Redact(connectionString));
    }

    [Fact]
    public void Parse_rejects_an_unknown_key_without_leaking_the_secret()
    {
        var error = Assert.Throws<FormatException>(() =>
            OpenReceiveConnectionString.Parse($"type=openreceive;nwc={NwcUriText};bogus=1"));
        Assert.Contains("bogus", error.Message);
        Assert.DoesNotContain(Secret, error.Message);
    }

    [Fact]
    public void Parse_rejects_a_missing_or_repeated_nwc_value()
    {
        Assert.Throws<FormatException>(() => OpenReceiveConnectionString.Parse("type=openreceive"));
        Assert.Throws<FormatException>(() => OpenReceiveConnectionString.Parse("type=openreceive;nwc="));
        var repeated = Assert.Throws<FormatException>(() =>
            OpenReceiveConnectionString.Parse($"type=openreceive;nwc={NwcUriText};nwc={NwcUriText}"));
        Assert.DoesNotContain(Secret, repeated.Message);
    }

    [Fact]
    public void Redact_hides_the_secret_and_nothing_else()
    {
        var text = OpenReceiveConnectionString.Format(NwcUriText, allowSpendCapableWallet: true);
        var redacted = OpenReceiveConnectionString.Redact(text);
        Assert.DoesNotContain(Secret, redacted);
        Assert.Contains($"secret={NwcUri.RedactedSecret}", redacted);
        Assert.Contains(Pubkey, redacted);
        Assert.Contains($"relay={Relay}", redacted);
        Assert.EndsWith(";allow-spend=true", redacted);
        Assert.StartsWith("type=openreceive;nwc=nostr+walletconnect://", redacted);
    }

    // ---- NwcConnectionStringHandler ----

    private static (NwcConnectionStringHandler Handler, NostrClientPool Pool) NewHandler()
    {
        var (handler, pool, _) = NewHandlerWithRegistry();
        return (handler, pool);
    }

    private static (NwcConnectionStringHandler Handler, NostrClientPool Pool, NwcConnectionRegistry Registry) NewHandlerWithRegistry()
    {
        var pool = new NostrClientPool();
        var registry = new NwcConnectionRegistry(pool, NullLoggerFactory.Instance);
        return (new NwcConnectionStringHandler(registry, NullLogger<ReceiveOnlyNwcClient>.Instance), pool, registry);
    }

    [Theory]
    [InlineData("type=nwc;key=" + NwcUriText)]
    [InlineData(NwcUriText)]
    public void Handler_declines_the_nostr_plugins_forms_without_an_error(string connectionString)
    {
        var (handler, pool) = NewHandler();
        using (pool)
        {
            var client = handler.Create(connectionString, Network.RegTest, out var error);
            Assert.Null(client);
            Assert.Null(error);
        }
    }

    [Fact]
    public void Handler_creates_a_receive_only_client_whose_ToString_is_the_canonical_string()
    {
        var (handler, pool) = NewHandler();
        using (pool)
        {
            var canonical = OpenReceiveConnectionString.Format(NwcUriText, allowSpendCapableWallet: false);
            var client = handler.Create($"  {canonical}", Network.RegTest, out var error);
            Assert.Null(error);
            var receiveOnly = Assert.IsType<ReceiveOnlyNwcClient>(client);
            Assert.Equal(canonical, receiveOnly.ToString());
            Assert.False(receiveOnly.AllowSpendCapableWallet);
            Assert.Equal(Pubkey, receiveOnly.Uri.WalletPubkey);
            Assert.Equal("wss://relay.example.com/", receiveOnly.ServerUri?.ToString());
            Assert.DoesNotContain(Secret, receiveOnly.DisplayName);

            var withOverride = handler.Create(OpenReceiveConnectionString.Format(NwcUriText, true), Network.RegTest, out error);
            Assert.Null(error);
            Assert.True(Assert.IsType<ReceiveOnlyNwcClient>(withOverride).AllowSpendCapableWallet);
            Assert.Equal(OpenReceiveConnectionString.Format(NwcUriText, true), withOverride!.ToString());
        }
    }

    [Fact]
    public void Handler_shares_one_connection_state_per_connection_string()
    {
        var (handler, pool, registry) = NewHandlerWithRegistry();
        using (pool)
        {
            var canonical = OpenReceiveConnectionString.Format(NwcUriText, false);
            Assert.Null(registry.Find(canonical));
            var first = (ReceiveOnlyNwcClient)handler.Create(canonical, Network.RegTest, out _)!;
            var second = (ReceiveOnlyNwcClient)handler.Create(canonical, Network.RegTest, out _)!;
            Assert.NotSame(first, second);
            // One NwcConnectionState per connection string: both clients read the same parsed URI (and memo/transport behind it).
            Assert.Same(first.Uri, second.Uri);
            var state = registry.Find(canonical);
            Assert.NotNull(state);
            Assert.Same(state.Uri, first.Uri);
            Assert.IsType<NwcRelayTransport>(state.Transport);

            // The override is part of the key: a different string is a different state.
            var overridden = (ReceiveOnlyNwcClient)handler.Create(OpenReceiveConnectionString.Format(NwcUriText, true), Network.RegTest, out _)!;
            Assert.NotSame(first.Uri, overridden.Uri);
        }
    }

    [Theory]
    [InlineData("type=openreceive;nwc=nostr+walletconnect://nothex?relay=" + Relay + "&secret=" + Secret)]
    [InlineData("type=openreceive;nwc=nostr+walletconnect://" + Pubkey + "?secret=" + Secret)]
    [InlineData("type=openreceive;nwc=https://example.com?relay=" + Relay + "&secret=" + Secret)]
    [InlineData("type=openreceive;nwc=" + NwcUriText + ";what=ever")]
    public void Handler_reports_a_malformed_string_without_the_secret(string connectionString)
    {
        var (handler, pool) = NewHandler();
        using (pool)
        {
            var client = handler.Create(connectionString, Network.RegTest, out var error);
            Assert.Null(client);
            Assert.NotNull(error);
            Assert.NotEmpty(error);
            Assert.DoesNotContain(Secret, error);
        }
    }

    [Fact]
    public void Handler_error_for_a_bad_nwc_value_names_the_reason_and_the_help_url()
    {
        var (handler, pool) = NewHandler();
        using (pool)
        {
            handler.Create("type=openreceive;nwc=nostr+walletconnect://" + Pubkey + "?secret=" + Secret, Network.RegTest, out var error);
            Assert.NotNull(error);
            Assert.Contains("The nwc= value", error);
            Assert.Contains("relay", error);
            Assert.Contains(NwcUri.CodeHelpUrl, error);
            Assert.DoesNotContain(Secret, error);
        }
    }
}
