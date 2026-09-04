using BTCPayServer.Plugins.OpenReceive.Nwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Nwc;

public sealed class NwcUriTests
{
    private const string Pubkey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Secret = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public void RedactionLeavesAUriWithNoQueryUntouched()
    {
        var uri = $"nostr+walletconnect://{Pubkey}";
        Assert.Equal(uri, NwcUri.Redact(uri));
    }

    [Fact]
    public void RedactionCoversEverySecretAndNothingElse()
    {
        var uri = $"nostr+walletconnect://{Pubkey}?secret={Secret}&relay=wss%3A%2F%2Fa.example&SECRET={Secret}#frag";
        var redacted = NwcUri.Redact(uri);
        Assert.Equal($"nostr+walletconnect://{Pubkey}?secret=[REDACTED]&relay=wss%3A%2F%2Fa.example&SECRET=[REDACTED]#frag", redacted);
        Assert.DoesNotContain(Secret, redacted);
    }

    [Fact]
    public void MultipleSecretsAreRejected()
    {
        var uri = $"nostr+walletconnect://{Pubkey}?relay=wss%3A%2F%2Frelay.example.com&secret={Secret}&secret={Secret}";
        var error = Assert.Throws<NwcUriParseException>(() => NwcUri.Parse(uri));
        Assert.Equal("invalid_secret", error.Code);
        AssertNoSecret(error);
    }

    [Fact]
    public void PlainWsRelayIsRejected()
    {
        var uri = $"nostr+walletconnect://{Pubkey}?relay=ws%3A%2F%2Frelay.example.com&secret={Secret}";
        var error = Assert.Throws<NwcUriParseException>(() => NwcUri.Parse(uri));
        Assert.Equal("invalid_relay", error.Code);
        AssertNoSecret(error);
    }

    [Theory]
    [InlineData("", "invalid_uri")]
    [InlineData("https://example.com?relay=wss%3A%2F%2Frelay.example.com&secret=" + Secret, "invalid_scheme")]
    [InlineData("nostr+walletconnect://?relay=wss%3A%2F%2Frelay.example.com&secret=" + Secret, "missing_wallet_pubkey")]
    [InlineData("nostr+walletconnect://notahexkey?relay=wss%3A%2F%2Frelay.example.com&secret=" + Secret, "invalid_wallet_pubkey")]
    [InlineData("nostr+walletconnect://" + Pubkey + "?secret=" + Secret, "missing_relay")]
    [InlineData("nostr+walletconnect://" + Pubkey + "?relay=wss%3A%2F%2Frelay.example.com&secret=short", "invalid_secret")]
    public void EveryErrorCodeIsReachableAndNeverLeaksTheSecret(string uri, string code)
    {
        var error = Assert.Throws<NwcUriParseException>(() => NwcUri.Parse(uri));
        Assert.Equal(code, error.Code);
        AssertNoSecret(error);
    }

    [Fact]
    public void TryParseReportsTheErrorInsteadOfThrowing()
    {
        Assert.False(NwcUri.TryParse("nope", out var parsed, out var error));
        Assert.Null(parsed);
        Assert.Equal("invalid_uri", error!.Code);

        Assert.True(NwcUri.TryParse($"nostr+walletconnect://{Pubkey}?relay=wss%3A%2F%2Frelay.example.com&secret={Secret}", out parsed, out error));
        Assert.Null(error);
        Assert.Equal(Pubkey, parsed!.WalletPubkey);
        Assert.Equal(Secret, parsed.Secret);
        Assert.NotNull(parsed.SecretKey);
        Assert.NotNull(parsed.WalletPubKey);
    }

    [Fact]
    public void SpendRefusalMessageNamesTheBtcPayOverride()
    {
        var message = NwcUri.FormatSpendCapabilityRefusedMessage(new[] { "pay_invoice", "pay_keysend" });
        Assert.Contains("spend method(s): pay_invoice, pay_keysend.", message);
        Assert.Contains(";allow-spend=true", message);
        Assert.Contains(NwcUri.CodeHelpUrl, message);
        Assert.Contains("pay_invoice", NwcUri.FormatSpendCapabilityWarningMessage(null));
    }

    private static void AssertNoSecret(NwcUriParseException error)
    {
        Assert.DoesNotContain(Secret, error.Message);
        Assert.DoesNotContain(Secret, error.Redacted ?? "");
        Assert.DoesNotContain(Secret, error.ToString());
    }
}
